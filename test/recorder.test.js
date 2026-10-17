// Minute recording in live mode and minute history from brokers other than INDstocks: recorded days must read back
// through the replay snapshot like downloaded ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayStore } from '../lib/replay/store.js';
import { MinuteRecorder } from '../lib/replay/recorder.js';
import { MinuteDownloader } from '../lib/replay/minutes.js';
import { getSnapshot } from '../lib/replay/snapshot.js';
import { UpstoxProvider } from '../lib/upstox.js';
import { REPLAY } from '../lib/config.js';

const at = (hhmmss, date = '2026-10-16') => Date.parse(`${date}T${hhmmss}+05:30`);
const sec = (hhmmss, date) => at(hhmmss, date) / 1000;
const plain = (x) => JSON.parse(JSON.stringify(x)); // SQLite rows have a null prototype

function fakeMarket() {
  const m = {
    name: 'Fake broker', open: true, nifty: 24500, vol: new Map(), ltp: new Map(), chainCalls: [],
    marketStatus: async () => ({ open: m.open }),
    indices: async () => ({ indices: [{ symbol: 'NIFTY', last: m.nifty }, { symbol: 'BANKNIFTY', last: 0 }], vix: { last: 12.5 } }),
    expiries: async (s) => (s === 'NIFTY' ? ['2026-10-20', '2026-12-29'] : []),
    chain: async (s, e) => {
      m.chainCalls.push(e);
      const rows = [];
      for (let k = 23000; k <= 26000; k += 50) {
        const side = (t) => ({ ltp: m.ltp.get(`${k}${t}`) ?? 10, vol: m.vol.get(`${k}${t}`) ?? 0, lot: 65 });
        rows.push({ strike: k, ce: side('CE'), pe: side('PE') });
      }
      return { symbol: s, expiry: e, spot: m.nifty, lot: 65, rows };
    },
  };
  return m;
}

test('the recorder saves index bars and traded contracts each minute, and replay reads them back', async () => {
  const store = new ReplayStore(':memory:'), mkt = fakeMarket();
  let now = at('09:20:05');
  const rec = new MinuteRecorder(() => store, mkt, { now: () => now, symbols: ['NIFTY', 'BANKNIFTY'] });
  mkt.vol.set('24500CE', 100); mkt.ltp.set('24500CE', 150); mkt.vol.set('24500PE', 40); mkt.ltp.set('24500PE', 120);
  await rec.tick(); mkt.nifty = 24520; now = at('09:20:20'); await rec.tick();
  mkt.nifty = 24490; now = at('09:20:50'); await rec.tick(); // chain sample for the 09:20 minute
  assert.deepEqual(mkt.chainCalls, ['2026-10-20'], 'only expiries inside the replay window');
  // A minute later: one contract traded again; the other did not change and gets no bar.
  mkt.vol.set('24500CE', 130); mkt.ltp.set('24500CE', 155); mkt.nifty = 24505;
  now = at('09:21:10'); await rec.tick(); now = at('09:21:50'); await rec.tick();

  assert.deepEqual(plain(store.get("SELECT o, h, l, c FROM minute_index WHERE symbol = 'NIFTY' AND ts = ?", sec('09:20:00'))), { o: 24500, h: 24520, l: 24490, c: 24490 });
  assert.ok(store.get("SELECT 1 x FROM minute_index WHERE symbol = 'INDIAVIX'"));
  assert.ok(!store.get("SELECT 1 x FROM minute_index WHERE symbol = 'BANKNIFTY'"), 'no bars from a missing level');
  const bars = plain(store.all('SELECT k.strike, k.type, o.ts, o.c, o.v FROM minute_options o JOIN minute_contracts k ON k.id = o.cid ORDER BY o.ts, k.type'));
  assert.deepEqual(bars, [
    { strike: 24500, type: 'CE', ts: sec('09:20:00'), c: 15000, v: 6500 }, // 100 lots × 65 so far today, in units
    { strike: 24500, type: 'PE', ts: sec('09:20:00'), c: 12000, v: 2600 },
    { strike: 24500, type: 'CE', ts: sec('09:21:00'), c: 15500, v: 1950 }, // 30 more lots
  ]);

  // Once the day has its daily history, replay can walk it minute by minute.
  store.markDay('2026-10-16', 'trading');
  assert.ok(store.minuteReady('2026-10-16'));
  const snap = getSnapshot(store, '2026-10-16', { at: at('09:22:00') });
  const ce = snap.minuteChain('NIFTY', '2026-10-20').find((r) => r.strike === 24500 && r.type === 'CE');
  assert.equal(ce.close, 155); assert.equal(ce.volume, 130);
  store.close();
});

test('the recorder stays quiet outside market hours, when the market is shut, and when switched off', async () => {
  const store = new ReplayStore(':memory:'), mkt = fakeMarket();
  let now = at('15:45:50');
  const rec = new MinuteRecorder(() => store, mkt, { now: () => now });
  mkt.vol.set('24500CE', 10);
  await rec.tick();
  now = at('10:00:50'); mkt.open = false; await rec.tick();
  mkt.open = true; rec.setEnabled(false); await rec.tick();
  assert.equal(store.get('SELECT count(*) n FROM minute_options').n, 0);
  assert.equal(store.get('SELECT count(*) n FROM minute_index').n, 0);
  assert.equal(rec.status().enabled, false);
  store.close();
});

test('Upstox (Plus) is a minute-history source: one contract per call, true epoch bars', async () => {
  const store = new ReplayStore(':memory:');
  for (const d of ['2026-09-29', '2026-09-30']) store.markDay(d, 'trading');
  const keep = REPLAY.intraday.daysBefore.NIFTY; REPLAY.intraday.daysBefore.NIFTY = 1;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url), p = decodeURIComponent(u.pathname); calls.push(p);
    const ok = (data) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
    if (p.startsWith('/v3/historical-candle/NSE_INDEX|Nifty 50/minutes/1/')) return ok({ candles: [['2026-09-30T09:16:00+05:30', 24505, 24505, 24505, 24505, 0, 0], ['2026-09-30T09:15:00+05:30', 24500, 24510, 24490, 24505, 0, 0]] });
    if (p.startsWith('/v3/historical-candle/')) return ok({ candles: [] });
    if (p === '/v2/expired-instruments/expiries') return ok(['2026-09-30', '2026-12-29']);
    if (p === '/v2/expired-instruments/option/contract') return ok([24500, 30000].flatMap((k) => ['CE', 'PE'].map((t) => ({ instrument_key: `NSE_FO|${k}${t}|30-09-2026`, strike_price: k, instrument_type: t }))));
    if (p.startsWith('/v2/expired-instruments/historical-candle/')) return ok({ candles: [['2026-09-30T09:15:00+05:30', 100, 101, 99, 100.5, 650, 0]] });
    return new Response('{}', { status: 404 });
  };
  const up = new UpstoxProvider({}, { load: () => 't'.repeat(30), save() {}, clear() {} });
  Object.defineProperty(up, 'historyAt', { get: () => -1e15, set() {} }); // no one-second pacing in tests
  const h = up.minuteHistory(); h.optionsFrom = '2026-09-01'; up.minuteHistory = () => h;
  const dl = new MinuteDownloader(store, () => up);
  assert.equal(dl.source().name, 'Upstox');
  dl.start('2026-09-29', '2026-09-30', ['NIFTY']);
  while (dl.job.running) await new Promise((r) => setTimeout(r, 10));
  REPLAY.intraday.daysBefore.NIFTY = keep;
  assert.equal(dl.job.error, null, dl.job.error);
  assert.deepEqual(plain(store.all("SELECT ts, o, c FROM minute_index WHERE symbol = 'NIFTY' ORDER BY ts")), [{ ts: sec('09:15:00', '2026-09-30'), o: 24500, c: 24505 }, { ts: sec('09:16:00', '2026-09-30'), o: 24505, c: 24505 }]);
  assert.deepEqual(store.all('SELECT strike, type FROM minute_contracts ORDER BY type').map((r) => `${r.strike}${r.type}`), ['24500CE', '24500PE'], 'the far 30,000 strike is skipped');
  assert.equal(calls.filter((c) => c.startsWith('/v2/expired-instruments/historical-candle/')).length, 2, 'one call per contract');
  assert.ok(store.minuteReady('2026-09-30'));
  store.close();
});

test('a broker without the Plus plan stops the download with a plain reason, and leaves live data alone', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'error', errors: [{ errorCode: 'UDAPI1149', message: 'This API is available exclusively with an Upstox Plus plan subscription' }] }), { status: 403 });
  const up = new UpstoxProvider({}, { load: () => 't'.repeat(30), save() {}, clear() {} });
  Object.defineProperty(up, 'historyAt', { get: () => -1e15, set() {} });
  await assert.rejects(up.minuteHistory().expiries('NIFTY', '2026-01-01', '2026-10-01'), (e) => e.auth && /Upstox Plus/.test(e.message));
  assert.equal(up.problem, null, 'the token is still good for live prices');
});
