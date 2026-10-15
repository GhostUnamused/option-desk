// INDstocks provider against a fake API: field mapping, NSE fallback, and an expired token parking the broker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndstocksProvider } from '../lib/indstocks.js';
import { SecretFile } from '../lib/secrets.js';

const CHAIN = { status: 'success', data: { underlying_ltp: 24471.7, expiry: '2026-10-20', strikes: {
  24500: { ce: { security_id: '45110', last_price: 150, previous_close_price: 120, oi: 65000, previous_oi: 64990, volume: 6500, top_bid_price: 149.5, top_bid_quantity: 65, top_ask_price: 150.5, top_ask_quantity: 130, iv: 11.2 }, pe: { security_id: '45111', last_price: 170, previous_close_price: 200, oi: 500, previous_oi: 600, volume: 130, top_bid_price: 169, top_ask_price: 171, iv: 12 } },
  24450: { ce: { security_id: '45108', last_price: 180, previous_close_price: 0, oi: 0, previous_oi: 0, volume: 0, iv: 10.5 }, pe: null },
} } };

function fakeApi(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url); calls.push({ path: u.pathname + u.search, auth: opts?.headers?.Authorization });
    const [status, body] = handler(u);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return calls;
}
const nse = { chain: async () => ({ from: 'nse' }), expiries: async () => ['nse'], marketStatus: async () => ({ open: false }), indices: async () => ({ from: 'nse' }) };
const withEnv = (token) => { process.env.INDSTOCKS_TOKEN = token; return () => delete process.env.INDSTOCKS_TOKEN; };

test('chain maps INDstocks fields to the app\'s chain shape', async () => {
  const done = withEnv('tok_abcdefghijklmnop');
  const QUOTE = { status: 'success', data: { NFO_45110: { open_interest: 65000, open_interest_change: 25 } } };
  const calls = fakeApi((u) => u.pathname === '/market/instruments' ? [200, 'EXCH,SEGMENT,SECURITY_ID\nNSE,NIFTY 50,40000001\nNSE,BANK NIFTY,40000003\n']
    : u.pathname === '/market/quotes/full' ? [200, QUOTE] : [200, CHAIN]);
  const p = new IndstocksProvider(nse, null);
  const c = await p.chain('NIFTY', '2026-10-20');
  done();
  assert.equal(c.spot, 24471.7);
  assert.deepEqual(c.rows.map((r) => r.strike), [24450, 24500]);
  const ce = c.rows[1].ce;
  assert.equal(ce.id, 'NFO_45110'); assert.equal(ce.chg, 30); assert.equal(ce.pchg, 25);
  assert.equal(ce.oi, 1000); assert.equal(ce.chgOi, 200); // 65000 units = 1000 lots, up 25% = +200 lots
  assert.equal(c.rows[1].pe.chgOi, 0); // no OI-change quote for it
  assert.ok(!calls.some((x) => x.path.includes('NFO_45108')), 'never-traded strikes are not quoted');
  assert.equal(ce.bid, 149.5); assert.equal(ce.ask, 150.5); assert.equal(ce.vol, 100); // 6500 units / lot 65
  assert.equal(c.rows[0].pe, null); assert.equal(c.rows[0].ce.pchg, 0);
  assert.match(c.timestamp, /^\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}:\d{2}$/);
  assert.ok(calls.every((x) => x.auth === 'tok_abcdefghijklmnop')); // raw token, no "Bearer"
  assert.ok(calls.some((x) => x.path.includes('underlying-scrip=40000001') && x.path.includes('expiry=2026-10-20')));
  assert.equal(p.name, 'INDstocks');
});

test('a quote batch refused for one bad code is split, and the split is remembered', async () => {
  const done = withEnv('tok_abcdefghijklmnop');
  const codes = Array.from({ length: 20 }, (_, i) => `NFO_${100 + i}`);
  const calls = fakeApi((u) => {
    const asked = u.searchParams.get('scrip-codes').split(',');
    return asked.includes('NFO_103') ? [400, { message: 'Bad Request', debug_info: 'Invalid scrip codes or mode' }] : [200, { status: 'success', data: Object.fromEntries(asked.map((c) => [c, { open_interest_change: 1 }])) }];
  });
  const p = new IndstocksProvider(nse, null);
  const got = await p.quotes(codes, 0);
  assert.equal(Object.keys(got).length, 15); // 20 → 10 + 10 → the 5 holding NFO_103 is too small to split again
  assert.ok(!got.NFO_103);
  const n = calls.length; await p.quotes(codes, 0);
  assert.equal(calls.length - n, 2, 'second time: straight to the halves');
  done();
});

test('an expired token parks INDstocks and NSE answers instead', async () => {
  const done = withEnv('tok_abcdefghijklmnop');
  const calls = fakeApi(() => [403, { status: 'error', message: 'Invalid token', error_type: 'TokenException' }]);
  const p = new IndstocksProvider(nse, null);
  assert.deepEqual(await p.expiries('NIFTY'), ['nse']);
  assert.equal(p.status().expired, true); assert.equal(p.name, 'NSE');
  const n = calls.length;
  assert.deepEqual(await p.chain('NIFTY', '2026-10-20'), { from: 'nse' });
  assert.equal(calls.length, n, 'no more INDstocks calls until a new token arrives');
  done();
});

test('no token: everything comes from NSE and INDstocks is never called', async () => {
  const calls = fakeApi(() => [500, {}]);
  const p = new IndstocksProvider(nse, null);
  assert.deepEqual(await p.expiries('NIFTY'), ['nse']);
  assert.equal(calls.length, 0); assert.equal(p.status().hasToken, false);
});

test('a pasted token is checked, saved encrypted, and never in the status', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-broker-'));
  const secret = new SecretFile(path.join(dir, 'broker.dat'));
  fakeApi((u) => (u.pathname === '/user/profile' ? [200, { status: 'success', data: { first_name: 'Asha' } }] : [500, {}]));
  const p = new IndstocksProvider(nse, secret);
  const s = await p.setToken('  good_token_1234567890  ');
  assert.equal(s.user, 'Asha'); assert.equal(s.source, 'saved');
  assert.ok(!JSON.stringify(s).includes('good_token'));
  assert.ok(!fs.readFileSync(secret.file, 'utf8').includes('good_token'));
  assert.equal(new IndstocksProvider(nse, secret).token, 'good_token_1234567890');
  p.forget(); assert.equal(fs.existsSync(secret.file), false);
  fakeApi(() => [403, { status: 'error', message: 'bad' }]);
  await assert.rejects(new IndstocksProvider(nse, secret).setToken('wrong_token_1234567890'), /did not accept/);
  assert.equal(fs.existsSync(secret.file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
