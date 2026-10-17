// Paper account "Explain P&L" breakdown and the strategy builder's IV what-if shift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperAccount } from '../lib/paper.js';
import { pnlAt } from '../public/js/payoff.js';
import { bs, setClock } from '../public/js/bs.js';

const EXPIRY = '2026-11-26';
const at = (iso) => Date.parse(iso + '+05:30');

// A one-expiry NIFTY market whose quotes, spot and clock the test moves by hand.
function market() {
  const m = { now: at('2026-11-02T10:00:00'), spot: 25000, quotes: {}, close: null };
  m.set = (strike, type, price, iv, spread = 0) => { m.quotes[`${strike}${type}`] = { bid: price - spread, ask: price + spread, ltp: price, iv, lot: 65, id: `NFO_${strike}${type}` }; };
  m.provider = {
    chain: async () => ({ spot: m.spot, lot: 65, rows: Object.entries(m.quotes).map(([k, q]) => ({ strike: Number(k.slice(0, -2)), [k.slice(-2) === 'CE' ? 'ce' : 'pe']: q })) }),
    indices: async () => ({ indices: [{ symbol: 'NIFTY', last: m.spot }] }),
    daily: async () => [{ date: EXPIRY, c: m.close }],
    marketStatus: async () => ({ open: false }),
  };
  m.account = new PaperAccount(null, m.provider, { now: () => m.now });
  m.leg = (side, lots, strike = 25000, type = 'CE') => ({ symbol: 'NIFTY', expiry: EXPIRY, strike, type, side, lots });
  m.orders = () => m.account.state.orders;
  return m;
}

const parts = (x) => x.spot + x.time + x.volatility + x.residual;
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('explain P&L: price, time and IV effects plus the remainder add up to the gross P&L of a long call', async () => {
  const m = market();
  m.set(25000, 'CE', 300, 15, 1);
  await m.account.place([m.leg('BUY', 2)]);
  m.now = at('2026-11-09T10:00:00'); m.spot = 25300; m.set(25000, 'CE', 480, 17, 1);
  await m.account.place([m.leg('SELL', 2)]);
  const [open, close] = m.orders(); const x = close.explanation;
  assert.ok(x, 'a closing order carries an explanation');
  near(x.gross, close.realized, 0.01);
  near(parts(x), x.gross);
  assert.ok(x.spot > 0, 'the index rose, which helps a long call');
  assert.ok(x.time < 0, 'a week of time decay hurts a long call');
  assert.ok(x.volatility > 0, 'IV rose from 15 to 17, which helps a long call');
  near(x.entryCharges, open.charges, 0.01);
  near(x.exitCharges, close.charges, 0.01);
  near(x.netAfterCharges, x.gross - x.entryCharges - x.exitCharges, 0.01);
});

test('explain P&L: a short position sees the same moves with the opposite sign', async () => {
  const m = market();
  m.set(25000, 'CE', 300, 15);
  await m.account.place([m.leg('SELL', 1)]);
  m.now = at('2026-11-09T10:00:00'); m.spot = 25300; m.set(25000, 'CE', 480, 17);
  await m.account.place([m.leg('BUY', 1)]);
  const x = m.orders()[1].explanation;
  assert.ok(x.spot < 0 && x.time > 0 && x.volatility < 0);
  near(parts(x), x.gross);
});

test('explain P&L: entry charges are split by units across partial closes', async () => {
  const m = market();
  m.set(25000, 'CE', 300, 15);
  await m.account.place([m.leg('BUY', 2)]);
  m.now += 3600e3; await m.account.place([m.leg('SELL', 1)]);
  m.now += 3600e3; await m.account.place([m.leg('SELL', 1)]);
  const [open, first, second] = m.orders();
  near(first.explanation.entryCharges, open.charges / 2, 0.01);
  near(first.explanation.entryCharges + second.explanation.entryCharges, open.charges, 0.02);
});

test('explain P&L: when one order closes a long and opens a short, only the closing part of its charges counts as exit charges', async () => {
  const m = market();
  m.set(25000, 'CE', 300, 15);
  await m.account.place([m.leg('BUY', 1)]);
  m.now += 3600e3; m.set(25000, 'CE', 320, 15);
  await m.account.place([m.leg('SELL', 2)]);
  const flip = m.orders()[1];
  near(flip.explanation.exitCharges, flip.charges / 2, 0.01);
  const short = m.account.state.positions[0];
  assert.equal(short.qty, -65);
  near(short.learnEntry.charges, flip.charges / 2, 0.01);
});

test('explain P&L: no breakdown without an entry IV', async () => {
  const m = market();
  m.set(25000, 'CE', 300, 0);
  await m.account.place([m.leg('BUY', 1)]);
  m.set(25000, 'CE', 310, 15);
  await m.account.place([m.leg('SELL', 1)]);
  assert.equal(m.orders()[1].explanation, undefined);
});

test('explain P&L: at expiry settlement the IV effect is zero and the parts still add up', async () => {
  const m = market();
  m.set(25000, 'CE', 300, 15);
  await m.account.place([m.leg('BUY', 1)]);
  m.now = at('2026-11-27T10:00:00'); m.close = 25400; m.spot = 25400;
  await m.account.settle();
  const s = m.orders()[1];
  assert.match(s.tag, /Expiry settlement/);
  const x = s.explanation;
  assert.equal(x.volatility, 0);
  near(x.gross, (400 - 300) * 65, 0.01);
  near(parts(x), x.gross);
});

test('IV shift: higher IV lifts a long call before expiry, IV never drops below 1%, and the expiry payoff ignores it', () => {
  const t = at('2026-11-02T10:00:00'); setClock(() => t);
  try {
    const legs = [{ type: 'CE', strike: 25000, expiry: EXPIRY, qty: 65, entry: 300, iv: 0.15 }];
    const base = pnlAt(legs, 25000), up = pnlAt(legs, 25000, { ivShiftPct: 5 }), down = pnlAt(legs, 25000, { ivShiftPct: -5 });
    assert.ok(up > base && base > down);
    const T = (at(EXPIRY + 'T15:30:00') - t) / (365 * 864e5);
    near(pnlAt(legs, 25000, { ivShiftPct: -50 }), 65 * (bs('CE', 25000, 25000, T, 0.06, 0.01).price - 300), 0.01);
    assert.equal(pnlAt(legs, 25500, { atExpiry: true, ivShiftPct: 10 }), pnlAt(legs, 25500, { atExpiry: true }));
  } finally { setClock(() => Date.now()); }
});
