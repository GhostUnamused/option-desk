// Guided demo of one replay session. Every number is made up here, from a seeded random walk, and priced
// with the app's own Black–Scholes code (bs.js, copied from public/js) so premiums, Greeks and payoffs agree.
// Nothing on this page fetches market data.
import { bs, ncdf, intrinsic } from './bs.js';
import { device, reducedMotion, fillCta } from './main.js';

const R = 0.065;          // risk-free rate used for pricing (the app's default is in this range)
const MIN = 375;          // minutes from 09:15 to 15:30
const ENTRY = 15;         // the session starts at 09:30
const HIST = 70;          // daily candles before the sample day
const START_BALANCE = 500000;
const DAY0 = 1000 * 86400; // chart time origin; axis labels are relative, never dates

const INDEX = {
  NIFTY: { name: 'NIFTY 50', short: 'NIFTY', base: 24180, step: 50, lot: 65, volMul: 1, seed: 3, oi: 140000 },
  BANKNIFTY: { name: 'NIFTY BANK', short: 'BANK NIFTY', base: 51740, step: 100, lot: 30, volMul: 1.2, seed: 7, oi: 60000 },
};
const DAYS = {
  calm: { label: 'Sample day A', mood: 'A quiet uptrend', weekday: 'Tuesday', vix: 12.4, vixMove: -0.4, drift: 0.0011, dvol: 0.006, gap: 0.0012, dayMove: 0.0045, dte: 6, putScale: 1.2, seed: 11 },
  nervous: { label: 'Sample day B', mood: 'A nervous, falling week', weekday: 'Friday', vix: 19.6, vixMove: 1.6, drift: -0.0016, dvol: 0.011, gap: -0.004, dayMove: -0.011, dte: 3, putScale: 0.75, seed: 23 },
  expiry: { label: 'Sample day C', mood: 'Expiry day, going nowhere', weekday: 'Tuesday', vix: 14.8, vixMove: -0.3, drift: 0.0002, dvol: 0.0075, gap: 0.0008, dayMove: -0.0008, dte: 0, putScale: 1, seed: 5 },
};
const STEPS = [
  { short: 'Day', title: 'Pick a past day', text: 'Replay puts you on a real past market day, before you know how it ends. Here, pick one of three sample days and an index. You trade it as if it were 9:30 that morning.', tip: 'Switch the index or the day and the whole demo changes with it.' },
  { short: 'Read', title: 'Read the market in plain English', text: 'Before trading, Optionwise sums the market up in words: which way it has been going, how nervous it is, and how far traders expect it to move.', tip: 'Most days the index stays inside its expected move. That number shapes which strikes make sense.' },
  { short: 'Chain', title: 'Open the option chain, tap a strike', text: 'Calls gain when the index rises, puts gain when it falls. Tap any price to see its premium and its Greeks: how it reacts to the index, to time and to fear.', tip: 'Tap a few prices. Delta grows as the strike gets closer to, then past, the index.' },
  { short: 'Build', title: 'Build the trade', text: 'The strategy builder shows what the trade makes or loses at every index level on expiry day, the most you can win and lose, and where you break even.', tip: 'Try the spread: you give up some upside to pay less and lose less.' },
  { short: 'Place', title: 'Place it as a paper trade', text: 'Every paper trade needs a reason and an exit plan. Writing it down now is what makes the review useful later. Buys fill at the ask and sells at the bid, with charges.', tip: 'Edit the reason or the exit levels, then place it. No real money moves.' },
  { short: 'Review', title: 'Step time forward, then review', text: 'Move the clock and watch profit and loss change with the index, with time decay and with volatility. Your stop-loss and target close the trade if they are hit.', tip: 'Go to the close to see the end-of-session review.' },
];

// ---------- formatting ----------
const nf = (n, d = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const rupees = (n, d = 0) => (n < 0 ? '−' : '') + '₹' + nf(Math.abs(n), d);
const signed = (n, d = 0) => (Math.round(n * 10 ** d) > 0 ? '+' : Math.round(n * 10 ** d) < 0 ? '−' : '') + '₹' + nf(Math.abs(n), d);
const signedN = (n, d = 2) => (n > 0 ? '+' : n < 0 ? '−' : '') + nf(Math.abs(n), d);
const compact = (n) => n >= 1e7 ? nf(n / 1e7, 2) + ' Cr' : n >= 1e5 ? nf(n / 1e5, 2) + ' L' : nf(n, 0);
const tone = (n) => n > 0.004 ? 'up' : n < -0.004 ? 'down' : '';
const hhmm = (m) => { const t = 9 * 60 + 15 + m; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round05 = (p) => Math.round(p * 20) / 20;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const vixMood = (v) => v < 13 ? { key: 'calm', label: 'Calm', hint: 'Traders expect small moves. Options are cheap.' }
  : v < 18 ? { key: 'normal', label: 'Normal', hint: 'The usual amount of expected movement.' }
  : v < 24 ? { key: 'nervous', label: 'Nervous', hint: 'Traders expect bigger swings. Options are pricier.' }
  : { key: 'fearful', label: 'Fearful', hint: 'Traders expect large swings. Options are expensive.' };

// ---------- sample market ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const sma = (arr, n, i) => i + 1 < n ? null : arr.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n;

const markets = new Map();
function market(ix, dk) {
  const key = ix + dk;
  if (markets.has(key)) return markets.get(key);
  const I = INDEX[ix], D = DAYS[dk], r = rng(D.seed * 97 + I.seed);
  // Daily history: a random walk, rescaled so the last close is the index's base level.
  let c = 1; const raw = [];
  for (let i = 0; i < HIST; i++) {
    const o = c * (1 + gauss(r) * D.dvol * 0.15);
    c = o * Math.exp(D.drift + D.dvol * I.volMul * gauss(r));
    const wick = () => Math.abs(gauss(r)) * D.dvol * I.volMul * 0.45;
    raw.push({ o, h: Math.max(o, c) * (1 + wick()), l: Math.min(o, c) * (1 - wick()), c });
  }
  const k = I.base / c;
  const daily = raw.map((b, i) => ({ time: DAY0 + (i - HIST) * 86400, open: b.o * k, high: b.h * k, low: b.l * k, close: b.c * k }));
  const closes = daily.map((d) => d.close);
  const prev = closes[HIST - 1];
  // The sample day, minute by minute: a Brownian bridge from the open to the close.
  const open = prev * (1 + D.gap * I.volMul), close = open * (1 + D.dayMove * I.volMul);
  const sd = D.dvol * I.volMul / Math.sqrt(MIN) * 1.15;
  const W = [0]; for (let m = 1; m <= MIN; m++) W.push(W[m - 1] + gauss(r));
  const path = W.map((x, m) => open * Math.exp(Math.log(close / open) * m / MIN + sd * (x - W[MIN] * m / MIN)));
  const vix = W.map((x, m) => D.vix + D.vixMove * m / MIN + 0.12 * Math.sin(m / 23 + D.seed) + 0.04 * (x - W[MIN] * m / MIN));
  const rets = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const last20 = rets.slice(-20), mean = last20.reduce((a, b) => a + b, 0) / 20;
  const realized = Math.sqrt(last20.reduce((a, b) => a + (b - mean) ** 2, 0) / 19 * 252);
  const mk = { ix, dk, I, D, daily, closes, prev, path, vix, realized, sma20: sma(closes, 20, HIST - 1), sma50: sma(closes, 50, HIST - 1) };
  mk.S0 = path[ENTRY];
  mk.atm = Math.round(mk.S0 / I.step) * I.step;
  mk.strikes = Array.from({ length: 13 }, (_, i) => mk.atm + (i - 6) * I.step);
  // Open interest (contracts): humps a few strikes out of the money, extra at round numbers.
  const oiR = rng(D.seed * 13 + I.seed);
  mk.oi = mk.strikes.map((K) => {
    const round = K % (I.step * 10) === 0 ? 1.7 : K % (I.step * 2) === 0 ? 1.15 : 1;
    const hump = (centre) => Math.exp(-(((K - centre) / (I.step * 4.5)) ** 2));
    return {
      CE: Math.round(I.oi * round * (0.25 + hump(mk.atm + 3 * I.step)) * (0.7 + 0.6 * oiR())),
      PE: Math.round(I.oi * D.putScale * round * (0.25 + hump(mk.atm - 3 * I.step)) * (0.7 + 0.6 * oiR())),
    };
  });
  markets.set(key, mk);
  return mk;
}

const yearsAt = (mk, m) => (mk.D.dte * 1440 + (MIN - m)) / (365 * 1440);
const ivAt = (mk, K, m) => { const x = (K - mk.path[m]) / mk.path[m]; return mk.vix[m] / 100 * mk.I.volMul * (1 - 1.2 * x + 30 * x * x); };
const quote = (mk, type, K, m = ENTRY, iv = ivAt(mk, K, m)) => bs(type, mk.path[m], K, yearsAt(mk, m), R, iv);
const halfSpread = (p) => Math.max(0.05, round05(p * 0.006 + 0.05));
const expectedMove = (mk, days) => mk.S0 * mk.vix[ENTRY] / 100 * mk.I.volMul * Math.sqrt(days / 365);

// ---------- trade maths ----------
const PRESETS = {
  single: { label: (s) => `Buy the ${s.type === 'CE' ? 'call' : 'put'} you tapped` },
  spread: { label: (s) => s.type === 'CE' ? 'Bull call spread' : 'Bear put spread' },
  condor: { label: () => 'Iron condor (bet on a range)' },
};
function legsFor(mk, st) {
  const { step } = mk.I, sel = st.sel || { type: 'CE', K: mk.atm };
  const off = Math.max(2, Math.round(expectedMove(mk, mk.D.dte + 0.25) * 0.6 / step)), wing = off + 3;
  const raw = st.preset === 'condor'
    ? [[-1, 'PE', mk.atm - off * step], [1, 'PE', mk.atm - wing * step], [-1, 'CE', mk.atm + off * step], [1, 'CE', mk.atm + wing * step]]
    : st.preset === 'spread'
      ? [[1, sel.type, sel.K], [-1, sel.type, sel.K + (sel.type === 'CE' ? 3 : -3) * step]]
      : [[1, sel.type, sel.K]];
  return raw.map(([side, type, K]) => {
    const q = quote(mk, type, K), hs = halfSpread(q.price);
    return { side, type, K, qty: st.lots * mk.I.lot, iv0: ivAt(mk, K, ENTRY), mid0: q.price, q,
      fill: side > 0 ? round05(q.price + hs) : Math.max(0.05, round05(q.price - hs)) };
  });
}
const legName = (mk, l) => `${mk.I.short} ${nf(l.K, 0)} ${l.type}`;
const atExpiry = (legs, S) => legs.reduce((a, l) => a + l.side * l.qty * (intrinsic(l.type, S, l.K) - l.fill), 0);
const premiumFlow = (legs) => legs.reduce((a, l) => a - l.side * l.qty * l.fill, 0); // < 0 = you pay

// A typical discount-broker schedule (₹20 an order plus taxes). The real app keeps dated rates per day.
function charges(trades) {
  let total = 0;
  for (const { side, price, qty } of trades) {
    const turnover = price * qty, brokerage = 20, exch = turnover * 0.0003503, sebi = turnover * 1e-6;
    total += brokerage + exch + sebi + 0.18 * (brokerage + exch + sebi) + (side < 0 ? turnover * 0.001 : turnover * 0.00003);
  }
  return total;
}

function analyse(mk, legs) {
  const lo = mk.S0 * 0.4, hi = mk.S0 * 1.6, n = 2400, grid = [];
  for (let i = 0; i <= n; i++) { const S = lo + (hi - lo) * i / n; grid.push([S, atExpiry(legs, S)]); }
  const netCalls = legs.reduce((a, l) => a + (l.type === 'CE' ? l.side : 0), 0);
  const ys = grid.map((g) => g[1]);
  const maxProfit = netCalls > 0 ? Infinity : Math.max(...ys, atExpiry(legs, 0.01));
  const maxLoss = netCalls < 0 ? -Infinity : Math.min(...ys, atExpiry(legs, 0.01));
  const bes = [];
  for (let i = 1; i < grid.length; i++) {
    const [x0, y0] = grid[i - 1], [x1, y1] = grid[i];
    if ((y0 < 0 && y1 >= 0) || (y0 >= 0 && y1 < 0)) bes.push(x0 + (x1 - x0) * (-y0) / (y1 - y0));
  }
  // Chance of profit at expiry: the index's spread implied by ATM volatility, no drift.
  const T = yearsAt(mk, ENTRY), sig = ivAt(mk, mk.atm, ENTRY), sT = sig * Math.sqrt(T);
  const cdf = (x) => sT > 0 ? ncdf((Math.log(x / mk.S0) + sT * sT / 2) / sT) : (x >= mk.S0 ? 1 : 0);
  let pop = 0;
  for (let i = 1; i < grid.length; i++) if (grid[i][1] > 0 && grid[i - 1][1] > 0) pop += cdf(grid[i][0]) - cdf(grid[i - 1][0]);
  if (grid[0][1] > 0) pop += cdf(grid[0][0]);
  if (grid[n][1] > 0) pop += 1 - cdf(grid[n][0]);
  const flow = premiumFlow(legs);
  const greeks = legs.reduce((a, l) => ({ delta: a.delta + l.side * l.qty * l.q.delta, theta: a.theta + l.side * l.qty * l.q.theta, vega: a.vega + l.side * l.qty * l.q.vega }), { delta: 0, theta: 0, vega: 0 });
  const entryCharges = charges(legs.map((l) => ({ side: l.side, price: l.fill, qty: l.qty })));
  return { maxProfit, maxLoss, bes, pop, flow, greeks, entryCharges, blocked: flow < 0 ? -flow : Math.max(-maxLoss, 0) };
}

function defaultsFor(mk, st, a) {
  const credit = a.flow > 0, size = Math.abs(a.flow);
  const tp = credit ? size * 0.5 : Math.min(size * 0.8, Number.isFinite(a.maxProfit) ? a.maxProfit * 0.8 : Infinity);
  const sl = credit ? Math.min(size, -a.maxLoss * 0.6) : size * 0.5;
  const legs = legsFor(mk, st), l = legs[0], dir = st.preset === 'condor' ? 0 : l.type === 'CE' ? 1 : -1;
  const trend = mk.prev > mk.sma20 && mk.prev > mk.sma50 ? 'up' : mk.prev < mk.sma20 && mk.prev < mk.sma50 ? 'down' : 'mixed';
  const vm = vixMood(mk.vix[ENTRY]).label.toLowerCase();
  const thesis = dir === 0
    ? `${mk.I.short} should stay between ${nf(a.bes[0] || mk.atm, 0)} and ${nf(a.bes[a.bes.length - 1] || mk.atm, 0)} until expiry. VIX is ${vm}, so I'm selling time value and capping my risk with the outer strikes.`
    : dir > 0
      ? `${mk.I.short} is in a${trend === 'up' ? 'n uptrend' : trend === 'down' ? ' downtrend, but I expect a bounce' : ' mixed trend'}, VIX is ${vm}. I expect it to rise today${st.preset === 'spread' ? ', but not by more than the upper strike' : ''}.`
      : `${mk.I.short} is ${trend === 'down' ? 'below its 20- and 50-day averages' : 'losing steam'} and VIX is ${vm}. I expect it to fall today${st.preset === 'spread' ? ', but not past the lower strike' : ''}.`;
  const wrong = dir === 0
    ? `${mk.I.short} breaks out of that range, or VIX jumps.`
    : dir > 0 ? `${mk.I.short} falls below ${nf(mk.S0 - expectedMove(mk, 1) * 0.6, 0)}.` : `${mk.I.short} climbs back above ${nf(mk.S0 + expectedMove(mk, 1) * 0.6, 0)}.`;
  return { thesis, wrong, sl: Math.round(sl / 100) * 100 || 100, tp: Math.round(tp / 100) * 100 || 100 };
}

// P&L at minute m if the position were closed then (sell at bid, buy back at ask; expiry settles at intrinsic).
function markAt(mk, legs, m) {
  const T = yearsAt(mk, m), S = mk.path[m];
  let pnl = 0, spot = 0, time = 0, vol = 0;
  const exits = legs.map((l) => {
    const now = quote(mk, l.type, l.K, m);
    const settle = T <= 1e-8;
    const exit = settle ? intrinsic(l.type, S, l.K) : l.side > 0 ? Math.max(0, round05(now.price - halfSpread(now.price))) : round05(now.price + halfSpread(now.price));
    const T0 = yearsAt(mk, ENTRY);
    const a = bs(l.type, S, l.K, T0, R, l.iv0).price, b = bs(l.type, S, l.K, T, R, l.iv0).price;
    spot += l.side * l.qty * (a - l.mid0); time += l.side * l.qty * (b - a); vol += l.side * l.qty * (now.price - b);
    pnl += l.side * l.qty * (exit - l.fill);
    return { exit, settle };
  });
  return { pnl, spot, time, vol, spread: pnl - spot - time - vol, exits };
}

// ---------- state ----------
const fresh = () => ({ step: 0, ix: 'NIFTY', day: 'calm', sel: null, preset: 'single', lots: 1, thesis: null, wrong: null, sl: null, tp: null, placed: false, minute: ENTRY, closedAt: null, closeWhy: null, finished: false });
let st = fresh();
let charts = [];
let playing = null;
let current = null; // { update } of the step on screen

const mkNow = () => market(st.ix, st.day);
function plan() {
  const mk = mkNow(), legs = legsFor(mk, st), a = analyse(mk, legs), d = defaultsFor(mk, st, a);
  return { mk, legs, a, thesis: st.thesis ?? d.thesis, wrong: st.wrong ?? d.wrong, sl: st.sl ?? d.sl, tp: st.tp ?? d.tp };
}
function resetTrade() { st.placed = false; st.minute = ENTRY; st.closedAt = null; st.closeWhy = null; st.finished = false; stopPlay(); }
function resetPlan() { st.thesis = st.wrong = st.sl = st.tp = null; resetTrade(); }

// Walk the clock to minute `to`, closing the trade if a stop-loss or target is crossed on the way.
function advanceTo(to) {
  const p = plan();
  to = Math.min(MIN, Math.max(ENTRY, to));
  for (let m = st.minute + 1; m <= to && st.closedAt === null; m++) {
    const { pnl } = markAt(p.mk, p.legs, m);
    if (pnl <= -p.sl) { st.closedAt = m; st.closeWhy = 'Stop-loss hit'; }
    else if (pnl >= p.tp) { st.closedAt = m; st.closeWhy = 'Target hit'; }
  }
  st.minute = to;
}

// ---------- shared views ----------
function chartOpts(el) {
  return {
    autoSize: true,
    // The TradingView attribution (with a link) is in the page footer, so the in-chart logo is off.
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: css('--muted'), fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--line') },
    timeScale: { borderColor: css('--line'), fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
    crosshair: { mode: 0, vertLine: { color: '#4A4A4A', labelBackgroundColor: '#262626' }, horzLine: { color: '#4A4A4A', labelBackgroundColor: '#262626' } },
    handleScroll: false, handleScale: false,
    localization: { priceFormatter: (p) => nf(p, 0), timeFormatter: (t) => el.dataset.kind === 'day' ? relDay(t) : hhmm(Math.round((t - DAY0) / 60)) },
  };
}
const relDay = (t) => { const n = Math.round((DAY0 - t) / 86400); return n === 0 ? 'last session' : `${n} sessions ago`; };
function makeChart(el) {
  if (!window.LightweightCharts) return null;
  const c = window.LightweightCharts.createChart(el, chartOpts(el));
  c.timeScale().applyOptions({ tickMarkFormatter: (t) => el.dataset.kind === 'day' ? (Math.round((DAY0 - t) / 86400) ? `−${Math.round((DAY0 - t) / 86400)}d` : 'last') : hhmm(Math.round((t - DAY0) / 60)) });
  charts.push(c);
  return c;
}
function dailyChart(el, mk, withAverages) {
  const c = makeChart(el);
  if (!c) { el.innerHTML = lineSVG(mk.closes, { w: 600, h: 220 }); return; }
  const s = c.addCandlestickSeries({ upColor: css('--up'), downColor: css('--down'), borderVisible: false, wickUpColor: css('--up'), wickDownColor: css('--down'), priceLineVisible: false });
  s.setData(mk.daily);
  if (withAverages) for (const [n, col] of [[20, '--s2'], [50, '--s3']]) {
    const l = c.addLineSeries({ color: css(col), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    l.setData(mk.daily.map((d, i) => ({ time: d.time, value: sma(mk.closes, n, i) })).filter((d) => d.value !== null));
  }
  c.timeScale().fitContent();
}

// Plain SVG line, used where a full chart would be too much (and as a fallback).
function lineSVG(vals, { w = 320, h = 90, zero = false, cls = 'ln' } = {}) {
  const lo = Math.min(...vals, zero ? 0 : Infinity), hi = Math.max(...vals, zero ? 0 : -Infinity), pad = 6;
  const x = (i) => pad + (w - 2 * pad) * i / (vals.length - 1), y = (v) => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo || 1));
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="mini" preserveAspectRatio="none" aria-hidden="true">${zero ? `<path d="M0 ${y(0).toFixed(1)}H${w}" class="zero"/>` : ''}<path d="${d}" class="${cls}" vector-effect="non-scaling-stroke"/></svg>`;
}

let svgId = 0;
function payoffSVG(mk, legs, a, { w = 620, h = 270, compactAxis = false } = {}) {
  const span = Math.max(expectedMove(mk, mk.D.dte + 0.25) * 2.2, mk.S0 * 0.02);
  const lo = mk.S0 - span, hi = mk.S0 + span, n = 160, T = yearsAt(mk, ENTRY);
  const exp = [], now = [];
  for (let i = 0; i <= n; i++) {
    const S = lo + (hi - lo) * i / n;
    exp.push([S, atExpiry(legs, S)]);
    now.push([S, legs.reduce((s, l) => s + l.side * l.qty * (bs(l.type, S, l.K, T, R, l.iv0).price - l.fill), 0)]);
  }
  const ys = exp.concat(now).map((p) => p[1]);
  let ymin = Math.min(...ys, 0), ymax = Math.max(...ys, 0); const yp = (ymax - ymin) * 0.12 || 1; ymin -= yp; ymax += yp;
  const L = compactAxis ? 8 : 64, Rm = 12, Tm = 14, B = 26;
  const X = (S) => L + (w - L - Rm) * (S - lo) / (hi - lo), Y = (v) => Tm + (h - Tm - B) * (1 - (v - ymin) / (ymax - ymin));
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('');
  const id = `pf${++svgId}`, z = Y(0);
  const area = `${path(exp)}L${X(hi).toFixed(1)} ${z.toFixed(1)}L${X(lo).toFixed(1)} ${z.toFixed(1)}Z`;
  const yTicks = [ymax - yp, (ymax - yp + ymin + yp) / 2, ymin + yp].filter((v, i, arr) => arr.indexOf(v) === i);
  const xTicks = [lo + span * 0.2, mk.S0 - span / 2, mk.S0 + span / 2, hi - span * 0.2];
  const kfmt = (v) => (v < 0 ? '−' : '') + '₹' + (Math.abs(v) >= 1e5 ? nf(Math.abs(v) / 1e5, 1) + 'L' : Math.abs(v) >= 1e3 ? nf(Math.abs(v) / 1e3, 1) + 'k' : nf(Math.abs(v), 0));
  return `<svg viewBox="0 0 ${w} ${h}" class="payoff" role="img" aria-label="Payoff chart: profit or loss at each index level. Solid line is at expiry, dashed line is today.">
    <defs><clipPath id="${id}u"><rect x="0" y="0" width="${w}" height="${z.toFixed(1)}"/></clipPath><clipPath id="${id}d"><rect x="0" y="${z.toFixed(1)}" width="${w}" height="${h}"/></clipPath></defs>
    ${yTicks.map((v) => `<path d="M${L} ${Y(v).toFixed(1)}H${w - Rm}" class="gridl"/>${compactAxis ? '' : `<text x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" class="ax" text-anchor="end">${kfmt(v)}</text>`}`).join('')}
    ${xTicks.map((S) => `<text x="${X(S).toFixed(1)}" y="${h - 8}" class="ax" text-anchor="middle">${nf(Math.round(S / mk.I.step) * mk.I.step, 0)}</text>`).join('')}
    <path d="${area}" class="pf-up" clip-path="url(#${id}u)"/><path d="${area}" class="pf-down" clip-path="url(#${id}d)"/>
    <path d="M${L} ${z.toFixed(1)}H${w - Rm}" class="zero"/>
    <path d="M${X(mk.S0).toFixed(1)} ${Tm}V${h - B}" class="spot"/>
    <text x="${(X(mk.S0) + 6).toFixed(1)}" y="${Tm + 10}" class="ax">index ${nf(mk.S0, 0)}</text>
    <path d="${path(now)}" class="pf-now"/>
    <path d="${path(exp)}" class="pf-exp"/>
    ${a.bes.filter((b) => b > lo && b < hi).map((b) => `<circle cx="${X(b).toFixed(1)}" cy="${z.toFixed(1)}" r="4.5" class="be"/>`).join('')}
  </svg>`;
}

function readItems(mk) {
  const S = mk.S0, vix = mk.vix[ENTRY], mood = vixMood(vix), iv = vix / 100 * mk.I.volMul;
  const trend = mk.prev > mk.sma20 && mk.prev > mk.sma50 ? ['Uptrend', 'up', `Above its 20-day (${nf(mk.sma20, 0)}) and 50-day (${nf(mk.sma50, 0)}) averages: buyers have been in charge.`]
    : mk.prev < mk.sma20 && mk.prev < mk.sma50 ? ['Downtrend', 'down', `Below its 20-day (${nf(mk.sma20, 0)}) and 50-day (${nf(mk.sma50, 0)}) averages: sellers have been in charge.`]
    : ['Mixed', '', `Between its 20-day (${nf(mk.sma20, 0)}) and 50-day (${nf(mk.sma50, 0)}) averages: no clear direction.`];
  const gap = S / mk.prev - 1;
  const em1 = expectedMove(mk, 1), emX = expectedMove(mk, mk.D.dte + 0.25);
  const ratio = iv / mk.realized;
  const pcr = mk.oi.reduce((a, o) => a + o.PE, 0) / mk.oi.reduce((a, o) => a + o.CE, 0);
  return [
    { k: 'Trend', v: trend[0], cls: trend[1], t: trend[2] },
    { k: 'So far today', v: `${signedN(gap * 100)}%`, cls: tone(gap * 100), t: `${mk.I.short} is at ${nf(S, 2)} at 9:30, ${gap >= 0 ? 'up' : 'down'} ${nf(Math.abs(S - mk.prev), 0)} points from yesterday's close.` },
    { k: 'India VIX', v: `${nf(vix, 2)} · ${mood.label}`, cls: '', mood: mood.key, t: `The market's "fear gauge". ${mood.hint}` },
    { k: 'Expected move', v: `±${nf(em1, 0)} today`, cls: '', t: `Traders are pricing roughly ±${nf(em1, 0)} points for today and ±${nf(emX, 0)} by ${mk.D.dte === 0 ? "today's 3:30 expiry" : `expiry in ${mk.D.dte} days`}. About two days in three stay inside it.` },
    { k: 'Options vs recent moves', v: ratio > 1.15 ? 'Pricey' : ratio < 0.9 ? 'Cheap' : 'Fair', cls: '', t: `Options imply ${nf(iv * 100, 1)}% a year; the index actually moved ${nf(mk.realized * 100, 1)}% over the last 20 days.` },
    { k: 'Put–call ratio', v: nf(pcr, 2), cls: '', t: pcr > 1.15 ? 'More puts open than calls near the money, often read as support below.' : pcr < 0.85 ? 'More calls open than puts near the money, often read as a ceiling above.' : 'Calls and puts are roughly balanced.' },
  ];
}

function detailHTML(mk, sel) {
  const q = quote(mk, sel.type, sel.K), iv = ivAt(mk, sel.K, ENTRY), call = sel.type === 'CE';
  const T = mk.D.dte === 0 ? 'expires today at 3:30' : `expires in ${mk.D.dte} days`;
  const itm = call ? sel.K < mk.S0 : sel.K > mk.S0;
  return `<p class="dt-name">${mk.I.short} ${nf(sel.K, 0)} ${call ? 'call' : 'put'} <span class="muted">· ${T}</span></p>
    <p class="dt-tag ${itm ? 'itm' : ''}">${Math.abs(sel.K - mk.atm) < 1 ? 'At the money' : itm ? 'In the money: already worth something at expiry' : 'Out of the money: needs a move to pay off'}</p>
    <dl class="greeks">
      <div><dt>Premium</dt><dd>₹${nf(q.price)}</dd><p>Price per unit. One lot is ${mk.I.lot} units, so about ${rupees(q.price * mk.I.lot)} a lot.</p></div>
      <div><dt>Delta</dt><dd>${nf(q.delta)}</dd><p>${call ? `Gains about ₹${nf(q.delta)} for each point the index rises.` : `Gains about ₹${nf(-q.delta)} for each point the index falls.`}</p></div>
      <div><dt>Theta</dt><dd class="down">${nf(q.theta)}</dd><p>Loses about ₹${nf(Math.abs(q.theta))} a day just from time passing.</p></div>
      <div><dt>Vega</dt><dd>${nf(q.vega)}</dd><p>Gains about ₹${nf(q.vega)} if expected volatility rises one point.</p></div>
      <div><dt>IV</dt><dd>${nf(iv * 100, 1)}%</dd><p>Implied volatility: the yearly swing this price assumes.</p></div>
    </dl>`;
}

function metricsHTML(mk, a) {
  const money = (v) => !Number.isFinite(v) ? '<span class="up">No limit</span>' : `<span class="${tone(v)}">${signed(v)}</span>`;
  return `<dl class="metrics">
    <div><dt>${a.flow < 0 ? 'You pay' : 'You receive'}</dt><dd>${rupees(Math.abs(a.flow))}</dd></div>
    <div><dt>Max profit</dt><dd>${money(a.maxProfit)}</dd></div>
    <div><dt>Max loss</dt><dd>${!Number.isFinite(a.maxLoss) ? '<span class="down">No limit</span>' : `<span class="down">${rupees(a.maxLoss)}</span>`}</dd></div>
    <div><dt>Breakeven${a.bes.length > 1 ? 's' : ''}</dt><dd>${a.bes.map((b) => nf(b, 0)).join(' / ') || 'none'}</dd></div>
    <div><dt>Chance of profit</dt><dd>${nf(a.pop * 100, 0)}%</dd></div>
    <div><dt>Theta</dt><dd class="${tone(a.greeks.theta)}">${signed(a.greeks.theta)}/day</dd></div>
  </dl>`;
}

// ---------- the step views (wide, interactive) ----------
const views = [
  // 1. Pick a day
  (body) => {
    const mk = mkNow();
    body.innerHTML = `<div class="v-day">
      <div class="seg" role="group" aria-label="Index">${Object.entries(INDEX).map(([k, I]) => `<button type="button" class="seg-b" data-k="ix-${k}" aria-pressed="${st.ix === k}">${I.name}<small>lot ${I.lot}</small></button>`).join('')}</div>
      <div class="days" role="group" aria-label="Sample day">${Object.entries(DAYS).map(([k, D]) => `<button type="button" class="dayc" data-k="day-${k}" aria-pressed="${st.day === k}"><b>${D.label}</b><span>${D.mood}</span><small>${D.weekday} · ${D.dte === 0 ? 'weekly expiry today' : `weekly expiry in ${D.dte} days`}</small></button>`).join('')}</div>
      <div class="chart-box"><div class="chart-cap"><span>${mk.I.name} · daily candles before ${DAYS[st.day].label}</span><span class="muted">made-up prices</span></div><div class="chart" data-kind="day" style="height:250px"></div></div>
    </div>`;
    dailyChart(body.querySelector('.chart'), mk, false);
    body.querySelectorAll('[data-k^="ix-"]').forEach((b) => b.onclick = () => { st.ix = b.dataset.k.slice(3); st.sel = null; resetPlan(); render(); });
    body.querySelectorAll('[data-k^="day-"]').forEach((b) => b.onclick = () => { st.day = b.dataset.k.slice(4); st.sel = null; resetPlan(); render(); });
  },
  // 2. Read the market
  (body) => {
    const mk = mkNow(), items = readItems(mk);
    body.innerHTML = `<div class="v-read">
      <div class="chart-box"><div class="chart-cap"><span>${mk.I.name} · daily</span><span class="legend"><i style="--c:var(--s2)"></i>20-day avg <i style="--c:var(--s3)"></i>50-day avg</span></div><div class="chart" data-kind="day" style="height:380px"></div></div>
      <ul class="read">${items.map((i) => `<li><div class="read-k">${i.k}</div><div class="read-v ${i.cls}">${i.mood ? `<span class="mood ${i.mood}"></span>` : ''}${i.v}</div><p>${i.t}</p></li>`).join('')}</ul>
    </div>`;
    dailyChart(body.querySelector('.chart'), mk, true);
  },
  // 3. Option chain
  (body) => {
    const mk = mkNow(), sel = st.sel || { type: 'CE', K: mk.atm };
    const maxOI = Math.max(...mk.oi.flatMap((o) => [o.CE, o.PE]));
    const rows = mk.strikes.map((K, i) => {
      const c = quote(mk, 'CE', K), p = quote(mk, 'PE', K), o = mk.oi[i];
      const btn = (type, q) => { const on = sel.type === type && sel.K === K; return `<button type="button" class="px${on ? ' on' : ''}" data-k="${type}-${K}" aria-pressed="${on}" aria-label="${nf(K, 0)} ${type === 'CE' ? 'call' : 'put'}, ₹${nf(q.price)}">${nf(round05(q.price))}</button>`; };
      const spotRow = i > 0 && mk.strikes[i - 1] < mk.S0 && K >= mk.S0 ? `<tr class="spotrow" aria-label="Index now"><td colspan="5"><span>${mk.I.short} ${nf(mk.S0, 2)}</span></td></tr>` : '';
      return `${spotRow}<tr class="${K === mk.atm ? 'atm' : ''}">
        <td class="oi ${K < mk.S0 ? 'itm' : ''}"><span class="bar" style="--w:${(o.CE / maxOI * 100).toFixed(0)}"></span>${compact(o.CE)}</td>
        <td class="${K < mk.S0 ? 'itm' : ''}">${btn('CE', c)}</td>
        <th scope="row">${nf(K, 0)}</th>
        <td class="${K > mk.S0 ? 'itm' : ''}">${btn('PE', p)}</td>
        <td class="oi ${K > mk.S0 ? 'itm' : ''}"><span class="bar r" style="--w:${(o.PE / maxOI * 100).toFixed(0)}"></span>${compact(o.PE)}</td></tr>`;
    }).join('');
    body.innerHTML = `<div class="v-chain">
      <div class="chain-wrap"><table class="chain"><caption class="chain-cap">${mk.I.short} · expiry ${mk.D.dte === 0 ? 'today' : `in ${mk.D.dte} days`} · 9:30</caption>
        <thead><tr><th colspan="2" class="side">Calls <small>(index up)</small></th><th></th><th colspan="2" class="side">Puts <small>(index down)</small></th></tr>
        <tr><th>OI</th><th>Price</th><th>Strike</th><th>Price</th><th>OI</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="hint">Shaded cells are in the money. OI (open interest) is how many contracts are open.</p></div>
      <aside class="detail" aria-live="polite">${detailHTML(mk, sel)}<button type="button" class="btn sm" data-k="to-build">Build a trade with this →</button></aside>
    </div>`;
    body.querySelectorAll('.px').forEach((b) => b.onclick = () => { const [type, K] = b.dataset.k.split('-'); st.sel = { type, K: +K }; resetPlan(); render(); });
    body.querySelector('[data-k="to-build"]').onclick = () => go(3);
  },
  // 4. Strategy builder
  (body) => {
    const { mk, legs, a } = plan(), sel = st.sel || { type: 'CE', K: mk.atm };
    body.innerHTML = `<div class="v-build">
      <div class="build-bar">
        <div class="seg" role="group" aria-label="Strategy">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="seg-b" data-k="pre-${k}" aria-pressed="${st.preset === k}">${p.label(sel)}</button>`).join('')}</div>
        <div class="lots"><span id="lots-l">Lots</span><button type="button" class="btn ghost sm" data-k="lots-" aria-label="One lot fewer" ${st.lots <= 1 ? 'disabled' : ''}>−</button><b aria-labelledby="lots-l">${st.lots}</b><button type="button" class="btn ghost sm" data-k="lots+" aria-label="One lot more" ${st.lots >= 5 ? 'disabled' : ''}>+</button></div>
      </div>
      <table class="legs"><thead><tr><th>Side</th><th>Contract</th><th>Qty</th><th>Fill price</th></tr></thead><tbody>
        ${legs.map((l) => `<tr><td><span class="side-tag ${l.side > 0 ? 'b' : 's'}">${l.side > 0 ? 'Buy' : 'Sell'}</span></td><td>${legName(mk, l)}</td><td>${l.qty}</td><td>₹${nf(l.fill)} <small class="muted">${l.side > 0 ? 'at ask' : 'at bid'}</small></td></tr>`).join('')}
      </tbody></table>
      <div class="build-main">
        <figure class="payoff-box">${payoffSVG(mk, legs, a)}<figcaption><span class="legend"><i style="--c:var(--accent)"></i>At expiry <i class="dash"></i>Today <i class="dot"></i>Breakeven</span></figcaption></figure>
        ${metricsHTML(mk, a)}
      </div>
    </div>`;
    body.querySelectorAll('[data-k^="pre-"]').forEach((b) => b.onclick = () => { st.preset = b.dataset.k.slice(4); resetPlan(); render(); });
    body.querySelector('[data-k="lots-"]').onclick = () => { st.lots = Math.max(1, st.lots - 1); resetPlan(); render(); };
    body.querySelector('[data-k="lots+"]').onclick = () => { st.lots = Math.min(5, st.lots + 1); resetPlan(); render(); };
  },
  // 5. Paper trade
  (body) => {
    const p = plan(), { mk, legs, a } = p;
    body.innerHTML = `<div class="v-ticket">
      <form class="ticket" novalidate>
        <div class="tk-head"><b>Order ticket</b><span class="pill warn">Paper trade</span></div>
        <table class="legs"><tbody>${legs.map((l) => `<tr><td><span class="side-tag ${l.side > 0 ? 'b' : 's'}">${l.side > 0 ? 'Buy' : 'Sell'}</span></td><td>${legName(mk, l)}</td><td>${l.qty} @ ₹${nf(l.fill)}</td></tr>`).join('')}</tbody></table>
        <p class="tk-sum"><span>${a.flow < 0 ? 'Premium paid' : 'Premium received'} <b>${rupees(Math.abs(a.flow))}</b></span><span>Charges <b>${rupees(a.entryCharges)}</b></span><span>Money blocked <b>${rupees(a.blocked)}</b></span></p>
        <label class="fld"><span>Why are you taking this trade? <em>required</em></span><textarea rows="3" data-k="thesis" ${st.placed ? 'readonly' : ''}>${esc(p.thesis)}</textarea></label>
        <label class="fld"><span>What would prove you wrong?</span><input type="text" data-k="wrong" value="${esc(p.wrong)}" ${st.placed ? 'readonly' : ''}></label>
        <div class="fld-row">
          <label class="fld"><span>Stop-loss: exit if the loss reaches (₹)</span><input type="number" inputmode="numeric" min="100" step="100" data-k="sl" value="${Math.round(p.sl)}" ${st.placed ? 'readonly' : ''}></label>
          <label class="fld"><span>Target: exit if the profit reaches (₹)</span><input type="number" inputmode="numeric" min="100" step="100" data-k="tp" value="${Math.round(p.tp)}" ${st.placed ? 'readonly' : ''}></label>
        </div>
        <div class="tk-foot">${st.placed
          ? `<p class="placed" role="status"><span class="led ok" aria-hidden="true"></span>Placed on paper at 9:30. Nothing real was sent anywhere.</p>`
          : `<p class="muted small" data-k="need">${p.thesis.trim() ? 'The app asks for a reason before it places a trade.' : '<span class="down">Write a reason first. The app won\'t place a trade without one.</span>'}</p><button type="submit" class="btn buy" data-k="place" ${p.thesis.trim() ? '' : 'disabled'}>Place paper trade</button>`}</div>
      </form>
    </div>`;
    const form = body.querySelector('form');
    form.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (k === 'thesis') {
        st.thesis = e.target.value;
        const ok = !!st.thesis.trim(), btn = form.querySelector('[data-k="place"]');
        if (btn) btn.disabled = !ok;
        const need = form.querySelector('[data-k="need"]');
        if (need) need.innerHTML = ok ? 'The app asks for a reason before it places a trade.' : '<span class="down">Write a reason first. The app won\'t place a trade without one.</span>';
      } else if (k === 'wrong') st.wrong = e.target.value;
      else if (k === 'sl' || k === 'tp') { const v = +e.target.value; st[k] = v > 0 ? v : null; }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); if (!st.placed && plan().thesis.trim()) { place(); render(); } });
  },
  // 6. Time forward and review
  (body) => {
    if (!st.placed) place();
    const p = plan(), { mk, legs } = p;
    const motion = !reducedMotion();
    body.innerHTML = `<div class="v-time">
      <div class="time-charts">
        <div class="chart-box"><div class="chart-cap"><span>${mk.I.name} · today, minute by minute</span><span class="muted" data-k="spot"></span></div><div class="chart" data-kind="min" style="height:190px"></div></div>
        <div class="chart-box"><div class="chart-cap"><span>Your profit or loss</span><span class="muted">after the bid–ask spread</span></div><div class="chart" data-kind="min" style="height:160px"></div></div>
      </div>
      <div class="time-side">
        <div class="clock"><span class="muted">Replay time</span><b data-k="clock"></b></div>
        <div class="pnl"><span class="muted" data-k="pnl-k">Open P&amp;L</span><b data-k="pnl"></b><small data-k="status"></small></div>
        <div class="time-ctl" role="group" aria-label="Move time">
          ${motion ? '<button type="button" class="btn sm" data-k="play">Play</button>' : ''}
          <button type="button" class="btn ghost sm" data-k="t15">+15 min</button>
          <button type="button" class="btn ghost sm" data-k="t60">+1 hour</button>
          <button type="button" class="btn ghost sm" data-k="tclose">To the close</button>
        </div>
        <div class="review" data-k="review" aria-live="polite"></div>
      </div>
    </div>`;
    const [elI, elP] = body.querySelectorAll('.chart');
    const cI = makeChart(elI), cP = makeChart(elP);
    let sI, sP;
    const minuteTime = (m) => DAY0 + m * 60;
    if (cI) {
      sI = cI.addLineSeries({ color: css('--fg'), lineWidth: 2, priceLineVisible: false });
      const ghost = cI.addLineSeries({ color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ghost.setData(mk.path.map((v, m) => ({ time: minuteTime(m), value: mk.path[Math.min(m, ENTRY)] }))); // fixes the time axis to the whole day
      cI.timeScale().fitContent();
    }
    if (cP) {
      sP = cP.addBaselineSeries({ baseValue: { type: 'price', price: 0 }, topLineColor: css('--up'), bottomLineColor: css('--down'), topFillColor1: css('--up-soft'), topFillColor2: 'rgba(0,0,0,0)', bottomFillColor1: 'rgba(0,0,0,0)', bottomFillColor2: css('--down-soft'), lineWidth: 2, priceLineVisible: false });
      const ghost = cP.addLineSeries({ color: 'rgba(0,0,0,0)', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ghost.setData(mk.path.map((_, m) => ({ time: minuteTime(m), value: 0 })));
      cP.applyOptions({ localization: { ...chartOpts(elP).localization, priceFormatter: (v) => signed(v) } });
      cP.timeScale().fitContent();
    }
    const series = [];
    for (let m = ENTRY; m <= MIN; m++) series.push(markAt(mk, legs, m).pnl);
    const pnlAt = (m) => st.closedAt !== null && m > st.closedAt ? series[st.closedAt - ENTRY] : series[m - ENTRY];
    const q = (k) => body.querySelector(`[data-k="${k}"]`);
    const update = () => {
      const m = st.minute, pnl = pnlAt(m), done = m >= MIN;
      if (sI) { sI.setData(mk.path.slice(0, m + 1).map((v, i) => ({ time: minuteTime(i), value: v }))); sI.setMarkers([{ time: minuteTime(ENTRY), position: 'belowBar', color: css('--accent'), shape: 'arrowUp', text: 'entry' }, ...(st.closedAt !== null && st.closedAt <= m ? [{ time: minuteTime(st.closedAt), position: 'aboveBar', color: css('--warn'), shape: 'arrowDown', text: 'exit' }] : [])]); }
      if (sP) sP.setData(Array.from({ length: m - ENTRY + 1 }, (_, i) => ({ time: minuteTime(ENTRY + i), value: pnlAt(ENTRY + i) })));
      if (!cI) { elI.innerHTML = lineSVG(mk.path.slice(0, m + 1), { w: 600, h: 190 }); elP.innerHTML = lineSVG(series.slice(0, m - ENTRY + 1).concat([]), { w: 600, h: 160, zero: true, cls: pnl >= 0 ? 'ln up' : 'ln down' }); }
      q('clock').textContent = hhmm(m);
      q('spot').textContent = `${mk.I.short} ${nf(mk.path[m], 2)}`;
      const pe = q('pnl'); pe.textContent = signed(pnl); pe.className = tone(pnl);
      q('pnl-k').textContent = done || (st.closedAt !== null && st.closedAt <= m) ? 'P&L before charges' : 'Open P&L';
      q('status').textContent = st.closedAt !== null && st.closedAt <= m ? `${st.closeWhy} at ${hhmm(st.closedAt)}. Position closed.` : done ? (mk.D.dte === 0 ? 'Expired at 3:30 and settled.' : 'Market closed. Position still open.') : `Stop-loss ${rupees(-p.sl)} · target ${rupees(p.tp)}`;
      q('t15').disabled = q('t60').disabled = q('tclose').disabled = done;
      if (q('play')) { q('play').disabled = done; q('play').textContent = playing ? 'Pause' : 'Play'; }
      q('review').innerHTML = done ? reviewHTML(p) : `<p class="muted small">Your stop-loss and target are watched every minute. The review appears at 3:30.</p>`;
      header();
      if (done) { stopPlay(); if (!st.finished) guide(); }
    };
    const jump = (to) => { stopPlay(); advanceTo(to); update(); };
    q('t15').onclick = () => jump(st.minute + 15);
    q('t60').onclick = () => jump(st.minute + 60);
    q('tclose').onclick = () => jump(MIN);
    if (q('play')) q('play').onclick = () => {
      if (playing) { stopPlay(); update(); return; }
      // Runs only after a click, and stops at the close.
      playing = setInterval(() => { advanceTo(st.minute + 3); update(); if (st.minute >= MIN) stopPlay(); }, 70);
      update();
    };
    current = { update };
    update();
  },
];

function place() {
  const p = plan();
  if (!p.thesis.trim()) st.thesis = defaultsFor(p.mk, st, p.a).thesis;
  st.placed = true; st.minute = ENTRY; st.closedAt = null; st.closeWhy = null;
}
function stopPlay() { if (playing) { clearInterval(playing); playing = null; } }

function result(p) {
  const { mk, legs, a } = p;
  const m = st.closedAt ?? st.minute, mark = markAt(mk, legs, m);
  const exitCharges = charges(legs.filter((_, i) => !mark.exits[i].settle).map((l, i) => ({ side: -l.side, price: mark.exits[i].exit, qty: l.qty })));
  const totalCharges = a.entryCharges + exitCharges;
  return { m, mark, totalCharges, net: mark.pnl - totalCharges, move: mk.path[m] - mk.S0 };
}

function reviewHTML(p) {
  const { mk } = p, r = result(p), rows = [['Index move', r.mark.spot], ['Time decay', r.mark.time], ['Volatility change', r.mark.vol], ['Bid–ask spread', r.mark.spread]];
  const worked = r.net > 0;
  return `<h4>End-of-session review</h4>
    <dl class="rv">
      <div><dt>Profit or loss</dt><dd class="${tone(r.mark.pnl)}">${signed(r.mark.pnl)}</dd></div>
      <div><dt>Charges</dt><dd>${rupees(-r.totalCharges)}</dd></div>
      <div class="rv-net"><dt>Net result</dt><dd class="${tone(r.net)}">${signed(r.net)}</dd></div>
      <div><dt>Paper account</dt><dd>${rupees(START_BALANCE + r.net)}</dd></div>
    </dl>
    <p class="rv-k">What moved it</p>
    <ul class="why">${rows.map(([k, v]) => `<li><span>${k}</span><b class="${tone(v)}">${signed(v)}</b></li>`).join('')}</ul>
    <p class="rv-k">Your reason</p><blockquote>${esc(p.thesis)}</blockquote>
    <p class="small">${mk.I.short} went ${r.move >= 0 ? 'up' : 'down'} ${nf(Math.abs(r.move), 0)} points while you held it${st.closedAt !== null ? ` (${st.closeWhy.toLowerCase()} at ${hhmm(st.closedAt)})` : ''}. ${worked ? 'Did it work for the reason you wrote, or by luck?' : 'Was the reason wrong, or the timing?'} In the app you answer these prompts and save them with the session.</p>`;
}

// ---------- frame: header, guide, navigation ----------
let root, els = {};
function header() {
  if (!els.top) return;
  const mk = mkNow(), m = st.step === 5 ? st.minute : ENTRY, S = mk.path[m], ch = S - mk.prev, vix = mk.vix[m], mood = vixMood(vix);
  let acct = START_BALANCE;
  if (st.placed && st.step === 5) { const p = plan(), r = result(p); acct += r.net; }
  els.top.innerHTML = `<span class="scr-brand"><img src="assets/favicon-32x32.png" alt="" width="18" height="18">Optionwise</span>
    <span class="tick on"><span class="n">${mk.I.name}</span><span class="v">${nf(S, 2)}</span><span class="c ${tone(ch)}">${signedN(ch)} (${signedN(ch / mk.prev * 100)}%)</span></span>
    <span class="vix ${mood.key}"><span class="n">India VIX <span class="mood">${mood.label}</span></span><span class="v"><b>${nf(vix, 2)}</b></span></span>
    <span class="pill warn">Replay · sample data</span>
    <span class="acct"><span class="k">Paper account</span><span class="v">${rupees(acct)}</span></span>`;
}

const TABS = ['Learn', 'Markets', 'Option chain', 'Strategy builder', 'Replay', 'Paper account'];
const TAB_FOR_STEP = [4, 1, 2, 3, 3, 5];

function guide() {
  const s = STEPS[st.step], ended = st.finished;
  els.dots.innerHTML = STEPS.map((x, i) => `<li><button type="button" data-step="${i}" ${i === st.step && !ended ? 'aria-current="step"' : ''} class="${i < st.step || ended ? 'seen' : ''}"><span>${i + 1}</span>${x.short}</button></li>`).join('');
  els.dots.querySelectorAll('button').forEach((b) => b.onclick = () => go(+b.dataset.step));
  if (ended) {
    els.text.innerHTML = `<p class="step-n">Done</p><h3 tabindex="-1">That was one session</h3>
      <p>In the app it's the same loop on real past NSE days: pick a day, read it, choose a trade, write why, step through, review. Then do it again.</p>
      <div class="end-card"><p class="end-title">Want it with real data? Download it free</p><div class="cta" data-cta="end"><a class="btn" href="https://github.com/yaminichandrakj/optionwise/releases/latest/download/Optionwise.exe">Download for Windows</a></div>
      <button type="button" class="linkbtn" data-k="replay">Replay the demo</button></div>
      <p class="star-line">If this helped you learn, a star helps others find it. <a class="link" href="https://github.com/yaminichandrakj/optionwise">Star on GitHub</a></p>`;
    fillCta(els.text.querySelector('.cta'));
    els.text.querySelector('[data-k="replay"]').onclick = replay;
  } else {
    els.text.innerHTML = `<p class="step-n">Step ${st.step + 1} of ${STEPS.length}</p><h3 tabindex="-1">${s.title}</h3><p>${s.text}</p><p class="tip"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 0-2.5 8.2V12h5V9.7A4.5 4.5 0 0 0 8 1.5zM6 14.5h4"/></svg>${s.tip}</p>`;
  }
  els.back.disabled = st.step === 0 && !ended;
  els.next.hidden = ended;
  els.next.textContent = st.step === 4 && !st.placed ? 'Place and continue' : st.step === 5 ? (st.minute >= MIN ? 'Finish' : 'Skip to the close') : 'Next';
}

function render() {
  const keep = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.k : null;
  charts.forEach((c) => c.remove()); charts = []; current = null;
  els.tabs.innerHTML = TABS.map((t, i) => `<span class="${i === TAB_FOR_STEP[st.step] ? 'on' : ''}">${t}</span>`).join('');
  views[st.step](els.body);
  header(); guide();
  if (keep) root.querySelector(`[data-k="${CSS.escape(keep)}"]`)?.focus();
}

function go(i) {
  stopPlay();
  st.finished = false;
  st.step = Math.max(0, Math.min(STEPS.length - 1, i));
  render();
  els.body.scrollTop = 0;
}
function next() {
  if (st.step === 4 && !st.placed) { place(); }
  if (st.step === 5) {
    if (st.minute < MIN) { stopPlay(); advanceTo(MIN); current?.update(); guide(); return; }
    st.finished = true; guide(); els.text.querySelector('h3').focus(); return;
  }
  go(st.step + 1);
}
function back() {
  if (st.finished) { st.finished = false; guide(); return; }
  go(st.step - 1);
}
function replay() {
  stopPlay(); st = fresh(); render();
  els.next.focus();
  root.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function buildWide() {
  root.className = 'demo-root wide';
  root.innerHTML = `<div class="demo">
    <div class="screen" role="region" aria-label="Sample Optionwise window">
      <div class="scr-chrome" aria-hidden="true"><i></i><i></i><i></i><span>Optionwise · replay mode</span></div>
      <div class="scr-top"></div>
      <div class="scr-tabs" aria-hidden="true"></div>
      <div class="scr-body"></div>
    </div>
    <aside class="guide" aria-label="Demo guide">
      <ol class="dots" aria-label="Demo steps"></ol>
      <div class="guide-text" aria-live="polite"></div>
      <div class="guide-nav"><button type="button" class="btn ghost" data-nav="back">Back</button><button type="button" class="btn" data-nav="next">Next</button></div>
      <p class="kbd muted small">Tip: the <kbd>←</kbd> and <kbd>→</kbd> keys also move between steps.</p>
    </aside>
  </div>`;
  els = { top: root.querySelector('.scr-top'), tabs: root.querySelector('.scr-tabs'), body: root.querySelector('.scr-body'), dots: root.querySelector('.dots'), text: root.querySelector('.guide-text'), back: root.querySelector('[data-nav="back"]'), next: root.querySelector('[data-nav="next"]') };
  els.back.onclick = back; els.next.onclick = next;
  render();
}

// ---------- narrow screens: the same six steps, read-only, top to bottom ----------
function buildNarrow() {
  stopPlay(); charts.forEach((c) => c.remove()); charts = []; els = {};
  root.className = 'demo-root narrow';
  const s = fresh(); const saved = st; st = s;
  const mk = mkNow(), p = plan(), { legs, a } = p;
  place(); advanceTo(MIN);
  const r = result(plan()), sel = { type: 'CE', K: mk.atm }, q = quote(mk, 'CE', mk.atm);
  const pnl = []; for (let m = ENTRY; m <= MIN; m++) pnl.push(st.closedAt !== null && m > st.closedAt ? pnl[pnl.length - 1] : markAt(mk, legs, m).pnl);
  const items = readItems(mk);
  const chainRows = mk.strikes.slice(4, 9).map((K) => `<tr class="${K === mk.atm ? 'atm' : ''}"><td class="${K < mk.S0 ? 'itm' : ''}${K === sel.K ? ' on' : ''}">${nf(round05(quote(mk, 'CE', K).price))}</td><th>${nf(K, 0)}</th><td class="${K > mk.S0 ? 'itm' : ''}">${nf(round05(quote(mk, 'PE', K).price))}</td></tr>`).join('');
  const shots = [
    `<div class="n-shot"><div class="n-days">${Object.values(DAYS).map((D, i) => `<span class="${i === 0 ? 'on' : ''}"><b>${D.label}</b>${D.mood}</span>`).join('')}</div>${lineSVG(mk.closes, { w: 320, h: 80 })}<p class="n-cap muted small">${mk.I.name}, 70 sample sessions before day A</p></div>`,
    `<ul class="read n-shot">${items.slice(0, 4).map((i) => `<li><div class="read-k">${i.k}</div><div class="read-v ${i.cls}">${i.mood ? `<span class="mood ${i.mood}"></span>` : ''}${i.v}</div><p>${i.t}</p></li>`).join('')}</ul>`,
    `<div class="n-shot"><table class="chain n-chain"><thead><tr><th>Call</th><th>Strike</th><th>Put</th></tr></thead><tbody>${chainRows}</tbody></table>
      <dl class="greeks compact"><div><dt>Premium</dt><dd>₹${nf(q.price)}</dd></div><div><dt>Delta</dt><dd>${nf(q.delta)}</dd></div><div><dt>Theta</dt><dd class="down">${nf(q.theta)}</dd></div></dl>
      <p class="small muted">Tapped: the ${nf(mk.atm, 0)} call. It gains about ₹${nf(q.delta)} per index point and loses about ₹${nf(Math.abs(q.theta))} a day to time.</p></div>`,
    `<div class="n-shot">${payoffSVG(mk, legs, a, { w: 420, h: 230, compactAxis: true })}${metricsHTML(mk, a)}</div>`,
    `<div class="n-shot"><p class="small"><span class="side-tag b">Buy</span> ${legName(mk, legs[0])} · ${legs[0].qty} @ ₹${nf(legs[0].fill)}</p><blockquote>${esc(p.thesis)}</blockquote><p class="small muted">Exit plan: stop-loss at ${rupees(-p.sl)}, target ${rupees(p.tp)}.</p></div>`,
    `<div class="n-shot">${lineSVG(pnl, { w: 320, h: 90, zero: true, cls: r.net >= 0 ? 'ln up' : 'ln down' })}<p class="n-cap muted small">Profit or loss from 9:30 to 3:30</p>${reviewHTML(plan())}</div>`,
  ];
  root.innerHTML = `<ol class="n-steps">${STEPS.map((x, i) => `<li><p class="step-n">Step ${i + 1} of 6</p><h3>${x.title}</h3><p class="muted">${x.text}</p>${shots[i]}</li>`).join('')}</ol>
    <div class="end-card n-end"><p class="end-title">${device === 'phone' ? 'Try it yourself on your laptop' : 'Want it with real data? Download it free'}</p><p class="muted small">The interactive version of this demo needs a wider screen. The app itself is free for Windows.</p><div class="cta" data-cta="narrow-end"><a class="btn" href="https://github.com/yaminichandrakj/optionwise/releases/latest/download/Optionwise.exe">Download for Windows</a></div></div>
    <p class="star-line">If this helped you learn, a star helps others find it. <a class="link" href="https://github.com/yaminichandrakj/optionwise">Star on GitHub</a></p>`;
  fillCta(root.querySelector('.cta'));
  st = saved;
}

function init() {
  root = document.getElementById('demo-root');
  if (!root) return;
  const wideMQ = matchMedia('(min-width: 1000px)');
  let mode = null;
  const pick = () => {
    const want = device !== 'phone' && wideMQ.matches ? 'wide' : 'narrow';
    if (want === mode) return;
    mode = want;
    if (mode === 'wide') buildWide(); else buildNarrow();
  };
  wideMQ.addEventListener('change', pick);
  pick();
  root.addEventListener('keydown', (e) => {
    if (mode !== 'wide' || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); if (!els.next.hidden) next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (!els.back.disabled) back(); }
  });
}
init();
