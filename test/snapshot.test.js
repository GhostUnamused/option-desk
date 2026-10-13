// The as-of gate: nothing read in replay may be dated after the replay date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSnapshot, AsOfViolation } from '../lib/replay/snapshot.js';
import { ReplayEngine } from '../lib/replay/engine.js';
import { tempDir, seedStore, DAYS, EXPIRIES, spotOn, datesIn } from './helpers.js';

const dir = tempDir();
const store = seedStore(dir);

test('every snapshot method returns only rows dated on or before as-of', () => {
  for (const asOf of DAYS) {
    const s = getSnapshot(store, asOf);
    const all = [];
    for (const r of s.index('NIFTY')) all.push(r.date);
    for (const r of s.indexHistory('NIFTY', 3650)) all.push(r.date);
    for (const r of s.indexHistory('INDIAVIX', 3650)) all.push(r.date);
    if (s.previousDay()) all.push(s.previousDay());
    for (const e of s.expiries('NIFTY')) {
      assert.ok(e > asOf, `expiry ${e} listed on ${asOf} should be in the future`);
      for (const r of s.chain('NIFTY', e)) { assert.equal(r.date, asOf); all.push(r.date); }
      for (const r of s.contractHistory('NIFTY', e, 24000, 'CE', 3650)) all.push(r.date);
    }
    assert.ok(all.length > 0);
    for (const d of all) assert.ok(d <= asOf, `${d} leaked into the ${asOf} snapshot`);
    // The latest row is the as-of day itself, not a later one.
    assert.equal(s.quote('NIFTY').close, spotOn(asOf));
    assert.equal(s.indexHistory('NIFTY', 3650).at(-1).date, asOf);
  }
});

test('snapshot prices are the as-of day prices, and history stops at as-of', () => {
  const s = getSnapshot(store, '2024-07-03');
  const hist = s.contractHistory('NIFTY', '2024-07-11', 24000, 'CE', 3650);
  assert.deepEqual(hist.map((r) => r.date), ['2024-07-01', '2024-07-02', '2024-07-03']);
  assert.equal(s.contract('NIFTY', '2024-07-11', 24000, 'CE').price, hist.at(-1).price);
});

test('a date between trading days sees the last trading day, never the next', () => {
  const s = getSnapshot(store, '2024-07-07'); // Sunday
  assert.equal(s.quote('NIFTY').date, '2024-07-05');
  assert.equal(s.quote('NIFTY').stale, true);
  assert.ok(s.indexHistory('NIFTY', 3650).every((r) => r.date <= '2024-07-07'));
});

test('the gate refuses queries without a date bound and rows from the future', () => {
  const s = getSnapshot(store, '2024-07-03');
  assert.throws(() => s.rows('SELECT date, close FROM indices WHERE symbol = ?', 'NIFTY'), AsOfViolation);
  // A query that binds the wrong date must still not get future rows through.
  assert.throws(() => s.rows('SELECT date, close FROM indices WHERE date <= ?', '2024-07-12'), AsOfViolation);
  assert.throws(() => getSnapshot(store, '3 July 2024'));
});

test('implied volatility is backed out of each close, with Greeks', () => {
  const s = getSnapshot(store, '2024-07-02', { riskFree: 0.06 });
  const atm = s.contract('NIFTY', '2024-07-11', 24100, 'CE');
  assert.ok(Math.abs(atm.iv - 0.15) < 0.01, `ATM IV ${atm.iv} should be about 15%`);
  assert.ok(atm.delta > 0.4 && atm.delta < 0.65);
  assert.ok(atm.theta < 0 && atm.vega > 0 && atm.gamma > 0);
  // A different risk-free rate moves the implied vol a little.
  const s2 = getSnapshot(store, '2024-07-02', { riskFree: 0.10 });
  assert.notEqual(s2.contract('NIFTY', '2024-07-11', 24100, 'CE').iv, atm.iv);
});

test('the replay market (provider) never shows data after the replay date', async () => {
  const d = tempDir(); seedStore(d).close();
  const eng = new ReplayEngine(d, { accountFile: null });
  await eng.start({ date: '2024-07-03' });
  const p = eng.provider;
  const exps = await p.expiries('NIFTY');
  assert.deepEqual(exps, EXPIRIES.filter((e) => e > '2024-07-03'));
  const chain = await p.chain('NIFTY', exps[0]);
  assert.equal(chain.spot, spotOn('2024-07-03'));
  const daily = await p.daily('NIFTY', 3650);
  assert.equal(daily.at(-1).date, '2024-07-03');
  const idx = await p.indices();
  assert.equal(idx.indices[0].last, spotOn('2024-07-03'));
  assert.equal(idx.indices[0].prevClose, spotOn('2024-07-02'));
  const hist = await p.optionIntraday(chain.rows[5].ce.id);
  assert.equal(hist.points.length, 3);
  // Apart from contract expiry dates (which are known in advance), no date after as-of appears anywhere.
  const shown = datesIn([idx, daily, hist, await p.marketStatus()]);
  assert.ok(shown.every((x) => x <= '2024-07-03'), shown.filter((x) => x > '2024-07-03').join());
  eng.store.close();
});

test.after(() => store.close());
