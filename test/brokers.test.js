// Broker selection and the other providers' candles against fake APIs: chart times on the app's conventions
// (intraday on the IST wall clock, daily at midnight UTC), ascending order, and contract ids that are not theirs going to NSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wallClock, tidy, lastSession } from '../lib/bars.js';
import { BrokerManager } from '../lib/brokers.js';
import { FyersProvider } from '../lib/fyers.js';
import { UpstoxProvider } from '../lib/upstox.js';
import { AngelOneProvider } from '../lib/angelone.js';

const secret = (value) => ({ load: () => value, save() {}, clear() {} });
const nse = { optionIntraday: async (id) => ({ from: 'nse', id }), indices: async () => ({ indices: [{ symbol: 'NIFTY', last: 24500 }] }) };
function fakeApi(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url); calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
    const [status, body] = handler(u, opts);
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}
const at = (iso) => Date.parse(iso) / 1000; // a wall-clock time written as UTC = the app's t

test('broker times become IST wall-clock seconds whatever the format', () => {
  assert.equal(wallClock('2026-10-16T09:15:00+05:30'), at('2026-10-16T09:15:00Z'));
  assert.equal(wallClock('2026-10-16T09:15:00+0530'), at('2026-10-16T09:15:00Z'));
  assert.equal(wallClock('2026-10-16 09:15:00'), at('2026-10-16T09:15:00Z'));
  assert.equal(wallClock('2026-10-16'), at('2026-10-16T00:00:00Z'));
  const rows = tidy([{ t: 300 + 86400 }, { t: 60 }, { t: 60 }, { t: NaN }, { t: 120 + 86400 }]);
  assert.deepEqual(rows.map((r) => r.t), [60, 86520, 86700]);
  assert.deepEqual(lastSession(rows).map((r) => r.t), [86520, 86700]);
});

test('the manager keeps one selected broker, remembers it, and delegates to it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-brokers-'));
  const file = path.join(dir, 'broker-settings.json');
  const a = { name: 'A', usable: () => true, status: () => ({ connected: true }), chain: async () => 'from A' };
  const b = { name: 'B', usable: () => false, status: () => ({ connected: false }), capabilities: { stockOptions: false }, chain: async () => 'from B', setToken: async (t) => { b.got = t; } };
  const m = new BrokerManager({ indstocks: a, upstox: b }, file);
  assert.equal(m.selected, 'indstocks'); assert.equal(await m.chain('NIFTY'), 'from A');
  await m.connect('upstox', { token: 'abc' });
  assert.equal(b.got, 'abc'); assert.equal(await m.chain('NIFTY'), 'from B');
  assert.equal(new BrokerManager({ indstocks: a, upstox: b }, file).selected, 'upstox');
  assert.deepEqual(m.status().providers.map((p) => [p.id, p.selected]), [['indstocks', false], ['upstox', true]]);
  assert.throws(() => m.select('nope'), /supported broker/);
  assert.throws(() => m.stockList(), /does not provide/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FYERS asks the /data routes, includes today, and stamps daily bars at midnight', async () => {
  const day = at('2026-10-15T18:30:00Z'); // FYERS daily bars are IST midnight in true epoch seconds
  const calls = fakeApi((u) => u.pathname === '/data/history'
    ? [200, { s: 'ok', candles: u.searchParams.get('resolution') === '1D' ? [[day + 86400, 2, 3, 1, 2, 0], [day, 1, 2, 1, 2, 0]] : [[day - 3600, 1, 1, 1, 1, 5], [day + 86400 + 9 * 3600 + 15 * 60, 2, 2, 2, 2, 5]] }]
    : [200, { s: 'ok', d: [] }]);
  const p = new FyersProvider(nse, secret(JSON.stringify({ clientId: 'XY12345-100', accessToken: 'tok' })));
  const life = await p.optionCandles('NSE:NIFTY26O2024500CE', 'life');
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api-t1.fyers.in/data/history');
  assert.deepEqual(life.candles.map((c) => c.t), [at('2026-10-16T00:00:00Z'), at('2026-10-17T00:00:00Z')]);
  const to = Number(calls[0].url.searchParams.get('range_to'));
  assert.equal((to + 1 + 19800) % 86400, 0); // the end of an IST day, not its start
  const oneDay = await p.optionCandles('NSE:NIFTY26O2024500CE', '1D');
  assert.deepEqual(oneDay.candles.map((c) => c.t), [at('2026-10-17T09:15:00Z')]); // only the latest session
  assert.deepEqual(await p.optionIntraday('OPTIDXNIFTY20-10-2026CE24500.00'), { from: 'nse', id: 'OPTIDXNIFTY20-10-2026CE24500.00' });
});

test('Upstox candles come newest first and are put in order; NSE contract ids go to NSE', async () => {
  fakeApi((u) => [200, { status: 'success', data: { candles: u.pathname.includes('/days/')
    ? [['2026-10-16T00:00:00+05:30', 2, 3, 1, 2, 9], ['2026-10-15T00:00:00+05:30', 1, 2, 1, 1, 9]]
    : [['2026-10-16T09:16:00+05:30', 2, 2, 2, 2, 1], ['2026-10-16T09:15:00+05:30', 1, 1, 1, 1, 1]] } }]);
  const p = new UpstoxProvider(nse, secret('t'.repeat(30)));
  const life = await p.optionCandles('NSE_FO|45110', 'life');
  assert.deepEqual(life.candles.map((c) => c.t), [at('2026-10-15T00:00:00Z'), at('2026-10-16T00:00:00Z')]);
  const today = await p.optionCandles('NSE_FO|45110', '1D');
  assert.deepEqual(today.candles.map((c) => c.t), [at('2026-10-16T09:15:00Z'), at('2026-10-16T09:16:00Z')]);
  assert.equal((await p.optionIntraday('OPTIDXNIFTY20-10-2026CE24500.00')).from, 'nse');
});

test('Angel One centres the chain on the index found by its scrip-master symbol, with bid/ask from the depth', async () => {
  const master = [
    { token: '99926000', symbol: 'Nifty 50', name: 'NIFTY', expiry: '', strike: '-1', instrumenttype: 'AMXIDX', exch_seg: 'NSE' },
    ...[10000, 24400, 24500, 24600].flatMap((k, i) => ['CE', 'PE'].map((t, j) => ({ token: String(1000 + i * 2 + j), symbol: `NIFTY20OCT26${k}${t}`, name: 'NIFTY', expiry: '20OCT2026', strike: String(k * 100), lotsize: '65', instrumenttype: 'OPTIDX', exch_seg: 'NFO' }))),
  ];
  fakeApi((u, opts) => {
    if (u.hostname.startsWith('margincalculator')) return [200, master];
    if (u.pathname.endsWith('/quote')) {
      const body = JSON.parse(opts.body), toks = body.exchangeTokens.NSE || body.exchangeTokens.NFO;
      return [200, { status: true, data: { fetched: toks.map((t) => ({ symbolToken: t, ltp: t === '99926000' ? 24510 : 100, close: 90, opnInterest: 6500, tradeVolume: 650, depth: { buy: [{ price: 99.5, quantity: 65 }], sell: [{ price: 100.5, quantity: 130 }] } })) } }];
    }
    return [200, { status: true, data: [] }];
  });
  const p = new AngelOneProvider(nse, secret(JSON.stringify({ apiKey: 'k', jwtToken: 'j' })));
  const c = await p.chain('NIFTY', '2026-10-20');
  assert.equal(c.spot, 24510);
  const ce = c.rows.find((r) => r.strike === 24500).ce;
  assert.equal(ce.bid, 99.5); assert.equal(ce.ask, 100.5); assert.equal(ce.oi, 100); assert.equal(ce.id, 'ANGEL|NFO|1004');
});
