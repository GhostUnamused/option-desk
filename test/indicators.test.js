// Indicator maths against hand-checked values, and every catalogue study runs on real-shaped bars.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, atr, realizedVol, drift, supertrend, psar, adx, stochastic, alignTo, ivRank, moveZ, STUDIES, PRESETS } from '../public/js/indicators.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const bars = Array.from({ length: 300 }, (_, i) => { const c = 22000 + 400 * Math.sin(i / 15) + i * 3; return { time: `2025-${String(1 + Math.floor(i / 28) % 12).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, o: c - 20, h: c + 60, l: c - 70, c }; });
const closes = bars.map((b) => b.c);

test('moving averages', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3); // seed 2, alpha 0.5
  assert.deepEqual(e, [null, null, 2, 3, 4]);
  assert.deepEqual(ema([null, null, 2, 4], 2), [null, null, null, 3]);
});

test('RSI is 100 in a straight rise and about 50 when moves balance', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14).at(-1), 100);
  const zig = Array.from({ length: 200 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  close(rsi(zig, 14).at(-1), 50, 3);
});

test('MACD histogram is line minus signal', () => {
  const m = macd(closes);
  const i = closes.length - 1;
  close(m.hist[i], m.line[i] - m.signal[i]);
  assert.equal(m.signal[30], null); // 26 + 9 − 1 bars needed
});

test('Bollinger bands sit k standard deviations from the middle', () => {
  const b = bollinger([1, 2, 3, 4, 5], 5, 2);
  close(b.mid[4], 3); close(b.up[4] - b.mid[4], 2 * Math.sqrt(2));
});

test('ATR of constant bars equals their range', () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({ time: i, o: 100, h: 105, l: 95, c: 100 }));
  close(atr(flat, 14).at(-1), 10);
});

test('realized vol and drift are annualised', () => {
  // Alternating ±1% log returns: stdev ≈ 1%, annualised ≈ 15.9%.
  const c = [100]; for (let i = 1; i < 60; i++) c.push(c[i - 1] * Math.exp(i % 2 ? 0.01 : -0.01));
  close(realizedVol(c, 20).at(-1), Math.sqrt(252) * 0.01 * Math.sqrt(20 / 19) * 100, 0.01);
  const g = Array.from({ length: 40 }, (_, i) => 100 * Math.exp(0.001 * i));
  close(drift(g, 20).at(-1), 0.001 * 252 * 100, 1e-6);
});

test('trend studies stay on the right side of price', () => {
  const st = supertrend(bars, 10, 3); const i = bars.length - 1;
  assert.ok(st.dir[i] === 1 ? st.line[i] < bars[i].c : st.line[i] > bars[i].c);
  const s = psar(bars); assert.ok(s.slice(5).every((x) => x != null));
  const a = adx(bars); assert.ok(a.adx.at(-1) >= 0 && a.adx.at(-1) <= 100);
  const k = stochastic(bars).k.at(-1); assert.ok(k >= 0 && k <= 100);
});

test('external series line up with bars, by date or within a time tolerance', () => {
  assert.deepEqual(alignTo([{ time: '2025-01-01' }, { time: '2025-01-02' }], [{ time: '2025-01-02', value: 7 }]), [null, 7]);
  assert.deepEqual(alignTo([{ time: 100 }, { time: 160 }, { time: 400 }], [{ time: 90, value: 1 }, { time: 150, value: 2 }], 60), [1, 2, null]);
});

test('IV rank, and big moves stand out', () => {
  assert.deepEqual(ivRank([10, 20, 15]), { rank: 50, percentile: 50, lo: 10, hi: 20, n: 3 });
  const c = Array.from({ length: 40 }, (_, i) => 100 + (i % 2) * 0.2); c.push(c.at(-1) * 0.95);
  assert.ok(moveZ(c, 20).at(-1) < -5);
});

test('every study computes on daily bars without throwing, aligned to the bars', () => {
  const ctx = { closes, perYear: 252, intraday: false, vix: closes.map(() => 14), iv: closes.map(() => 13), pcr: closes.map(() => 1.1), chain: { spot: 22900, move: 300, callWall: 23500, putWall: 22500, maxPain: 23000 } };
  for (const s of STUDIES) {
    const out = s.compute(bars, s.params, ctx);
    for (const l of out.lines) assert.equal(l.data.length, bars.length, s.id);
    if (out.hist) assert.equal(out.hist.data.length, bars.length);
  }
  const ids = new Set(STUDIES.map((s) => s.id));
  for (const list of Object.values(PRESETS)) for (const id of list) assert.ok(ids.has(id), `preset uses unknown ${id}`);
});
