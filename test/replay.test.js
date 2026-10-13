// Replay sessions: stepping the clock, fills with slippage, zero-volume rejection, expiry settlement, journal, blind mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayEngine } from '../lib/replay/engine.js';
import { halfSpread, quoteSides } from '../lib/replay/fills.js';
import { disguise, shiftText, pickOffset } from '../lib/replay/blind.js';
import { tempDir, seedStore, spotOn } from './helpers.js';

function engine() { const d = tempDir(); seedStore(d).close(); return new ReplayEngine(d, { accountFile: null }); }
const leg = (o) => ({ symbol: 'NIFTY', expiry: '2024-07-04', strike: 24000, type: 'CE', side: 'BUY', lots: 1, ...o });

test('steps move along the trading calendar, skipping the weekend', async () => {
  const e = engine();
  await e.start({ date: '2024-07-04' });
  assert.equal((await e.step({ by: 'day' })).to, '2024-07-05');
  assert.equal((await e.step({ by: 'day' })).to, '2024-07-08');
  assert.equal((await e.step({ by: 'week' })).to, '2024-07-12'); // a week on is past the data, so it stops at the last day
  await assert.rejects(e.step({ by: 'day' }), /last downloaded day/);
});

test('a session started on a non-trading day starts on the next trading day', async () => {
  const e = engine();
  const s = await e.start({ date: '2024-07-06' });
  assert.equal(s.date, '2024-07-08');
});

test('next expiry jumps to expiry day and settles open positions at intrinsic value', async () => {
  const e = engine();
  await e.start({ date: '2024-07-01', balance: 300000 });
  const before = e.account.state.cash;
  const r = await e.account.place([leg({ strike: 24000, type: 'CE' }), leg({ strike: 24200, type: 'PE' })], '', 'Expect a rise');
  assert.equal(r.fills.length, 2);
  const step = await e.step({ by: 'expiry', symbol: 'NIFTY' });
  assert.equal(step.to, '2024-07-04');
  assert.equal(step.days, 3);
  assert.equal(step.settled, 2);
  const s = await e.account.summary();
  assert.equal(s.positions.length, 0);
  const close = spotOn('2024-07-04'); // 24,300
  const settle = e.account.state.orders.filter((o) => o.id.startsWith('S'));
  assert.equal(settle.find((o) => o.type === 'CE').price, close - 24000);
  assert.equal(settle.find((o) => o.type === 'PE').price, 0);
  // Cash = start − premiums − charges + call intrinsic × 25 − settlement charges (only the in-the-money call has any).
  const paid = r.fills.reduce((x, f) => x + f.premium + f.charges, 0);
  const ce = settle.find((o) => o.type === 'CE'), pe = settle.find((o) => o.type === 'PE');
  assert.equal(pe.charges, 0);
  // ₹20 brokerage + 18% GST + 0.125% exercise STT on 300 × 25 (July 2024 rates).
  assert.equal(ce.charges, Math.round((20 + 3.6 + 300 * 25 * 0.00125) * 100) / 100);
  assert.ok(Math.abs(e.account.state.cash - (before - paid + 300 * 25 - ce.charges)) < 0.02);
});

test('fills are the close plus or minus slippage, and zero-volume strikes are refused', async () => {
  const e = engine();
  await e.start({ date: '2024-07-02' });
  const row = e.snapshot().contract('NIFTY', '2024-07-11', 24100, 'CE');
  const buy = await e.account.preview([leg({ expiry: '2024-07-11', strike: 24100 })]);
  const sell = await e.account.preview([leg({ expiry: '2024-07-11', strike: 24100, side: 'SELL' })]);
  assert.ok(buy.fills[0].price > row.price && sell.fills[0].price < row.price);
  assert.equal(buy.fills[0].lot, 25);
  await assert.rejects(e.account.place([leg({ expiry: '2024-07-11', strike: 24500, type: 'CE' })]), /traded/);
  await assert.rejects(e.account.place([leg({ expiry: '2024-07-02' })]), /settled/);
});

test('journal: one row per day, notes kept, summary on end; nothing trades after the end', async () => {
  const e = engine();
  await e.start({ date: '2024-07-01' });
  await e.account.place([leg({ expiry: '2024-07-11', strike: 24000 })], '', 'Uptrend, buying a call');
  await e.step({ by: 'day' }); await e.step({ by: 'day' });
  await e.account.exit(e.account.state.positions[0].key);
  const j = await e.end();
  assert.deepEqual(j.days.map((d) => d.date), ['2024-07-01', '2024-07-02', '2024-07-03']);
  assert.equal(j.trades[0].note, 'Uptrend, buying a call');
  assert.equal(j.stats.closedTrades, 1);
  assert.equal(j.stats.wins, 1); // the index rose 200 points
  assert.ok(j.stats.totalPnl > 0);
  assert.equal(e.active(), false);
  await assert.rejects(e.step({ by: 'day' }), /ended/);
});

test('slippage widens away from the money and with low volume, on the tick grid', () => {
  const base = { price: 100, spot: 24000, strike: 24000, volume: 10000 };
  assert.ok(halfSpread({ ...base, strike: 25200 }) > halfSpread(base));
  assert.ok(halfSpread({ ...base, volume: 5 }) > halfSpread(base));
  const q = quoteSides({ price: 0.05, strike: 26000, volume: 1 }, 24000);
  assert.equal(q.bid, 0.05); assert.ok(q.ask > q.bid);
  const q2 = quoteSides({ price: 97.9, strike: 24200, volume: 2814500 }, 24141.95);
  for (const v of [q2.bid, q2.ask]) assert.ok(Math.abs(v * 20 - Math.round(v * 20)) < 1e-6, `${v} is on the 0.05 grid`);
});

test('blind mode shifts every date by whole weeks and undoes it exactly', async () => {
  const off = pickOffset('2024-07-03', () => 0.5);
  assert.equal(off % 7, 0);
  const shifted = shiftText('2024-07-04', off);
  assert.equal(new Date(shifted).getUTCDay(), new Date('2024-07-04').getUTCDay());
  assert.ok(shifted > '2100');
  const v = { expiry: '2024-07-04', id: 'OPTIDXNIFTY04-07-2024CE24000.00', key: 'NIFTY|2024-07-04|24000|CE', t: Date.parse('2024-07-04T10:00:00Z'), points: [{ t: 1720000000, v: 1 }], note: 'no date', strike: 24000 };
  const d = disguise(v, off);
  assert.ok(!JSON.stringify(d).includes('2024'));
  assert.ok(d.id.endsWith('CE24000.00') && d.id.startsWith('OPTIDXNIFTY'));
  assert.deepEqual(disguise(d, -off), v);
  // A blind session reports disguised dates through the engine's offset.
  const e = engine();
  await e.start({ date: '2024-07-02', blind: true });
  assert.ok(e.blindDays() !== 0 && e.blindDays() % 7 === 0);
  await e.end();
  assert.equal(e.blindDays(), 0); // dates are real again once the session ends
});

test('charges follow the rates in force on the trade date', async () => {
  const { legCharges } = await import('../lib/paper.js');
  // Sell ₹1,00,000 of premium. Oct 2024: STT 0.1%, NSE 0.03503%. Apr 2026: STT 0.15%, NSE 0.03553%.
  const a = legCharges('SELL', 100000, '2024-10-15'), b = legCharges('SELL', 100000, '2026-05-04'), old = legCharges('SELL', 100000, '2023-01-10');
  assert.equal(a.parts.stt, 100); assert.equal(b.parts.stt, 150); assert.equal(old.parts.stt, 50);
  assert.equal(a.parts.exchange, 35.03); assert.equal(b.parts.exchange, 35.53);
  assert.equal(a.parts.brokerage, 20); assert.equal(a.parts.stamp, 0);
  assert.equal(a.parts.gst, Math.round((20 + 35.03 + 0.1) * 0.18 * 100) / 100);
  assert.equal(legCharges('BUY', 100000, '2024-10-15').parts.stamp, 3);
  assert.equal(a.total, Math.round(Object.values(a.parts).reduce((s, v) => s + v, 0) * 100) / 100);
});
