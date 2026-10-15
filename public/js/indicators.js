// Technical indicators for the Markets chart: plain maths on bars, no DOM, so the server tests can run them too.
// A bar is { time, o, h, l, c }. Every function returns arrays aligned with its input: null where not enough history yet.

const nil = (n) => new Array(n).fill(null);

export function sma(v, n) {
  const out = nil(v.length); let sum = 0, cnt = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] != null) { sum += v[i]; cnt++; }
    if (i >= n && v[i - n] != null) { sum -= v[i - n]; cnt--; }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}
// Exponential average seeded with the simple average of its first n values (skips leading nulls).
export function ema(v, n, alpha = 2 / (n + 1)) {
  const out = nil(v.length); let prev = null, seed = [], i0 = v.findIndex((x) => x != null);
  if (i0 < 0) return out;
  for (let i = i0; i < v.length; i++) {
    const x = v[i]; if (x == null) continue;
    if (prev == null) { seed.push(x); if (seed.length === n) { prev = seed.reduce((a, b) => a + b, 0) / n; out[i] = prev; } continue; }
    prev = prev + alpha * (x - prev); out[i] = prev;
  }
  return out;
}
// Wilder's smoothing (RSI, ATR, ADX): an EMA with alpha 1/n.
export const rma = (v, n) => ema(v, n, 1 / n);

export function stdevWin(v, n) {
  const m = sma(v, n);
  return v.map((_, i) => { if (m[i] == null) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) ** 2; return Math.sqrt(s / n); });
}

export const trueRange = (b) => b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l));
export const atr = (b, n = 14) => rma(trueRange(b), n);

export function bollinger(c, n = 20, k = 2) {
  const mid = sma(c, n), sd = stdevWin(c, n);
  const up = mid.map((m, i) => (m == null ? null : m + k * sd[i])), lo = mid.map((m, i) => (m == null ? null : m - k * sd[i]));
  const width = mid.map((m, i) => (m == null || !m ? null : (up[i] - lo[i]) / m * 100));
  return { mid, up, lo, width };
}

export function keltner(b, n = 20, mult = 1.5) {
  const mid = ema(b.map((x) => x.c), n), a = atr(b, n);
  return { mid, up: mid.map((m, i) => (m == null || a[i] == null ? null : m + mult * a[i])), lo: mid.map((m, i) => (m == null || a[i] == null ? null : m - mult * a[i])) };
}

export function donchian(b, n = 20) {
  const up = nil(b.length), lo = nil(b.length);
  for (let i = n - 1; i < b.length; i++) { let h = -Infinity, l = Infinity; for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, b[j].h); l = Math.min(l, b[j].l); } up[i] = h; lo[i] = l; }
  return { up, lo, mid: up.map((u, i) => (u == null ? null : (u + lo[i]) / 2)) };
}

// Supertrend: an ATR trailing stop that flips sides when the close crosses it. dir 1 = uptrend, -1 = downtrend.
export function supertrend(b, n = 10, mult = 3) {
  const a = atr(b, n), line = nil(b.length), dir = nil(b.length);
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < b.length; i++) {
    if (a[i] == null) continue;
    const mid = (b[i].h + b[i].l) / 2, bu = mid + mult * a[i], bl = mid - mult * a[i], pc = i ? b[i - 1].c : b[i].c;
    fu = fu == null || bu < fu || pc > fu ? bu : fu;
    fl = fl == null || bl > fl || pc < fl ? bl : fl;
    if (d === 1 && b[i].c < fl) d = -1; else if (d === -1 && b[i].c > fu) d = 1;
    line[i] = d === 1 ? fl : fu; dir[i] = d;
  }
  return { line, dir };
}

// Parabolic SAR (stop and reverse): dots that trail the price and speed up as a trend extends.
export function psar(b, step = 0.02, max = 0.2) {
  const out = nil(b.length); if (b.length < 3) return out;
  let up = b[1].c >= b[0].c, sar = up ? b[0].l : b[0].h, ep = up ? b[1].h : b[1].l, af = step;
  for (let i = 1; i < b.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, b[i - 1].l, i > 1 ? b[i - 2].l : b[i - 1].l);
      if (b[i].l < sar) { up = false; sar = ep; ep = b[i].l; af = step; }
      else if (b[i].h > ep) { ep = b[i].h; af = Math.min(max, af + step); }
    } else {
      sar = Math.max(sar, b[i - 1].h, i > 1 ? b[i - 2].h : b[i - 1].h);
      if (b[i].h > sar) { up = true; sar = ep; ep = b[i].h; af = step; }
      else if (b[i].l < ep) { ep = b[i].l; af = Math.min(max, af + step); }
    }
    out[i] = sar;
  }
  return out;
}

export function rsi(c, n = 14) {
  const g = c.map((x, i) => (i ? Math.max(x - c[i - 1], 0) : null)), l = c.map((x, i) => (i ? Math.max(c[i - 1] - x, 0) : null));
  const ag = rma(g, n), al = rma(l, n);
  return ag.map((x, i) => (x == null || al[i] == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i])));
}

export function macd(c, fast = 12, slow = 26, sig = 9) {
  const f = ema(c, fast), s = ema(c, slow);
  const line = f.map((x, i) => (x == null || s[i] == null ? null : x - s[i]));
  const signal = ema(line, sig);
  return { line, signal, hist: line.map((x, i) => (x == null || signal[i] == null ? null : x - signal[i])) };
}

export function stochastic(b, n = 14, smoothK = 3, smoothD = 3) {
  const { up, lo } = donchian(b, n);
  const raw = b.map((x, i) => (up[i] == null ? null : up[i] === lo[i] ? 50 : (x.c - lo[i]) / (up[i] - lo[i]) * 100));
  const k = sma(raw, smoothK); return { k, d: sma(k, smoothD) };
}

export const roc = (c, n = 10) => c.map((x, i) => (i >= n && c[i - n] ? (x / c[i - n] - 1) * 100 : null));

export function cci(b, n = 20) {
  const tp = b.map((x) => (x.h + x.l + x.c) / 3), m = sma(tp, n);
  return tp.map((x, i) => { if (m[i] == null) return null; let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]); md /= n; return md ? (x - m[i]) / (0.015 * md) : 0; });
}

// ADX with +DI / −DI: how strong the trend is (ADX), and which side is winning (DIs).
export function adx(b, n = 14) {
  const pdm = b.map((x, i) => { if (!i) return null; const u = x.h - b[i - 1].h, d = b[i - 1].l - x.l; return u > d && u > 0 ? u : 0; });
  const mdm = b.map((x, i) => { if (!i) return null; const u = x.h - b[i - 1].h, d = b[i - 1].l - x.l; return d > u && d > 0 ? d : 0; });
  const tr = trueRange(b).map((x, i) => (i ? x : null));
  const str = rma(tr, n), sp = rma(pdm, n), sm = rma(mdm, n);
  const pdi = sp.map((x, i) => (x == null || !str[i] ? null : 100 * x / str[i])), mdi = sm.map((x, i) => (x == null || !str[i] ? null : 100 * x / str[i]));
  const dx = pdi.map((p, i) => (p == null || mdi[i] == null ? null : p + mdi[i] ? 100 * Math.abs(p - mdi[i]) / (p + mdi[i]) : 0));
  return { adx: rma(dx, n), pdi, mdi };
}

const logRets = (c) => c.map((x, i) => (i && c[i - 1] > 0 && x > 0 ? Math.log(x / c[i - 1]) : null));
// Close-to-close realized volatility, annualised, in %. perYear: bars per year (252 daily, 252 × 375 one-minute).
export function realizedVol(c, n = 20, perYear = 252) {
  const r = logRets(c), out = nil(c.length);
  for (let i = n; i < c.length; i++) {
    const w = r.slice(i - n + 1, i + 1); if (w.some((x) => x == null)) continue;
    const m = w.reduce((a, b) => a + b, 0) / n; out[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) * perYear) * 100;
  }
  return out;
}
// Parkinson volatility from each bar's high–low range (uses the moves inside the day, not just closes).
export function parkinsonVol(b, n = 20, perYear = 252) {
  const hl = b.map((x) => (x.h > 0 && x.l > 0 && x.h >= x.l ? Math.log(x.h / x.l) ** 2 : null));
  const m = sma(hl, n); return m.map((x) => (x == null ? null : Math.sqrt(x / (4 * Math.LN2) * perYear) * 100));
}
// Drift: the average log return over n bars, annualised, in %. Positive = the index has been climbing on average.
export function drift(c, n = 20, perYear = 252) {
  const m = sma(logRets(c), n); return m.map((x) => (x == null ? null : x * perYear * 100));
}
// Rolling z-score of returns: how unusual each bar's move was against the previous n bars (|z| ≥ 2.5 is a shock).
export function moveZ(c, n = 20) {
  const r = logRets(c), out = nil(c.length);
  for (let i = n + 1; i < c.length; i++) {
    const w = r.slice(i - n, i); if (w.some((x) => x == null) || r[i] == null) continue;
    const m = w.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    out[i] = sd ? (r[i] - m) / sd : 0;
  }
  return out;
}

// IV rank and percentile of the latest value within a history (both 0–100).
export function ivRank(values) {
  const v = values.filter((x) => x != null); if (v.length < 2) return null;
  const last = v[v.length - 1], lo = Math.min(...v), hi = Math.max(...v);
  return { rank: hi > lo ? (last - lo) / (hi - lo) * 100 : 50, percentile: v.filter((x) => x < last).length / (v.length - 1) * 100, lo, hi, n: v.length };
}

// Latest value of `points` ({ time, value }) at or before each bar time, within `tol` seconds (dates match exactly).
// Lines the external series (VIX, IV, PCR) up with the price bars so every pane has the same time axis.
export function alignTo(bars, points, tol = 0) {
  const out = nil(bars.length); if (!points?.length) return out;
  const daily = typeof bars[0]?.time === 'string';
  if (daily) { const m = new Map(points.map((p) => [p.time, p.value])); return bars.map((b) => m.get(b.time) ?? null); }
  let j = 0;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < points.length && points[j + 1].time <= bars[i].time) j++;
    const p = points[j]; if (p && p.time <= bars[i].time && bars[i].time - p.time <= tol) out[i] = p.value;
  }
  return out;
}

// ---------------- Catalogue ----------------
// Each study: id, name, group, where ('price' overlays the candles, 'pane' gets its own strip below), params, a
// beginner-level help line, and compute(bars, p, ctx) → { lines, hist?, levels?, range?, unit?, note? }.
// Line colors are token names (c1..c8, up, down, muted) that the chart maps to CSS colors; each price overlay has its own
// hue so lines can be told apart. fills: [{ up, lo, color, alpha }] shades a band between two lines. short(p): legend label.
// ctx: { closes, perYear, intraday, vix, iv, pcr, chain } (external series are already aligned to bars).

export const GROUPS = [
  ['trend', 'Trend & drift', 'Which way the index is heading and how steadily.'],
  ['vol', 'Volatility', 'How much the index is moving. Option prices follow this.'],
  ['mom', 'Momentum', 'How fast the move is, and whether it is running out of steam.'],
  ['opt', 'Options', 'What option prices and positions say about the coming move.'],
  ['sent', 'Sentiment & shocks', 'Fear, positioning and news that can jolt the market.'],
];

const L = (name, color, data, extra = {}) => ({ name, color, data, ...extra });

export const STUDIES = [
  // Trend & drift
  { id: 'sma1', name: 'SMA', group: 'trend', where: 'price', params: { n: 20 }, help: 'Simple moving average: the plain average of the last n closes. Price above it is a sign of an uptrend.',
    short: (p) => `SMA ${p.n}`, compute: (b, p, x) => ({ lines: [L(`SMA ${p.n}`, 'c5', sma(x.closes, p.n))] }) },
  { id: 'sma2', name: 'SMA (slow)', group: 'trend', where: 'price', params: { n: 50 }, help: 'A slower average. When the fast average crosses above the slow one, traders call it a bullish crossover.',
    short: (p) => `SMA ${p.n}`, compute: (b, p, x) => ({ lines: [L(`SMA ${p.n}`, 'c2', sma(x.closes, p.n), { width: 2 })] }) },
  { id: 'sma3', name: 'SMA (long)', group: 'trend', where: 'price', params: { n: 200 }, help: 'The 200-day average is the line many investors use to separate a bull market from a bear market.',
    short: (p) => `SMA ${p.n}`, compute: (b, p, x) => ({ lines: [L(`SMA ${p.n}`, 'c4', sma(x.closes, p.n), { width: 2 })] }) },
  { id: 'ema1', name: 'EMA (fast)', group: 'trend', where: 'price', params: { n: 9 }, help: 'Exponential moving average: like an SMA but weights recent prices more, so it turns sooner.',
    short: (p) => `EMA ${p.n}`, compute: (b, p, x) => ({ lines: [L(`EMA ${p.n}`, 'c7', ema(x.closes, p.n))] }) },
  { id: 'ema2', name: 'EMA (slow)', group: 'trend', where: 'price', params: { n: 21 }, help: 'A slower exponential average. Fast EMA above slow EMA is a common short-term uptrend signal.',
    short: (p) => `EMA ${p.n}`, compute: (b, p, x) => ({ lines: [L(`EMA ${p.n}`, 'c1', ema(x.closes, p.n))] }) },
  { id: 'supertrend', name: 'Supertrend', group: 'trend', where: 'price', params: { n: 10, mult: 3 }, help: 'A trailing stop line: green under the price in an uptrend, red above it in a downtrend. A flip marks a trend change.',
    short: (p) => `Supertrend ${p.n} ${p.mult}`, compute: (b, p) => { const s = supertrend(b, p.n, p.mult); return { lines: [L(`Supertrend ${p.n}, ${p.mult}`, 'up', s.line, { colors: s.dir.map((d) => (d === 1 ? 'up' : d === -1 ? 'down' : null)), width: 2 })] }; } },
  { id: 'psar', name: 'Parabolic SAR', group: 'trend', where: 'price', params: { step: 0.02, max: 0.2 }, help: 'Dots that trail the price. Dots below = uptrend, above = downtrend. Traders use them as stop-loss levels.',
    short: (p) => `SAR ${p.step} ${p.max}`, compute: (b, p) => ({ lines: [L('SAR', 'c6', psar(b, p.step, p.max), { dots: true })] }) },
  { id: 'donchian', name: 'Donchian channel', group: 'trend', where: 'price', params: { n: 20 }, help: 'The highest high and lowest low of the last n bars. A close outside it is a breakout.',
    short: (p) => `DC ${p.n}`, compute: (b, p) => { const d = donchian(b, p.n); return { lines: [L(`High ${p.n}`, 'c8', d.up), L(`Low ${p.n}`, 'c8', d.lo)], fills: [{ up: d.up, lo: d.lo, color: 'c8', alpha: 0.05 }] }; } },
  { id: 'adx', name: 'ADX / DMI', short: (p) => `ADX ${p.n}`, group: 'trend', where: 'pane', params: { n: 14 }, help: 'ADX measures trend strength: above 25 is a real trend, below 20 is a range (good for option sellers). +DI above −DI means buyers are in control.',
    compute: (b, p) => { const a = adx(b, p.n); return { lines: [L('ADX', 'c1', a.adx, { width: 2 }), L('+DI', 'up', a.pdi), L('−DI', 'down', a.mdi)], levels: [25, 20] }; } },
  { id: 'drift', name: 'Drift', short: (p) => `Drift ${p.n}`, group: 'trend', where: 'pane', params: { n: 20 }, unit: '%/yr', help: 'The average return per bar over the last n bars, scaled to a year. The steady push behind the price: above 0 it has been climbing.',
    compute: (b, p, x) => ({ lines: [L(`Drift ${p.n}`, 'c2', drift(x.closes, p.n, x.perYear), { width: 2 })], levels: [0], unit: '%' }) },
  // Volatility
  { id: 'bb', name: 'Bollinger Bands', group: 'vol', where: 'price', params: { n: 20, k: 2 }, help: 'An average with bands k standard deviations away. Bands squeeze when the market is quiet and widen when it moves; quiet often comes before a big move.',
    short: (p) => `BB ${p.n} ${p.k}`, compute: (b, p, x) => { const r = bollinger(x.closes, p.n, p.k); return { lines: [L(`Basis ${p.n}`, 'c2', r.mid, { dashed: true }), L('Upper', 'c3', r.up), L('Lower', 'c3', r.lo)], fills: [{ up: r.up, lo: r.lo, color: 'c3', alpha: 0.08 }] }; } },
  { id: 'keltner', name: 'Keltner channel', group: 'vol', where: 'price', params: { n: 20, mult: 1.5 }, help: 'An EMA with bands set by the average true range. When the Bollinger Bands sit inside it, volatility is "squeezed".',
    short: (p) => `KC ${p.n} ${p.mult}`, compute: (b, p) => { const r = keltner(b, p.n, p.mult); return { lines: [L('Upper', 'c4', r.up, { dashed: true }), L('Lower', 'c4', r.lo, { dashed: true })], fills: [{ up: r.up, lo: r.lo, color: 'c4', alpha: 0.05 }] }; } },
  { id: 'bbw', name: 'Bollinger width', short: (p) => `BBW ${p.n} ${p.k}`, group: 'vol', where: 'pane', params: { n: 20, k: 2 }, unit: '%', help: 'How wide the Bollinger Bands are, as % of price. Low readings mean a squeeze: options are often cheap just before a breakout.',
    compute: (b, p, x) => ({ lines: [L('Band width', 'c3', bollinger(x.closes, p.n, p.k).width, { width: 2 })], unit: '%' }) },
  { id: 'atr', name: 'ATR', short: (p) => `ATR ${p.n}`, group: 'vol', where: 'pane', params: { n: 14 }, unit: 'pts', help: 'Average true range: the typical size of one bar\'s move in index points, gaps included. Useful for setting stop-losses.',
    compute: (b, p) => ({ lines: [L(`ATR ${p.n}`, 'c5', atr(b, p.n), { width: 2 })], unit: 'pts' }) },
  { id: 'rv', name: 'Realized volatility', short: (p) => `RV ${p.n}`, group: 'vol', where: 'pane', params: { n: 20 }, unit: '%', help: 'How much the index actually moved, as a yearly %: from closes, and from each bar\'s high–low range (Parkinson). Compare with implied vol.',
    // One-minute points have no high or low, so the high–low estimate is daily only.
    compute: (b, p, x) => ({ lines: [L(`Close-to-close ${p.n}`, 'c1', realizedVol(x.closes, p.n, x.perYear), { width: 2 }), ...(x.intraday ? [] : [L('High–low', 'c6', parkinsonVol(b, p.n, x.perYear))])], unit: '%' }) },
  // Momentum
  { id: 'rsi', name: 'RSI', short: (p) => `RSI ${p.n}`, group: 'mom', where: 'pane', params: { n: 14 }, help: 'Relative strength index, 0–100. Above 70 the index is "overbought" (ran up fast), below 30 "oversold". Fades and divergences hint at a turn.',
    compute: (b, p, x) => ({ lines: [L(`RSI ${p.n}`, 'c3', rsi(x.closes, p.n), { width: 2 })], levels: [70, 50, 30], range: [0, 100] }) },
  { id: 'macd', name: 'MACD', short: (p) => `MACD ${p.fast} ${p.slow} ${p.signal}`, group: 'mom', where: 'pane', params: { fast: 12, slow: 26, signal: 9 }, help: 'Gap between a fast and slow EMA. MACD crossing above its signal line is bullish; bars show the gap between them growing or shrinking.',
    compute: (b, p, x) => { const m = macd(x.closes, p.fast, p.slow, p.signal); return { lines: [L('MACD', 'c1', m.line, { width: 2 }), L('Signal', 'c2', m.signal)], hist: L('Histogram', 'up', m.hist), levels: [0] }; } },
  { id: 'stoch', name: 'Stochastic', short: (p) => `Stoch ${p.n} ${p.smooth} ${p.d}`, group: 'mom', where: 'pane', params: { n: 14, smooth: 3, d: 3 }, help: 'Where the close sits in the recent high–low range, 0–100. Above 80 near the top of the range, below 20 near the bottom.',
    compute: (b, p) => { const s = stochastic(b, p.n, p.smooth, p.d); return { lines: [L('%K', 'c1', s.k, { width: 2 }), L('%D', 'c2', s.d)], levels: [80, 20], range: [0, 100] }; } },
  { id: 'roc', name: 'Rate of change', short: (p) => `ROC ${p.n}`, group: 'mom', where: 'pane', params: { n: 10 }, unit: '%', help: 'Percent change over the last n bars. Shows how fast the index is moving and whether that speed is fading.',
    compute: (b, p, x) => ({ lines: [L(`ROC ${p.n}`, 'c4', roc(x.closes, p.n), { width: 2 })], levels: [0], unit: '%' }) },
  { id: 'cci', name: 'CCI', short: (p) => `CCI ${p.n}`, group: 'mom', where: 'pane', params: { n: 20 }, help: 'Commodity channel index: how far the price is from its average, in units of typical deviation. Beyond ±100 is a strong push.',
    compute: (b, p) => ({ lines: [L(`CCI ${p.n}`, 'c5', cci(b, p.n), { width: 2 })], levels: [100, 0, -100] }) },
  // Options
  { id: 'iv', name: 'ATM implied vol', short: () => 'ATM IV', group: 'opt', where: 'pane', needs: 'iv', params: { n: 20 }, unit: '%', help: 'What options are pricing in (at the money, expiry a week or more out) against what the index actually did. IV above realized = options are expensive.',
    compute: (b, p, x) => ({ lines: [L('ATM IV', 'c1', x.iv, { width: 2 }), L(`Realized ${p.n}`, 'c6', realizedVol(x.closes, p.n, x.perYear), { dashed: true })], unit: '%', rank: true }) },
  { id: 'ivrv', name: 'IV − realized spread', short: (p) => `IV − RV ${p.n}`, group: 'opt', where: 'pane', needs: 'iv', params: { n: 20 }, unit: 'pts', help: 'Implied vol minus realized vol. Above 0 option sellers are being paid extra for the risk; below 0 option buyers are getting a bargain.',
    compute: (b, p, x) => { const r = realizedVol(x.closes, p.n, x.perYear); return { lines: [], hist: L('IV − RV', 'up', x.iv.map((v, i) => (v == null || r[i] == null ? null : v - r[i]))), levels: [0], unit: 'pts' }; } },
  { id: 'emove', name: 'Expected move', short: () => 'Exp. move', group: 'opt', where: 'price', needs: 'chain', params: {}, help: 'The ±1 standard deviation range options price in by the analysis expiry. The index ends inside it about two times in three.',
    compute: (b, p, x) => ({ lines: [], prices: x.chain?.move ? [{ price: x.chain.spot + x.chain.move, title: '+1σ by expiry', color: 'c5' }, { price: x.chain.spot - x.chain.move, title: '−1σ by expiry', color: 'c5' }] : [] }) },
  { id: 'walls', name: 'OI walls & max pain', short: () => 'OI walls', group: 'opt', where: 'price', needs: 'chain', params: {}, help: 'The strikes with the most open calls (a ceiling) and puts (a floor), and max pain, where the most options expire worthless.',
    compute: (b, p, x) => ({ lines: [], prices: x.chain ? [{ price: x.chain.callWall, title: 'Call wall', color: 'down' }, { price: x.chain.putWall, title: 'Put wall', color: 'up' }, { price: x.chain.maxPain, title: 'Max pain', color: 'muted' }] : [] }) },
  // Sentiment & shocks
  { id: 'vix', name: 'India VIX', short: () => 'India VIX', group: 'sent', where: 'pane', needs: 'vix', params: {}, help: 'The market\'s fear gauge. Spikes mark panics; option premiums rise and fall with it.',
    compute: (b, p, x) => ({ lines: [L('India VIX', 'c2', x.vix, { width: 2 })], levels: [24, 18, 13], rank: true }) },
  { id: 'pcr', name: 'Put–call ratio', short: () => 'PCR', group: 'sent', where: 'pane', needs: 'pcr', params: {}, help: 'Open puts ÷ open calls in the nearest expiry. High (above ~1.3) means heavy put writing or hedging; very low means complacency. Extremes often come before reversals.',
    compute: (b, p, x) => ({ lines: [L('PCR (OI)', 'c4', x.pcr, { width: 2 })], levels: [1.3, 1, 0.7] }) },
  { id: 'shocks', name: 'Shock moves', short: (p) => `Shocks ${p.z}σ`, group: 'sent', where: 'price', params: { n: 20, z: 2.5 }, help: 'Marks bars where the index moved far more than usual (z bigger than the threshold), and big jumps in India VIX. These are where news hit.',
    compute: (b, p, x) => {
      // Minute bars throw up 2–3σ moves every day, so the intraday view only marks the really big ones.
      const z = moveZ(x.closes, p.n), marks = [], lim = x.intraday ? Math.max(p.z, 4) : p.z;
      z.forEach((v, i) => { if (v != null && Math.abs(v) >= lim) marks.push({ i, up: v > 0, text: `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}σ`, title: `${v > 0 ? 'Jump' : 'Drop'} of ${Math.abs(v).toFixed(1)}× the usual move` }); });
      if (!x.intraday) x.vix.forEach((v, i) => { const pv = x.vix[i - 1]; if (v != null && pv && v / pv - 1 >= 0.15 && !marks.some((m) => m.i === i)) marks.push({ i, up: false, text: 'VIX↑', title: `India VIX jumped ${Math.round((v / pv - 1) * 100)}%` }); });
      return { lines: [], marks };
    } },
  { id: 'events', name: 'Events & news', short: () => 'Events', group: 'sent', where: 'price', needs: 'events', params: {}, help: 'Known market events (budgets, elections, wars, policy shocks) and shock headlines from the news panel, pinned to the chart.',
    compute: () => ({ lines: [] }) },
];

export const PRESETS = {
  Clean: ['sma1', 'sma2'],
  'Trend follower': ['ema1', 'ema2', 'supertrend', 'adx', 'macd'],
  Volatility: ['bb', 'keltner', 'rv', 'iv', 'vix', 'emove'],
  'Option seller': ['emove', 'walls', 'iv', 'pcr', 'rsi', 'events'],
  'Shock watch': ['bb', 'shocks', 'events', 'vix', 'pcr'],
};
export const DEFAULT_ON = ['sma1', 'sma2', 'events'];
