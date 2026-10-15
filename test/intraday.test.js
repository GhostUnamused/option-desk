// Minute-by-minute replay: the as-of gate at a minute, the replay clock stepping through a day, fills at the minute's
// price, settlement at the close, blind mode, and the minute downloader against a fake INDstocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSnapshot, AsOfViolation, closeTime } from '../lib/replay/snapshot.js';
import { ReplayEngine } from '../lib/replay/engine.js';
import { ReplayStore } from '../lib/replay/store.js';
import { MinuteDownloader, pickStrikes } from '../lib/replay/minutes.js';
import { disguise } from '../lib/replay/blind.js';
import { REPLAY } from '../lib/config.js';
import { tempDir, seedStore, seedMinutes, spotOn, minuteSpot, minuteOption, barTs, datesIn, DAYS } from './helpers.js';
import path from 'node:path';

const dir = tempDir();
const store = seedMinutes(seedStore(dir));
test.after(() => store.close());
const at = (date, hh, mm) => barTs(date, hh, mm) * 1000;
const D = '2024-07-03';

test('a minute snapshot sees only bars that finished before its minute, and none of the day\'s closing data', () => {
  for (const [hh, mm] of [[9, 16], [10, 0], [12, 30], [15, 29]]) {
    const s = getSnapshot(store, D, { at: at(D, hh, mm) });
    assert.equal(s.live, true);
    const bars = s.indexMinutes('NIFTY');
    const seen = (hh * 60 + mm) - (9 * 60 + 15); // bars 09:15 .. one minute before the clock
    assert.equal(bars.length, seen);
    assert.ok(bars.every((b) => b.ts + 60 <= at(D, hh, mm) / 1000));
    // The index level is the last finished bar, not the day's close.
    assert.equal(s.quote('NIFTY').close, minuteSpot(D, seen - 1));
    assert.equal(s.quote('NIFTY').prevClose, spotOn('2024-07-02'));
    const hist = s.indexHistory('NIFTY', 3650);
    assert.equal(hist.at(-1).date, D);
    assert.equal(hist.at(-1).close, minuteSpot(D, seen - 1));
    assert.equal(hist.at(-2).close, spotOn('2024-07-02'));
    // Option history stops at the previous day: today's point needs today's close.
    assert.ok(s.optionHistory('NIFTY', 3650).every((r) => r.date < D));
    // The chain is each contract's last trade before the minute, with yesterday's open interest.
    const exps = s.expiries('NIFTY');
    assert.deepEqual(exps, ['2024-07-04', '2024-07-11']);
    for (const e of exps) {
      for (const r of s.chain('NIFTY', e)) {
        assert.equal(r.at, barTs(D, 9, 15) + 60 * (seen - 1));
        assert.equal(r.price, minuteOption(D, seen - 1, e, r.strike, r.type));
        assert.equal(r.oi, 50000);
        assert.equal(r.volume, (seen - (r.strike === 24300 && r.type === 'CE' ? 165 : 0)) * 10);
      }
      const hist = s.contractHistory('NIFTY', e, 24000, 'CE', 3650);
      assert.equal(hist.at(-1).date, D);
      assert.equal(hist.at(-1).price, s.contract('NIFTY', e, 24000, 'CE').price);
    }
  }
});

test('the day\'s volume counts only the minutes so far, and a strike appears once it has traded', () => {
  const early = getSnapshot(store, D, { at: at(D, 11, 0) });
  assert.equal(early.contract('NIFTY', '2024-07-11', 24300, 'CE'), null);
  assert.equal(early.contract('NIFTY', '2024-07-11', 24000, 'CE').volume, 105 * 10);
  const later = getSnapshot(store, D, { at: at(D, 12, 30) });
  const c = later.contract('NIFTY', '2024-07-11', 24300, 'CE');
  assert.equal(c.volume, (195 - 165) * 10);
  assert.ok(c.iv > 0.13 && c.iv < 0.17, `IV ${c.iv} backs out near 15%`);
});

test('the gate refuses today\'s daily rows and later bars while the day runs', () => {
  const s = getSnapshot(store, D, { at: at(D, 10, 0) });
  assert.throws(() => s.rows('SELECT date, close FROM indices WHERE symbol = ? AND date <= ?', 'NIFTY', D), AsOfViolation);
  assert.throws(() => s.rows('SELECT date, close FROM options WHERE date = ?', D), AsOfViolation);
  assert.throws(() => s.rows('SELECT ts, c FROM minute_index WHERE symbol = ? AND ts <= ?', 'NIFTY', barTs(D, 10, 0)), AsOfViolation);
  assert.throws(() => s.rows('SELECT ts, c FROM minute_index WHERE symbol = ?', 'NIFTY'), AsOfViolation);
  assert.throws(() => getSnapshot(store, D, { at: at('2024-07-04', 10, 0) }));
  // At the close the day is complete: closing prices, as in day-by-day replay.
  const close = getSnapshot(store, D, { at: closeTime(D) });
  assert.equal(close.live, false);
  assert.equal(close.quote('NIFTY').close, spotOn(D));
  assert.equal(close.indexMinutes('NIFTY').length, 375); // every bar, 09:15 to 15:29
});

function engine() { const d = tempDir(); seedMinutes(seedStore(d)).close(); return new ReplayEngine(d, { accountFile: null }); }
const leg = (o) => ({ symbol: 'NIFTY', expiry: '2024-07-11', strike: 24000, type: 'CE', side: 'BUY', lots: 1, ...o });

test('a minute session opens at 09:16, steps by minutes, closes at 15:30 and opens the next day', async () => {
  const e = engine();
  const st = await e.start({ date: '2024-07-02', intraday: true });
  assert.equal(st.time, '09:16'); assert.equal(st.running, true);
  assert.equal((await e.step({ by: 'minutes', n: 5 })).state.time, '09:21');
  assert.equal((await e.step({ by: 'minutes', n: 15 })).state.time, '09:36');
  assert.equal((await e.provider.intraday('NIFTY')).points.length, 21);
  assert.equal((await e.provider.marketStatus()).time, '09:36');
  const r = await e.step({ by: 'minutes', n: 400 });
  assert.equal(r.state.running, false); assert.equal(r.state.time, '15:30');
  await assert.rejects(e.step({ by: 'minutes' }), /closed/);
  const next = await e.step({ by: 'day' });
  assert.equal(next.to, '2024-07-03'); assert.equal(next.state.time, '09:16');
  // A day without minute prices shows at its close.
  await e.step({ by: 'day' }); await e.step({ by: 'day' });
  assert.equal(e.session.asOf, '2024-07-05'); assert.equal(e.publicState().running, false);
  // One equity point per day, however many minutes were stepped.
  const j = e.account.journal();
  assert.deepEqual(j.days.map((d) => d.date), ['2024-07-02', '2024-07-03', '2024-07-04', '2024-07-05']);
  await assert.rejects(new ReplayEngine(tempDir(), { accountFile: null }).start({ date: '2024-07-02', intraday: true }), /history/);
});

test('starting minute by minute needs minute prices on the start day', async () => {
  const e = engine();
  await assert.rejects(e.start({ date: '2024-07-08', intraday: true }), /no minute prices/);
  const s = await e.start({ random: true, intraday: true });
  assert.ok(['2024-07-02', '2024-07-03', '2024-07-04'].includes(s.date));
});

test('fills are around the minute\'s price, and the trade is stamped with the replay minute', async () => {
  const e = engine();
  await e.start({ date: D, intraday: true });
  await e.step({ by: 'minutes', n: 44 }); // 10:00
  const price = minuteOption(D, 44, '2024-07-11', 24000, 'CE');
  const buy = await e.account.preview([leg()]);
  const sell = await e.account.preview([leg({ side: 'SELL' })]);
  assert.ok(buy.fills[0].price > price && sell.fills[0].price < price, `${buy.fills[0].price} / ${sell.fills[0].price} around ${price}`);
  await assert.rejects(e.account.place([leg({ strike: 24300 })]), /traded yet today|No quote/);
  const r = await e.account.place([leg()], '', 'Morning dip');
  assert.equal(e.account.state.orders.at(-1).t, at(D, 10, 0));
  const pos = (await e.account.summary()).positions[0];
  assert.equal(pos.mark, price);
  // Fifteen minutes on, the position is marked at the newer trade.
  await e.step({ by: 'minutes', n: 15 });
  assert.equal((await e.account.summary()).positions[0].mark, minuteOption(D, 59, '2024-07-11', 24000, 'CE'));
  assert.ok(r.fills.length === 1);
});

test('on expiry day the expiring contracts trade until 15:30 and settle at the official close', async () => {
  const e = engine();
  await e.start({ date: '2024-07-04', intraday: true, balance: 300000 });
  assert.deepEqual(await e.provider.expiries('NIFTY'), ['2024-07-04', '2024-07-11']);
  await e.step({ by: 'minutes', n: 44 });
  await e.account.place([leg({ expiry: '2024-07-04', strike: 24000 })]);
  const r = await e.step({ by: 'close' });
  assert.equal(r.settled, 1);
  const s = e.account.state.orders.find((o) => o.id.startsWith('S'));
  assert.equal(s.price, spotOn('2024-07-04') - 24000);
});

test('"Next expiry" from the middle of expiry day goes to that day\'s close', async () => {
  const e = engine();
  await e.start({ date: '2024-07-04', intraday: true });
  const r = await e.step({ by: 'expiry', symbol: 'NIFTY' });
  assert.equal(r.to, '2024-07-04'); assert.equal(r.state.running, false);
  const r2 = await e.step({ by: 'expiry', symbol: 'NIFTY' });
  assert.equal(r2.to, '2024-07-11');
});

test('blind minute sessions leak no real dates', async () => {
  const e = engine();
  await e.start({ date: D, intraday: true, blind: true });
  await e.step({ by: 'minutes', n: 30 });
  await e.account.place([leg()], '', 'test');
  const off = e.blindDays();
  const out = disguise({ state: e.publicState(), journal: e.account.journal(), chain: await e.provider.chain('NIFTY', '2024-07-11'), day: await e.provider.intraday('NIFTY'), opt: await e.provider.optionIntraday((await e.provider.chain('NIFTY', '2024-07-11')).rows[2].ce.id) }, off);
  const shown = JSON.stringify(out);
  assert.ok(!shown.includes('2024'), 'no real year anywhere');
  assert.ok(datesIn(out).every((d) => d > '2100'));
  // Chart times move by whole days, so the time of day stays true.
  const t = out.day.points.at(-1).t;
  assert.equal(new Date(t * 1000).toISOString().slice(11, 16), '09:45');
});

test('the minute downloader stores index and option bars and marks the days ready', async () => {
  const d = tempDir();
  const st = seedStore(d, { days: DAYS.slice(0, 5) });
  const keep = REPLAY.intraday.optionsFrom; REPLAY.intraday.optionsFrom = '2024-01-01';
  const calls = [];
  const ms = (date) => Date.parse(date + 'T00:00:00+05:30');
  const fake = {
    usable: () => true,
    indexCode: async (s) => `NIDX_${s}`,
    raw: async (p) => {
      calls.push(p);
      const u = new URL('http://x' + p), q = (k) => u.searchParams.get(k);
      if (u.pathname === '/market/historical/1minute') {
        const code = q('scrip-codes'), out = [];
        for (const date of DAYS.slice(0, 5)) for (let i = 0; i < 375; i++) { const ts = ms(date) / 1000 + 555 * 60 + i * 60; if (ts * 1000 >= +q('start_time') && ts * 1000 < +q('end_time')) out.push({ ts, o: 24000, h: 24100, l: 23900, c: 24000 + i }); }
        return { data: { [code]: { candles: out } } };
      }
      if (u.pathname === '/market/instruments/expired/expiries') return { data: ['2024-07-04'] };
      if (u.pathname === '/market/instruments/expired/contracts') return { data: [22000, 23900, 23950, 24000, 24050, 26000].flatMap((k) => ['CE', 'PE'].map((t) => ({ trading_symbol: `N${k}${t}`, strike_price: k, option_type: t, lot_size: 25 }))) };
      if (u.pathname === '/market/historical/expired/1minute') {
        const syms = q('trading-symbols').split(','), data = {};
        for (const s of syms) data[s] = { candles: [{ ts: ms('2024-07-03') / 1000 + 600 * 60, c: 100, v: 2500 }] };
        return { data };
      }
      throw new Error('unexpected ' + p);
    },
  };
  const dl = new MinuteDownloader(st, () => fake);
  dl.start('2024-07-01', '2024-07-05');
  while (dl.job.running) await new Promise((r) => setTimeout(r, 10));
  REPLAY.intraday.optionsFrom = keep;
  assert.equal(dl.job.error, null, dl.job.error);
  assert.equal(st.get("SELECT count(*) n FROM minute_index WHERE symbol = 'NIFTY'").n, 5 * 375);
  // The far strikes (22,000 and 26,000) are left out; the rest are stored.
  assert.deepEqual(st.all("SELECT DISTINCT strike FROM minute_contracts ORDER BY strike").map((r) => r.strike), [23900, 23950, 24000, 24050]);
  assert.ok(st.minuteReady('2024-07-03'));
  assert.ok(!st.minuteReady('2024-07-02')); // index bars but no option trades that day
  assert.equal(st.minuteCoverage().days, 1);
  // A second run skips what is already stored.
  const before = calls.length;
  dl.start('2024-07-01', '2024-07-05');
  while (dl.job.running) await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.filter((c, i) => i >= before && c.includes('expired/1minute')).length === 0);
  st.close();
});

test('strikes are picked around the range with the near-the-money spacing', () => {
  const k = [22000, 23000, 23900, 23950, 24000, 24050, 24100, 25000];
  assert.deepEqual([...pickStrikes(k, 24000, 24010, 2)].sort(), [23900, 23950, 24000, 24050, 24100]);
});
