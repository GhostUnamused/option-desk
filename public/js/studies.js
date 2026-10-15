// Study chart: the price chart with indicator overlays, plus one synced pane per oscillator underneath (Lightweight
// Charts 4 has no panes, so each pane is its own chart sharing the time axis, crosshair and zoom), and the Indicators menu.
import { el, inr2, store } from './util.js';
import { STUDIES, GROUPS, PRESETS, DEFAULT_ON, ivRank } from './indicators.js';

const byId = Object.fromEntries(STUDIES.map((s) => [s.id, s]));
const PARAM_LABEL = { n: 'Length', k: 'Width σ', mult: '× ATR', step: 'Step', max: 'Max', fast: 'Fast', slow: 'Slow', signal: 'Signal', smooth: 'Smooth', d: '%D', z: 'Threshold σ' };

// ---- Saved choices: which studies are on and their settings ----
export function loadPrefs() {
  const p = store.get('studies', null);
  const on = new Set((p?.on || DEFAULT_ON).filter((id) => byId[id]));
  const params = {}; for (const s of STUDIES) params[s.id] = { ...s.params, ...(p?.params?.[s.id] || {}) };
  // hidden: switched off with the eye in the legend but kept, with its settings, like TradingView.
  return { on, params, hidden: new Set((p?.hidden || []).filter((id) => on.has(id))) };
}
export function savePrefs(pr) { store.set('studies', { on: [...pr.on], params: pr.params, hidden: [...(pr.hidden || [])].filter((id) => pr.on.has(id)) }); }
export const label = (s, p) => (s.short ? s.short(p) : s.name);

function tokens() {
  const cs = getComputedStyle(document.documentElement), g = (n) => cs.getPropertyValue(n).trim();
  const t = { bg: g('--panel'), muted: g('--muted'), line: g('--line'), grid: g('--grid'), up: g('--up'), down: g('--down'), fg: g('--fg') };
  for (let i = 1; i <= 8; i++) t['c' + i] = g('--s' + i);
  return t;
}
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const fmtV = (v, unit) => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? inr2.format(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1)) + (v != null && unit === '%' ? '%' : '');

function chartOpts(t, { timeVisible, showTime, height }) {
  return {
    autoSize: true, height,
    layout: { attributionLogo: false, background: { type: 'solid', color: t.bg }, textColor: t.muted, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    rightPriceScale: { borderColor: t.line, minimumWidth: 78 },
    timeScale: { borderColor: t.line, timeVisible, secondsVisible: false, visible: showTime, rightOffset: 4 },
    crosshair: { mode: 0 }, handleScale: { axisPressedMouseMove: { time: true, price: true } },
  };
}

// Shades the band between two lines (Bollinger, Keltner, Donchian) under the candles, the way TradingView fills them.
// A series primitive: it draws in the price series' pane using that series' price scale.
class BandFill {
  constructor(bars, up, lo, color) { this.bars = bars; this.up = up; this.lo = lo; this.color = color; }
  attached({ chart, series }) { this.chart = chart; this.series = series; }
  detached() { this.chart = this.series = null; }
  updateAllViews() {}
  paneViews() {
    return [{ zOrder: () => 'bottom', renderer: () => ({ draw: (target) => target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      if (!this.series) return;
      const ts = this.chart.timeScale(), runs = []; let run = [];
      this.bars.forEach((b, i) => {
        const u = this.up[i], l = this.lo[i], x = u == null || l == null ? null : ts.timeToCoordinate(b.time);
        const yu = x == null ? null : this.series.priceToCoordinate(u), yl = x == null ? null : this.series.priceToCoordinate(l);
        if (x == null || yu == null || yl == null) { if (run.length) runs.push(run); run = []; return; }
        run.push([x * hr, yu * vr, yl * vr]);
      });
      if (run.length) runs.push(run);
      ctx.fillStyle = this.color;
      for (const r of runs) {
        if (r.length < 2) continue;
        ctx.beginPath(); ctx.moveTo(r[0][0], r[0][1]);
        for (const [x, y] of r) ctx.lineTo(x, y);
        for (let k = r.length - 1; k >= 0; k--) ctx.lineTo(r[k][0], r[k][2]);
        ctx.closePath(); ctx.fill();
      }
    }) }) }];
  }
}

export class StudyChart {
  // Legend buttons: onRemove(id) for ×, onToggle(id) for the eye, onSettings(id) for the gear.
  constructor(host, { height = 440, paneHeight = 118, onRemove, onToggle, onSettings } = {}) {
    this.host = host; this.height = height; this.paneHeight = paneHeight; this.onRemove = onRemove; this.onToggle = onToggle; this.onSettings = onSettings;
    this.collapsed = store.get('legendCollapsed', false);
    this.mainBox = el('div', { class: 'sc-main', style: { height: height + 'px' } });
    this.mainLegend = el('div', { class: 'sc-legend' });
    this.paneBox = el('div', { class: 'sc-panes' });
    host.replaceChildren(el('div', { class: 'sc-wrap' }, this.mainLegend), this.paneBox);
    host.firstChild.prepend(this.mainBox);
    this.t = tokens();
    this.main = LightweightCharts.createChart(this.mainBox, { ...chartOpts(this.t, { timeVisible: true, showTime: true }), localization: { priceFormatter: (p) => inr2.format(p) } });
    this.panes = new Map(); // id -> { box, chart, legend, anchor, series: [] }
    this.mainSeries = []; this.price = null; this.active = null; this.legendRows = []; this.bars = [];
    this.wire(this.main, this.mainBox);
  }

  wire(chart, box) {
    box.addEventListener('pointerenter', () => { this.active = chart; });
    box.addEventListener('pointerleave', () => { if (this.active === chart) this.active = null; this.showAt(null); for (const c of this.charts()) c.clearCrosshairPosition(); });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (!r || (this.active ? this.active !== chart : chart !== this.main)) return;
      for (const c of this.charts()) if (c !== chart) c.timeScale().setVisibleLogicalRange(r);
    });
    chart.subscribeCrosshairMove((p) => {
      if (this.active !== chart) return;
      const i = p.time == null ? null : this.index.get(String(p.time));
      this.showAt(i ?? null);
      for (const c of this.charts()) {
        if (c === chart) continue;
        const target = c === this.main ? this.price : this.paneFor(c)?.anchorSeries;
        const val = c === this.main ? this.bars[i]?.c : this.paneFor(c)?.valueAt(i);
        if (i != null && target && val != null) c.setCrosshairPosition(val, p.time, target); else c.clearCrosshairPosition();
      }
    });
  }
  charts() { return [this.main, ...[...this.panes.values()].map((p) => p.chart)]; }
  paneFor(chart) { for (const p of this.panes.values()) if (p.chart === chart) return p; return null; }

  // data: { bars, style: 'candles' | 'baseline', base, intraday, perYear, vix, iv, pcr, chain, events, notes }
  // prefs: { on, params }. fit: reset the zoom to show everything.
  render(data, prefs, fit) {
    const t = this.t = tokens(), bars = this.bars = data.bars, n = bars.length;
    this.index = new Map(bars.map((b, i) => [String(b.time), i]));
    const keep = !fit && this.main.timeScale().getVisibleLogicalRange();
    const atEdge = keep && keep.to >= (this.lastN || 0) - 2, grow = n - (this.lastN || n);
    this.lastN = n;
    const ctx = { closes: bars.map((b) => b.c), perYear: data.perYear, intraday: data.intraday, vix: data.vix || [], iv: data.iv || [], pcr: data.pcr || [], chain: data.chain };
    const color = (k) => t[k] || k;

    // Price
    for (const s of this.mainSeries) this.main.removeSeries(s);
    this.mainSeries = [];
    if (data.style === 'baseline') {
      this.price = this.main.addBaselineSeries({ baseValue: { type: 'price', price: data.base }, topLineColor: t.up, bottomLineColor: t.down, topFillColor1: rgba(t.up, 0.2), topFillColor2: rgba(t.up, 0.02), bottomFillColor1: rgba(t.down, 0.02), bottomFillColor2: rgba(t.down, 0.2), lineWidth: 2 });
      this.price.setData(bars.map((b) => ({ time: b.time, value: b.c })));
      if (data.base) this.price.createPriceLine({ price: data.base, color: t.muted, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: 'Prev close' });
    } else {
      this.price = this.main.addCandlestickSeries({ upColor: t.up, downColor: t.down, borderVisible: false, wickUpColor: t.up, wickDownColor: t.down });
      this.price.setData(bars.map((b) => ({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c })));
    }
    this.mainSeries.push(this.price);
    this.main.applyOptions({ timeScale: { timeVisible: Boolean(data.intraday) } });

    const outs = new Map();
    this.prefs = prefs;
    for (const id of prefs.on) {
      const s = byId[id]; if (!s) continue;
      if (prefs.hidden?.has(id)) { outs.set(id, { lines: [], hidden: true }); continue; }
      const missing = s.needs && s.needs !== 'events' && (s.needs === 'chain' ? !data.chain : !(ctx[s.needs] || []).some((v) => v != null));
      let out; try { out = missing ? { lines: [] } : s.compute(bars, prefs.params[id], ctx); } catch (e) { out = { lines: [], error: e.message }; }
      if (missing) out.note = data.notes?.[s.needs] || 'No data for this yet.';
      outs.set(id, out);
    }

    // Overlays on the price chart
    const marks = [], legend = [];
    for (const [id, out] of outs) {
      const s = byId[id]; if (s.where !== 'price') continue;
      const entry = { id, name: label(s, prefs.params[id]), help: `${s.name}: ${s.help}`, values: [], note: out.note, hidden: out.hidden };
      for (const f of out.fills || []) this.price.attachPrimitive(new BandFill(bars, f.up, f.lo, rgba(color(f.color), f.alpha ?? 0.07)));
      for (const ln of out.lines) {
        // Each line's latest value sits on the price axis in its own colour, so the axis says which line is which.
        const ser = this.main.addLineSeries({ color: color(ln.color), lineWidth: ln.width || 1.5, lineStyle: ln.dashed ? 2 : 0, lineVisible: !ln.dots, pointMarkersVisible: Boolean(ln.dots), pointMarkersRadius: 1.6, priceLineVisible: false, lastValueVisible: !ln.dots && !ln.colors, crosshairMarkerVisible: false });
        ser.setData(lineData(bars, ln.data, ln.colors && ((i) => color(ln.colors[i] || ln.color))));
        this.mainSeries.push(ser); entry.values.push({ name: ln.name, color: color(ln.color), data: ln.data });
      }
      for (const pl of out.prices || []) if (Number.isFinite(pl.price)) this.price.createPriceLine({ price: pl.price, color: color(pl.color), lineStyle: 1, lineWidth: 1, axisLabelVisible: true, title: pl.title });
      for (const pl of out.prices || []) if (Number.isFinite(pl.price)) entry.values.push({ name: pl.title, color: color(pl.color), fixed: pl.price });
      for (const m of out.marks || []) marks.push({ time: bars[m.i].time, position: m.up ? 'belowBar' : 'aboveBar', color: m.up ? t.up : t.down, shape: m.up ? 'arrowUp' : 'arrowDown', text: m.text, title: m.title, i: m.i });
      if (id === 'events') {
        let shown = 0;
        for (const e of data.events || []) {
          const i = e.i ?? nearestBar(bars, e.time); if (i == null) continue;
          marks.push({ time: bars[i].time, position: 'aboveBar', color: e.kind === 'scheduled' ? t.c5 : t.c4, shape: e.kind === 'scheduled' ? 'square' : 'circle', text: e.short || '', title: e.title, i }); shown++;
        }
        entry.text = data.notes?.events || (shown ? `${shown} · hover a marker` : 'none here');
      }
      legend.push(entry);
    }
    marks.sort((a, b) => a.i - b.i);
    this.marks = marks;
    // Several events or headlines on one bar share a single marker ("3 news"), so they don't stack up the chart.
    const shown = [];
    for (const m of marks) {
      const prev = shown[shown.length - 1];
      if (m.position === 'aboveBar' && m.shape !== 'arrowDown' && prev?.i === m.i && prev.position === 'aboveBar' && prev.shape !== 'arrowDown') { prev.n++; prev.text = `${prev.n} news`; continue; }
      shown.push({ ...m, n: 1 });
    }
    this.price.setMarkers(shown.map(({ time, position, color: c, shape, text }) => ({ time, position, color: c, shape, text, size: 0.8 })));
    this.legendRows = legend;

    // Panes: one per enabled pane study, in catalogue order
    const want = STUDIES.filter((s) => s.where === 'pane' && outs.has(s.id)).map((s) => s.id);
    for (const [id, p] of this.panes) if (!want.includes(id)) { p.chart.remove(); p.box.remove(); this.panes.delete(id); }
    want.forEach((id) => {
      let p = this.panes.get(id);
      if (!p) p = this.addPane(id);
      this.paneBox.append(p.box); // keeps catalogue order
      this.fillPane(p, byId[id], outs.get(id), color);
    });
    // Only the bottom chart shows the time axis.
    const last = want.length ? this.panes.get(want[want.length - 1]).chart : this.main;
    for (const c of this.charts()) c.applyOptions({ timeScale: { visible: c === last, timeVisible: Boolean(data.intraday) } });

    if (fit || !keep) this.main.timeScale().fitContent();
    else this.main.timeScale().setVisibleLogicalRange(atEdge ? { from: keep.from + grow, to: keep.to + grow } : keep);
    const r = this.main.timeScale().getVisibleLogicalRange();
    if (r) for (const c of this.charts()) if (c !== this.main) c.timeScale().setVisibleLogicalRange(r);
    this.showAt(null);
  }

  addPane(id) {
    const box = el('div', { class: 'sc-pane', style: { height: this.paneHeight + 'px' } });
    const legend = el('div', { class: 'sc-legend' });
    const wrap = el('div', { class: 'sc-wrap' }, box, legend);
    this.paneBox.append(wrap); // in the page before the chart is made, so it starts at its real width
    const chart = LightweightCharts.createChart(box, chartOpts(this.t, { timeVisible: false, showTime: false }));
    const p = { id, box: wrap, chart, legend, series: [], anchorSeries: null, lines: [], valueAt: (i) => { for (const l of p.lines) if (i != null && l.data[i] != null) return l.data[i]; return null; } };
    this.panes.set(id, p); this.wire(chart, box);
    return p;
  }

  fillPane(p, s, out, color) {
    for (const ser of p.series) p.chart.removeSeries(ser);
    p.series = []; p.lines = [];
    const bars = this.bars, range = out.range;
    const auto = range ? () => ({ priceRange: { minValue: range[0], maxValue: range[1] } }) : undefined;
    // Invisible anchor holding every bar time, so each pane's bar index lines up with the price chart's.
    const anchor = p.chart.addLineSeries({ visible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    anchor.setData(bars.map((b) => ({ time: b.time })));
    p.series.push(anchor);
    const fmt = { type: 'price', precision: 2, minMove: 0.01 };
    if (out.hist) {
      const h = p.chart.addHistogramSeries({ priceFormat: fmt, priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: auto });
      h.setData(bars.map((b, i) => (out.hist.data[i] == null ? { time: b.time } : { time: b.time, value: out.hist.data[i], color: rgba(out.hist.data[i] >= 0 ? this.t.up : this.t.down, 0.6) })));
      p.series.push(h); p.lines.push({ ...out.hist, color: this.t.fg });
    }
    let first = null;
    for (const ln of out.lines) {
      // Lightweight Charts joins a line across empty points, so a line with a real gap (missing history) is drawn in pieces.
      const parts = pieces(ln.data);
      parts.forEach((pc, k) => {
        const ser = p.chart.addLineSeries({ color: color(ln.color), lineWidth: ln.width || 1.5, lineStyle: ln.dashed ? 2 : 0, priceFormat: fmt, priceLineVisible: false, lastValueVisible: k === parts.length - 1, crosshairMarkerRadius: 3, autoscaleInfoProvider: auto });
        ser.setData(lineData(bars, pc));
        p.series.push(ser); first ||= ser;
      });
      p.lines.push({ ...ln, color: color(ln.color) });
    }
    first ||= p.series[1];
    for (const lv of first ? out.levels || [] : []) first.createPriceLine({ price: lv, color: rgba(this.t.muted.startsWith('#') ? this.t.muted : '#8E8E93', 0.6), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
    p.anchorSeries = first || anchor;
    p.study = s; p.out = out; p.params = this.prefs?.params[s.id];
    if (out.rank) { const r = ivRank(out.lines[0].data); p.rank = r && r.n >= 20 ? r : null; } else p.rank = null;
  }

  // Legends follow the crosshair, or show the latest values when the mouse is away. TradingView style: one short line per
  // study ("BB 20 2" then its values in their line colours), buttons on hover, and an arrow that folds them all away.
  showAt(i) {
    const n = this.bars.length; if (!n) return;
    const at = i ?? n - 1, b = this.bars[at];
    this.lastAt = i;
    const btn = (cls, title, text, fn) => el('button', { class: 'sc-b ' + cls, type: 'button', title, 'aria-label': title, text, onclick: fn });
    const tools = (id, hidden) => el('span', { class: 'sc-tools' },
      btn('sc-eye' + (hidden ? ' off' : ''), hidden ? 'Show' : 'Hide', hidden ? '◌' : '◉', () => this.onToggle?.(id)),
      this.onSettings ? btn('', 'Settings', '⚙', () => this.onSettings(id)) : null,
      btn('sc-x', 'Remove', '×', () => this.onRemove?.(id)));
    const fmtP = (v) => (Math.abs(v) >= 1000 ? inr2.format(v) : v.toFixed(2));
    const vals = (values, unit) => values.map((v) => el('b', { class: 'sc-val', style: { color: v.color }, title: v.name, text: v.fixed != null ? fmtP(v.fixed) : fmtV(v.data[at], unit) }));
    const row = (id, name, help, values, extra, hidden, unit) => el('div', { class: 'sc-row' + (hidden ? ' off' : ''), 'data-id': id },
      el('span', { class: 'sc-name term', tabindex: '0', 'data-tip': help, text: name }), ...(hidden ? [] : vals(values, unit)), ...(hidden ? [] : extra), tools(id, hidden));
    const ohlc = b && el('div', { class: 'sc-row sc-ohlc' }, ...(this.price.seriesType() === 'Candlestick' ? ['O', b.o, 'H', b.h, 'L', b.l, 'C', b.c].map((v, k) => (k % 2 ? el('b', { text: inr2.format(v) }) : el('span', { text: v }))) : [el('b', { text: inr2.format(b.c) })]),
      at > 0 ? el('span', { class: b.c >= this.bars[at - 1].c ? 'up' : 'down', text: `${b.c >= this.bars[at - 1].c ? '+' : '−'}${(Math.abs(b.c / this.bars[at - 1].c - 1) * 100).toFixed(2)}%` }) : null);
    const count = this.legendRows.length + this.panes.size;
    const fold = count ? btn('sc-fold' + (this.collapsed ? ' shut' : ''), this.collapsed ? 'Show indicator values' : 'Hide indicator values', this.collapsed ? `⌄ ${count}` : '⌃', () => this.fold()) : null;
    // Event and news titles only while hovering their bar, three at most, so they never sit on top of the chart.
    const all = i == null ? [] : (this.marks || []).filter((m) => m.i === at && m.title), evs = all.slice(0, 3);
    const t = (x) => (x ? el('span', { class: 'sc-t', text: x }) : null);
    this.mainLegend.replaceChildren(el('div', { class: 'sc-top' }, ohlc || '', fold),
      ...(this.collapsed ? [] : this.legendRows.map((r) => row(r.id, r.name, r.help, r.values, [t(r.text), t(r.note)], r.hidden))),
      ...evs.map((m) => el('div', { class: 'sc-row sc-ev' }, el('i', { style: { background: m.color } }), m.title)),
      all.length > 3 ? el('div', { class: 'sc-row sc-t', text: `and ${all.length - 3} more in the news panel` }) : '');
    for (const p of this.panes.values()) {
      const s = p.study, o = p.out; if (!s) continue;
      p.legend.hidden = this.collapsed;
      if (this.collapsed) continue;
      p.legend.replaceChildren(row(s.id, label(s, p.params || s.params), `${s.name}: ${s.help}`, p.lines, [
        p.rank ? t(`IV rank ${Math.round(p.rank.rank)} · pct ${Math.round(p.rank.percentile)}`) : null,
        t(o.note), o.error ? el('span', { class: 'sc-t down', text: o.error }) : null], o.hidden, o.unit));
    }
  }
  fold() { this.collapsed = !this.collapsed; store.set('legendCollapsed', this.collapsed); this.showAt(this.lastAt ?? null); }

  applyTheme() { this.t = tokens(); for (const c of this.charts()) c.applyOptions({ layout: { background: { type: 'solid', color: this.t.bg }, textColor: this.t.muted }, grid: { vertLines: { color: this.t.grid }, horzLines: { color: this.t.grid } } }); }
}

// Split a series wherever it has `gap` or more empty bars in a row (one copy per piece, nulls elsewhere).
function pieces(data, gap = 3) {
  const out = []; let start = null, empty = 0, last = -1;
  const cut = (to) => { const d = data.map((v, i) => (i >= start && i <= to ? v : null)); out.push(d); };
  data.forEach((v, i) => {
    if (v == null) { empty++; return; }
    if (start == null) start = i; else if (empty >= gap) { cut(last); start = i; }
    empty = 0; last = i;
  });
  if (start != null) cut(last);
  return out.length ? out : [data];
}

function lineData(bars, data, colorAt) {
  return bars.map((b, i) => (data[i] == null || !Number.isFinite(data[i]) ? { time: b.time } : colorAt ? { time: b.time, value: data[i], color: colorAt(i) } : { time: b.time, value: data[i] }));
}
// Bar index for an event time: the bar at or after a date (within 4 days), or at or before an intraday time.
function nearestBar(bars, time) {
  if (!bars.length) return null;
  if (typeof time === 'string') { const i = bars.findIndex((b) => b.time >= time); return i >= 0 && (Date.parse(bars[i].time) - Date.parse(time)) / 864e5 <= 4 ? i : null; }
  let k = null; for (let i = 0; i < bars.length && bars[i].time <= time; i++) k = i;
  return k != null && time - bars[k].time <= 600 ? k : null;
}

// ---- Indicators menu ----
export function indicatorMenu(prefs, onChange) {
  const btn = el('button', { class: 'btn ghost sm ind-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const pop = el('div', { class: 'ind-pop', role: 'dialog', 'aria-label': 'Indicators', hidden: true });
  const wrap = el('div', { class: 'ind' }, btn, pop);
  const count = () => { btn.replaceChildren('Indicators', el('span', { class: 'ind-n', text: String(prefs.on.size) })); };
  const changed = () => { savePrefs(prefs); count(); onChange(); };
  const build = () => {
    const presets = el('div', { class: 'ind-presets' }, el('span', { class: 'note', text: 'Presets' }),
      ...Object.entries(PRESETS).map(([name, ids]) => el('button', { class: 'chip', type: 'button', text: name, onclick: () => { prefs.on = new Set(ids); prefs.hidden?.clear(); build(); changed(); } })),
      el('button', { class: 'chip', type: 'button', text: 'Clear all', onclick: () => { prefs.on.clear(); build(); changed(); } }));
    const groups = GROUPS.map(([g, title, sub]) => el('fieldset', { class: 'ind-g' }, el('legend', {}, el('b', { text: title }), el('span', { class: 'note', text: sub })),
      ...STUDIES.filter((s) => s.group === g).map((s) => {
        const cb = el('input', { type: 'checkbox', checked: prefs.on.has(s.id), onchange: () => { cb.checked ? prefs.on.add(s.id) : prefs.on.delete(s.id); changed(); } });
        const ps = Object.entries(prefs.params[s.id]).map(([k, v]) => el('label', { class: 'ind-p' }, PARAM_LABEL[k] || k,
          el('input', { class: 'inp', type: 'number', value: v, step: v < 1 ? 0.01 : v % 1 ? 0.1 : 1, min: v < 1 ? 0.01 : 1, max: 400, onchange: (e) => { const x = Number(e.target.value); if (x > 0) { prefs.params[s.id][k] = x; if (prefs.on.has(s.id)) changed(); else savePrefs(prefs); } } })));
        return el('div', { class: 'ind-item', 'data-id': s.id }, el('label', { class: 'ind-on' }, cb, el('span', {}, el('b', { text: s.name }), el('small', { text: s.where === 'pane' ? ' own pane' : ' on price' }))),
          el('p', { class: 'note', text: s.help }), ps.length ? el('div', { class: 'ind-ps' }, ...ps) : null);
      })));
    pop.replaceChildren(el('div', { class: 'ind-head' }, el('b', { text: 'Indicators' }), el('span', { class: 'note', text: 'Tick what you want on the chart. Fewer is clearer: try a preset.' }),
      el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => toggle(false) })), presets, el('div', { class: 'ind-grid' }, ...groups));
  };
  const outside = (e) => { if (!wrap.contains(e.target)) toggle(false); };
  const esc = (e) => { if (e.key === 'Escape') toggle(false); };
  function toggle(open = pop.hidden) {
    pop.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open) { build(); document.addEventListener('pointerdown', outside); document.addEventListener('keydown', esc); }
    else { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', esc); }
  }
  btn.addEventListener('click', () => toggle());
  count();
  // Open at one study (the gear in the chart legend) and flash it.
  const open = (id) => { toggle(true); const it = pop.querySelector(`.ind-item[data-id="${id}"]`); if (it) { it.scrollIntoView({ block: 'center' }); it.classList.add('flash'); it.querySelector('input[type=number]')?.focus(); } };
  return { el: wrap, refresh: count, open };
}
