// Position math and the payoff chart, shared by the strategy builder and the paper account.
import { el, inr0, srs } from './util.js';
import { bs, npdf, yearsTo } from './bs.js';

// leg: { type, strike, expiry, qty (signed units), entry, iv (decimal) }
// Value of the whole position at index level x, `days` from now, or at the first expiry when atExpiry.
export function pnlAt(legs, x, { days = 0, atExpiry = false, r = 0.06, spot, ivShiftPct = 0 } = {}) {
  const first = Math.min(...legs.map((l) => yearsTo(l.expiry)));
  const shift = atExpiry ? first : Math.min(days / 365, first);
  let p = 0;
  for (const l of legs) {
    const T = Math.max(yearsTo(l.expiry) - shift, 0);
    let v = bs(l.type, x, l.strike, T, r, Math.max(0.01, l.iv + ivShiftPct / 100)).price;
    // Keep today's curve anchored to the market price: carry the gap between market and model, shrinking with time.
    if (spot && l.adj) { const T0 = yearsTo(l.expiry); v += T0 > 0 ? l.adj * (T / T0) : 0; }
    p += l.qty * (v - l.entry);
  }
  return p;
}

export function analyze(legs, spot, atmIv, r = 0.06) {
  if (!legs.length) return null;
  const first = Math.min(...legs.map((l) => yearsTo(l.expiry)));
  const f = (x) => pnlAt(legs, x, { atExpiry: true, r });
  let maxP = -Infinity, maxL = Infinity;
  for (let x = spot * 0.4; x <= spot * 1.8; x += spot * 0.0025) { const v = f(x); maxP = Math.max(maxP, v); maxL = Math.min(maxL, v); }
  const up = f(spot * 2.2) - f(spot * 1.8), down = f(spot * 0.05) - f(spot * 0.4);
  const unlimitedUp = up > Math.abs(spot) * 0.01, unlimitedLoss = up < -Math.abs(spot) * 0.01;
  if (unlimitedUp) maxP = Infinity; if (unlimitedLoss) maxL = -Infinity;
  if (down < 0) maxL = Math.min(maxL, f(spot * 0.05));
  if (down > 0) maxP = Math.max(maxP, f(spot * 0.05));
  const be = []; let prev = null;
  for (let x = spot * 0.75; x <= spot * 1.25; x += spot * 0.0002) { const v = f(x); if (prev && Math.sign(v) !== Math.sign(prev[1]) && v !== 0 && prev[1] !== 0) be.push(prev[0] + (x - prev[0]) * (-prev[1]) / (v - prev[1])); prev = [x, v]; }
  let pop = 0, ev = 0; const v = atmIv, T = first;
  for (let z = -5; z <= 5; z += 0.01) { const w = npdf(z) * 0.01; const St = spot * Math.exp((r - v * v / 2) * T + v * Math.sqrt(T) * z); const p = f(St); if (p > 0) pop += w; ev += w * p; }
  return { maxP, maxL, be, pop, ev, firstExpiryYears: first };
}

export function greeks(legs, spot, r = 0.06) {
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of legs) { const b = bs(l.type, spot, l.strike, yearsTo(l.expiry), r, l.iv); g.delta += b.delta * l.qty; g.gamma += b.gamma * l.qty; g.theta += b.theta * l.qty; g.vega += b.vega * l.qty; }
  return g;
}

const NS = 'http://www.w3.org/2000/svg';
const mk = (t, a, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };

// Draws expiry (green/red) and "now" (dashed) curves with the expected-move band. Returns nothing.
export function drawPayoff(box, legs, { spot, iv, days = 0, r = 0.06, nowLabel = 'Today', tipBox, ivShiftPct = 0 }) {
  const W = Math.max(320, box.clientWidth || 800), H = Math.round(Math.min(380, Math.max(240, W * 0.4)));
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Profit and loss by index level' });
  if (!legs.length) { svg.append(mk('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: 'var(--muted)' }, 'Add a leg to see the payoff')); box.replaceChildren(svg); return; }
  const T = Math.min(...legs.map((l) => yearsTo(l.expiry))); const scenarioIv = Math.max(0.01, iv + ivShiftPct / 100); const mv = spot * scenarioIv * Math.sqrt(Math.max(T, 1 / 365));
  const ks = legs.map((l) => l.strike);
  const lo = Math.min(spot - 2.6 * mv, ...ks.map((k) => k - spot * 0.006), spot * 0.985), hi = Math.max(spot + 2.6 * mv, ...ks.map((k) => k + spot * 0.006), spot * 1.015);
  const N = 240, xs = Array.from({ length: N }, (_, i) => lo + (hi - lo) * i / (N - 1));
  const yE = xs.map((x) => pnlAt(legs, x, { atExpiry: true, r })), yN = xs.map((x) => pnlAt(legs, x, { days, r, spot, ivShiftPct }));
  let ymin = Math.min(0, ...yE, ...yN), ymax = Math.max(0, ...yE, ...yN); const pad = (ymax - ymin) * 0.08 || 1000; ymin -= pad; ymax += pad;
  const fmtY = (v) => { const a = Math.abs(v); return (v < 0 ? '−' : '') + '₹' + (a >= 1e5 ? (a / 1e5).toFixed(a >= 1e6 ? 0 : 1) + 'L' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : Math.round(a)); };
  const yt = niceTicks(ymin, ymax, 5);
  const m = { l: Math.max(...yt.map((t) => fmtY(t).length)) * 7.2 + 12, r: 12, t: 16, b: 28 };
  const X = (x) => m.l + (x - lo) / (hi - lo) * (W - m.l - m.r), Y = (y) => m.t + (ymax - y) / (ymax - ymin) * (H - m.t - m.b);
  svg.append(mk('rect', { x: X(Math.max(lo, spot - mv)), y: m.t, width: X(Math.min(hi, spot + mv)) - X(Math.max(lo, spot - mv)), height: H - m.t - m.b, fill: 'var(--band)' }));
  for (const t of yt) { svg.append(mk('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: t === 0 ? 'var(--muted)' : 'var(--grid)' }), mk('text', { x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11, 'font-family': 'var(--mono)' }, fmtY(t))); }
  const raw = (hi - lo) / 6, mag = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) || raw;
  for (let x = Math.ceil(lo / st) * st; x <= hi; x += st) svg.append(mk('text', { x: X(x), y: H - 9, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11, 'font-family': 'var(--mono)' }, inr0.format(x)));
  const path = (ys) => xs.map((x, i) => (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(ys[i]).toFixed(1)).join('');
  const id = 'c' + Math.random().toString(36).slice(2, 7);
  const defs = mk('defs', {}); const ca = mk('clipPath', { id: id + 'a' }); ca.append(mk('rect', { x: 0, y: 0, width: W, height: Y(0) })); const cb = mk('clipPath', { id: id + 'b' }); cb.append(mk('rect', { x: 0, y: Y(0), width: W, height: H })); defs.append(ca, cb); svg.append(defs);
  const area = path(yE) + `L${X(hi)} ${Y(0)}L${X(lo)} ${Y(0)}Z`;
  svg.append(mk('path', { d: area, fill: 'var(--up-soft)', 'clip-path': `url(#${id}a)` }), mk('path', { d: area, fill: 'var(--down-soft)', 'clip-path': `url(#${id}b)` }));
  svg.append(mk('path', { d: path(yE), fill: 'none', stroke: 'var(--up)', 'stroke-width': 2.2, 'clip-path': `url(#${id}a)` }), mk('path', { d: path(yE), fill: 'none', stroke: 'var(--down)', 'stroke-width': 2.2, 'clip-path': `url(#${id}b)` }));
  svg.append(mk('path', { d: path(yN), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.8, 'stroke-dasharray': '6 4' }));
  svg.append(mk('line', { x1: X(spot), x2: X(spot), y1: m.t, y2: H - m.b, stroke: 'var(--fg)', 'stroke-dasharray': '2 3' }));
  svg.append(mk('text', { x: Math.min(X(spot) + 4, W - 90), y: m.t - 4, fill: 'var(--fg)', 'font-size': 11, 'font-family': 'var(--mono)' }, 'Spot ' + inr0.format(spot)));
  const rule = mk('line', { y1: m.t, y2: H - m.b, stroke: 'var(--muted)', opacity: 0 }); const d1 = mk('circle', { r: 4, fill: 'var(--fg)', opacity: 0 }); const d2 = mk('circle', { r: 4, fill: 'var(--accent)', opacity: 0 });
  svg.append(rule, d1, d2);
  const hit = mk('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }); svg.append(hit);
  box.replaceChildren(svg);
  const tip = tipBox || el('div', { class: 'tip' }); if (!tipBox) box.append(tip);
  hit.addEventListener('mousemove', (ev) => {
    const rc = svg.getBoundingClientRect(); const sx = (ev.clientX - rc.left) * W / rc.width; const x = lo + (sx - m.l) / (W - m.l - m.r) * (hi - lo);
    const e = pnlAt(legs, x, { atExpiry: true, r }), n = pnlAt(legs, x, { days, r, spot, ivShiftPct });
    for (const [k, v] of [['x1', X(x)], ['x2', X(x)]]) rule.setAttribute(k, v); rule.setAttribute('opacity', 1);
    d1.setAttribute('cx', X(x)); d1.setAttribute('cy', Y(e)); d1.setAttribute('opacity', 1); d2.setAttribute('cx', X(x)); d2.setAttribute('cy', Y(n)); d2.setAttribute('opacity', 1);
    tip.replaceChildren(el('div', { class: 'muted', text: `Index ${inr0.format(x)} (${x >= spot ? '+' : '−'}${Math.abs((x / spot - 1) * 100).toFixed(2)}%)` }), el('div', { class: e >= 0 ? 'up' : 'down', text: `At expiry ${srs(e)}` }), el('div', { text: `${nowLabel} ${srs(n)}` }));
    tip.style.opacity = 1; const bx = box.getBoundingClientRect(); let tx = ev.clientX - bx.left + 14; if (tx + tip.offsetWidth > bx.width - 6) tx = ev.clientX - bx.left - tip.offsetWidth - 14; tip.style.left = tx + 'px'; tip.style.top = (ev.clientY - bx.top - 12) + 'px';
  });
  hit.addEventListener('mouseleave', () => { tip.style.opacity = 0; rule.setAttribute('opacity', 0); d1.setAttribute('opacity', 0); d2.setAttribute('opacity', 0); });
}

function niceTicks(a, b, n) { const raw = (b - a) / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag, st = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag; const out = []; for (let v = Math.ceil(a / st) * st; v <= b + 1e-9; v += st) out.push(Math.abs(v) < 1e-9 ? 0 : v); return out; }

export function payoffLegend(nowLabel = 'Today') {
  return el('div', { class: 'legend' },
    el('span', {}, el('i', { class: 'sw', style: { background: 'var(--up)' } }), 'At expiry: profit'),
    el('span', {}, el('i', { class: 'sw', style: { background: 'var(--down)' } }), 'At expiry: loss'),
    el('span', {}, el('i', { class: 'sw', style: { background: 'var(--accent)' } }), nowLabel + ' (dashed)'),
    el('span', {}, el('i', { class: 'sw', style: { background: 'var(--band)', outline: '1px solid var(--line)' } }), 'Expected range (±1 standard deviation)'));
}
