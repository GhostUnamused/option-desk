// Markets tab: index chart with indicators, a plain-English market read, news & sentiment, and all index quotes.
import { api, el, $, inr2, inr0, pct, tone, pts, stdev, fmtExpiry, daysTo, compact, vixMood } from './util.js';
import { term } from './glossary.js';
import { S, on, cfg, quote, loadChain, analysisExpiry, loadExpiries } from './state.js';
import { yearsTo, now } from './bs.js';
import { StudyChart, indicatorMenu, loadPrefs, savePrefs } from './studies.js';
import { alignTo, STUDIES } from './indicators.js';
import * as news from './newsfeed.js';

let root, chart, range = '1D', dailyCache = new Map(), lastDraw = 0, readBox, tableBox, prefs, menu, drawSeq = 0;
const cached = new Map(); // small time-limited cache for option history and events
async function memo(key, ms, fn) { const h = cached.get(key); if (h && Date.now() - h.at < ms) return h.v; const v = await fn(); cached.set(key, { at: Date.now(), v }); return v; }

export function init(sec) {
  root = sec;
  prefs = loadPrefs();
  // Replay has daily prices only, so no intraday view.
  const ranges = S.meta.replay ? ['1M', '3M', '6M', '1Y'] : ['1D', '1M', '3M', '6M', '1Y'];
  if (S.meta.replay) range = '3M';
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Chart range' }, ranges.map((r) => el('button', { type: 'button', 'data-r': r, class: r === range ? 'on' : '', text: r, onclick: () => { range = r; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.r === r)); draw(true); } })));
  menu = indicatorMenu(prefs, () => draw(false));
  const head = el('div', { class: 'panel-h' },
    el('div', {}, el('h2', { id: 'mkName' }), el('div', {}, el('span', { class: 'big', id: 'mkLast', text: '—' }), ' ', el('span', { id: 'mkChg', class: 'mono' }))),
    el('span', { class: 'sp' }), menu.el, seg);
  const legend = el('div', { class: 'legend', id: 'mkLegend' });
  const box = el('div', { class: 'chart', id: 'mkChart' });
  readBox = el('div', { class: 'read' }, el('p', { class: 'note', text: 'Loading the market read…' }));
  tableBox = el('div', { class: 'tw' });
  root.append(
    el('div', { class: 'cols' },
      el('div', { class: 'panel chart-panel' }, head, box, legend),
      el('div', { class: 'side-col' },
        el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Market read' }), el('span', { class: 'sp' }), el('span', { class: 'note', id: 'readExp' })), readBox),
        news.panel())),
    el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Index derivatives' }), el('span', { class: 'note', text: 'Click a row to switch the whole app to that index.' })), tableBox),
  );
  on('quotes', () => { if (S.tab === 'markets') { renderHead(); renderTable(); if (range === '1D') liveTick(); } });
  on('symbol', () => { if (S.tab === 'markets') { draw(true); renderHead(); news.refresh(); } });
  on('expiries', () => { if (S.tab === 'markets') renderRead(); });
  on('day', () => { dailyCache.clear(); cached.clear(); if (S.tab === 'markets') news.refresh(); });
}

export function show() { if (!chart) makeChart(); renderHead(); renderTable(); draw(true); renderRead(); news.refresh(); }
export function hide() {}
let ticks = 0;
export async function tick() { renderRead(); if (++ticks % 12 === 0) news.refresh(); }

function makeChart() {
  chart = new StudyChart($('#mkChart'), { height: 420, onRemove: (id) => { prefs.on.delete(id); savePrefs(prefs); menu.refresh(); draw(false); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { chart.applyTheme(); draw(true); });
}

async function daily(symbol, days) {
  const k = `${symbol}|${days}`; const hit = dailyCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.rows;
  const rows = (await api(`/api/daily?symbol=${symbol}&days=${days}`)).rows;
  dailyCache.set(k, { at: Date.now(), rows }); return rows;
}

const want = (ids) => ids.some((id) => prefs.on.has(id));
// Longest look-back among the enabled studies, so their lines are warmed up by the start of the visible range.
const lookback = () => Math.max(60, ...[...prefs.on].map((id) => Math.max(0, ...Object.entries(prefs.params[id] || {}).filter(([k]) => ['n', 'slow'].includes(k)).map(([, v]) => v * (id.startsWith('ema') || id === 'macd' ? 3 : 1)))));
const optHistory = (sym, days) => memo(`oh|${sym}|${days}`, S.meta.replay ? 10 * 60e3 : 50e3, () => api(`/api/option-history?symbol=${sym}&days=${days}`));
const events = () => memo('events', 10 * 60e3, () => api('/api/events'));
const toChartSec = (ms) => Math.floor(ms / 1000) + 19800; // IST wall clock as UTC, like NSE's chart times
const istDate = (ms) => new Date(ms + 19800e3).toISOString().slice(0, 10);

async function positioningNow(sym) {
  await loadExpiries(sym); const exp = analysisExpiry(sym);
  const ch = await loadChain(sym, exp); return { ...positioning(ch, exp), exp };
}

async function draw(reset) {
  if (!chart) return;
  const sym = S.symbol, r = range, seq = ++drawSeq, legend = $('#mkLegend');
  const replayMode = Boolean(S.meta.replay);
  const noHist = replayMode ? 'No option prices are stored for these days yet.' : 'Live IV and PCR history build up while the app is open (a sample a minute in market hours, a point a day). Downloading history in replay mode fills in older days.';
  const notes = { iv: noHist, pcr: noHist, vix: 'India VIX history unavailable.', chain: 'Option chain unavailable.' };
  try {
    let data, from = 0, info;
    const newsShocks = async () => { const n = await news.loadNews(sym).catch(() => null); if (n?.hidden) notes.events = n.reason; return (n?.items || []).filter((i) => i.shock?.severity > 1); };
    if (r === '1D') {
      const d = await api(`/api/intraday?symbol=${sym}`);
      const bars = d.points.map((p) => ({ time: p.t, o: p.v, h: p.v, l: p.v, c: p.v }));
      const [vix, oh, ch, shocks] = await Promise.all([
        want(['vix', 'shocks']) ? api('/api/intraday?symbol=INDIAVIX').catch(() => null) : null,
        want(['iv', 'ivrv', 'pcr']) ? optHistory(sym, 30).catch(() => null) : null,
        want(['emove', 'walls']) ? positioningNow(sym).catch(() => null) : null,
        want(['events']) ? newsShocks() : []]);
      const ip = (k, mul = 1) => (oh?.intraday || []).filter((p) => p[k] != null).map((p) => ({ time: p.t, value: p[k] * mul }));
      data = { bars, style: 'baseline', base: d.prevClose || d.points[0]?.v || 0, intraday: true, perYear: 252 * 375,
        vix: alignTo(bars, vix?.points.map((p) => ({ time: p.t, value: p.v })), 180), iv: alignTo(bars, ip('iv', 100), 900), pcr: alignTo(bars, ip('pcr'), 900), chain: ch,
        events: shocks.map((i) => ({ time: toChartSec(i.t), title: `${i.title} (${i.source || 'news'})`, kind: 'shock', short: 'News' })), notes };
      info = `${d.points.length} one-minute points · refreshes every 5 s. Indicator lengths count minutes on this view.`;
    } else {
      const days = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366 }[r];
      const fetchDays = Math.min(730, days + Math.ceil(lookback() * 1.5));
      const [rows, vixRows, oh, ch, ev, shocks] = await Promise.all([
        daily(sym, fetchDays),
        want(['vix', 'shocks']) ? daily('INDIAVIX', fetchDays).catch(() => []) : [],
        want(['iv', 'ivrv', 'pcr']) ? optHistory(sym, fetchDays).catch(() => null) : null,
        want(['emove', 'walls']) ? positioningNow(sym).catch(() => null) : null,
        want(['events']) ? events().catch(() => null) : null,
        want(['events']) ? newsShocks() : []]);
      const bars = rows.map((x) => ({ time: x.date, o: x.o, h: x.h, l: x.l, c: x.c }));
      const cutoff = new Date(now() - days * 864e5).toISOString().slice(0, 10);
      from = Math.max(0, bars.findIndex((b) => b.time >= cutoff));
      const ohr = oh?.rows || [];
      if (ev?.hidden) notes.events = ev.reason;
      const evs = (ev?.events || []).map((e) => ({ time: e.date, title: `${e.title}${e.note ? ': ' + e.note : ''}`, kind: e.kind, short: e.kind === 'scheduled' ? 'Event' : 'Shock' }));
      // Shock headlines of the last few days, pinned to their day.
      for (const i of shocks) evs.push({ time: istDate(i.t), title: `${i.title} (${i.source || 'news'})`, kind: 'shock', short: 'News' });
      data = { bars, style: 'candles', intraday: false, perYear: 252,
        vix: alignTo(bars, vixRows.map((x) => ({ time: x.date, value: x.c }))), iv: alignTo(bars, ohr.filter((x) => x.iv != null).map((x) => ({ time: x.date, value: x.iv * 100 }))),
        pcr: alignTo(bars, ohr.filter((x) => x.pcr != null).map((x) => ({ time: x.date, value: x.pcr }))), chain: ch, events: evs, notes };
      info = `Daily candles: green closed higher than it opened, red lower. Drag the chart to see earlier days${replayMode && bars.length - from < days * 0.6 * 5 / 7 ? '. Only part of this range is downloaded.' : '.'}`;
    }
    if (seq !== drawSeq || sym !== S.symbol || r !== range) return;
    chart.render(data, prefs, reset);
    if (reset && from) chart.main.timeScale().setVisibleLogicalRange({ from, to: data.bars.length + 3 });
    const panes = STUDIES.filter((s) => s.where === 'pane' && prefs.on.has(s.id)).length;
    legend.replaceChildren(el('span', { text: info }), el('span', { text: prefs.on.size ? `${prefs.on.size} indicator${prefs.on.size > 1 ? 's' : ''} on${panes ? `, ${panes} in panes below` : ''}. Hover the chart to read values; × hides one.` : 'No indicators on: open Indicators to add some.' }));
    lastDraw = Date.now();
  } catch (e) { legend.replaceChildren(el('span', { class: 'down', text: `Chart unavailable: ${e.message}` })); }
}

function liveTick() { if (Date.now() - lastDraw > 9000) draw(false); }

// Option-market positioning from one chain: ATM IV, expected move, put–call ratio, OI walls and max pain.
export function positioning(ch, exp) {
  const spot = ch.spot;
  const atm = ch.rows.reduce((a, r) => (Math.abs(r.strike - spot) < Math.abs(a.strike - spot) ? r : a));
  const ivs = [atm.ce?.iv, atm.pe?.iv].filter((x) => x > 0); const iv = ivs.length ? ivs.reduce((a, b) => a + b) / ivs.length : null;
  const move = iv ? spot * iv / 100 * Math.sqrt(yearsTo(exp)) : null;
  const tot = ch.rows.reduce((a, r) => ({ ce: a.ce + (r.ce?.oi || 0), pe: a.pe + (r.pe?.oi || 0) }), { ce: 0, pe: 0 });
  const callWall = ch.rows.reduce((a, r) => ((r.ce?.oi || 0) > (a.ce?.oi || 0) ? r : a)).strike;
  const putWall = ch.rows.reduce((a, r) => ((r.pe?.oi || 0) > (a.pe?.oi || 0) ? r : a)).strike;
  let maxPain = null, best = Infinity;
  for (const x of ch.rows) { let pay = 0; for (const r of ch.rows) pay += (r.ce?.oi || 0) * Math.max(x.strike - r.strike, 0) + (r.pe?.oi || 0) * Math.max(r.strike - x.strike, 0); if (pay < best) { best = pay; maxPain = x.strike; } }
  return { spot, iv, move, pcr: tot.ce ? tot.pe / tot.ce : null, callWall, putWall, maxPain };
}

function renderHead() {
  const q = quote(); if (!q) return;
  $('#mkName').textContent = q.name;
  $('#mkLast').textContent = inr2.format(q.last);
  const ch = $('#mkChg'); ch.textContent = `${q.change >= 0 ? '+' : '−'}${inr2.format(Math.abs(q.change))} (${pct(q.pct)})`; ch.className = 'mono ' + tone(q.change);
}

function renderTable() {
  const q = S.quotes; if (!q) return;
  const rows = [...q.indices, ...(q.vix ? [q.vix] : [])];
  const t = el('table', {},
    el('thead', {}, el('tr', {}, ['Index', 'Last', 'Change', '%', 'Open', 'High', 'Low', 'Prev close', '52-week range', 'Lot'].map((h, i) => el('th', { class: i === 0 || i === 8 ? 'l' : '' }, term(h))))),
    el('tbody', {}, rows.map((i) => el('tr', { style: { cursor: i.symbol === 'INDIAVIX' ? 'default' : 'pointer' }, onclick: () => i.symbol !== 'INDIAVIX' && import('./state.js').then((m) => m.setSymbol(i.symbol)) },
      el('td', { class: 'l t', text: i.name + (i.symbol === S.symbol ? '  •' : '') }), el('td', { text: inr2.format(i.last) }),
      el('td', { class: tone(i.change), text: (i.change >= 0 ? '+' : '−') + inr2.format(Math.abs(i.change)) }), el('td', { class: tone(i.pct), text: pct(i.pct) }),
      el('td', { text: i.open ? inr2.format(i.open) : '—' }), el('td', { text: i.high ? inr2.format(i.high) : '—' }), el('td', { text: i.low ? inr2.format(i.low) : '—' }), el('td', { text: inr2.format(i.prevClose) }),
      el('td', { class: 'l' }, i.yearLow ? rangeBar(i.yearLow, i.yearHigh, i.last) : '—'), el('td', { text: i.lot || '—' })))));
  tableBox.replaceChildren(t);
}

function rangeBar(lo, hi, v) {
  const p = Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  return el('div', { style: { minWidth: '160px' } }, el('div', { class: 'mono', style: { display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', color: 'var(--muted)' } }, el('span', { text: pts(lo) }), el('span', { text: pts(hi) })), el('div', { class: 'range' }, el('i', { style: { left: `calc(${p}% - 1px)` } })));
}

let readBusy = false;
async function renderRead() {
  if (readBusy) return; readBusy = true;
  try {
    const sym = S.symbol; await loadExpiries(sym);
    const exp = analysisExpiry(sym);
    const [d, vixd, ch] = await Promise.all([daily(sym, 130), daily('INDIAVIX', 366).catch(() => []), loadChain(sym, exp)]);
    if (sym !== S.symbol) return;
    const q = quote(sym) || { last: ch.spot, high: ch.spot, low: ch.spot };
    const spot = ch.spot || q.last;
    // Trend from daily closes, with today's live price as the latest close.
    const closes = d.map((r) => r.c); if (closes.length) closes.push(q.last);
    const m20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length), m50 = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
    const trend = q.last > m20 && m20 > m50 ? ['Uptrend', 'up', 'Above its 20-day average, which is above its 50-day'] : q.last < m20 && m20 < m50 ? ['Downtrend', 'down', 'Below its 20-day average, which is below its 50-day'] : ['Mixed', '', 'Averages disagree: no clear trend'];
    const rets = d.slice(-21).map((r, i, a) => (i ? Math.log(r.c / a[i - 1].c) : null)).filter((x) => x != null);
    const rv = rets.length > 5 ? stdev(rets) * Math.sqrt(252) * 100 : null;
    const P = positioning({ ...ch, spot }, exp);
    const { iv, move, pcr, callWall, putWall, maxPain: mp } = P;
    const nw = await news.loadNews(sym).catch(() => null);
    // VIX percentile.
    const vixNow = S.quotes?.vix?.last; const vc = vixd.map((r) => r.c);
    const vixPct = vixNow && vc.length > 20 ? Math.round(vc.filter((v) => v < vixNow).length / vc.length * 100) : null;
    const mood = vixNow == null ? '' : vixMood(vixNow).label.toLowerCase();
    const rich = iv && rv ? iv - rv : null;

    $('#readExp').textContent = `Uses the ${fmtExpiry(exp)} expiry`;
    const row = (k, v, sub, cls = '') => el('div', { class: 'row' }, el('span', { class: 'k' }, term(k)), el('span', { class: 'v ' + cls }, v, sub ? el('small', { text: sub }) : null));
    const dayPos = q.high > q.low ? Math.round((q.last - q.low) / (q.high - q.low) * 100) : 50;
    const sum = [];
    sum.push(`${cfg(sym).short} is in ${trend[0] === 'Mixed' ? 'no clear trend' : (trend[0] === 'Uptrend' ? 'an uptrend' : 'a downtrend')} and trading in the ${dayPos > 66 ? 'top' : dayPos < 33 ? 'bottom' : 'middle'} of today's range.`);
    if (vixNow != null) sum.push(`India VIX at ${vixNow.toFixed(2)} says the market mood is ${mood}${vixPct != null ? ` (higher than ${vixPct}% of the past year)` : ''}.`);
    if (iv && move) sum.push(`Options price a move of about ±${pts(move)} points by ${fmtExpiry(exp)}.`);
    if (rich != null) sum.push(rich > 1.5 ? 'Options look expensive against recent movement, which favours sellers.' : rich < -1.5 ? 'Options look cheap against recent movement, which favours buyers.' : 'Options are priced roughly in line with recent movement.');
    if (nw && !nw.hidden && nw.items.length) sum.push(`News mood is ${nw.mood.label.toLowerCase()}${nw.mood.shocks ? `, with ${nw.mood.shocks} shock headline${nw.mood.shocks > 1 ? 's' : ''} that could jolt prices` : ''}.`);
    sum.push(`Writers have built a range from about ${pts(Math.min(putWall, callWall))} to ${pts(Math.max(putWall, callWall))}.`);
    readBox.replaceChildren(
      el('p', { class: 'summary', text: sum.join(' ') }),
      el('div', {},
        row('Trend', trend[0], trend[2], trend[1]),
        row("Today's range", `${pts(q.low)} – ${pts(q.high)}`, `Now at ${dayPos}% of the range`),
        row('India VIX', vixNow != null ? vixNow.toFixed(2) : '—', vixPct != null ? `Fear gauge · ${mood} · ${vixPct}th percentile of the year` : 'Fear gauge'),
        row('Implied vol (ATM)', iv ? iv.toFixed(1) + '%' : '—', 'What options are pricing in, per year'),
        row('Realized vol (20 days)', rv ? rv.toFixed(1) + '%' : '—', rich != null ? (rich > 0 ? `Options pricing ${rich.toFixed(1)} pts more than delivered` : `Options pricing ${Math.abs(rich).toFixed(1)} pts less than delivered`) : 'How much it actually moved'),
        row('Expected move', move ? `±${pts(move)}` : '—', move ? `${pts(spot - move)} to ${pts(spot + move)} · ${daysTo(exp).toFixed(1)} days` : ''),
        row('Put–call ratio', pcr ? pcr.toFixed(2) : '—', pcr ? (pcr > 1 ? 'More puts open: writers lean supportive' : 'More calls open: writers lean cautious') : ''),
        row('Call wall / put wall', `${pts(callWall)} / ${pts(putWall)}`, 'Strikes with the most open calls and puts'),
        row('Max pain', pts(mp), 'Close where most options would expire worthless'),
        nw && !nw.hidden ? row('News mood', nw.mood.label, `${nw.mood.positive} positive · ${nw.mood.negative} negative headlines${nw.mood.shocks ? ` · ${nw.mood.shocks} shocks` : ''}`, nw.mood.score > 0.08 ? 'up' : nw.mood.score < -0.08 ? 'down' : '') : null,
      ),
    );
  } catch (e) { readBox.replaceChildren(el('p', { class: 'errbox', text: `Market read unavailable: ${e.message}` })); }
  finally { readBusy = false; }
}

function hexA(color, a) {
  const c = color.trim();
  if (c.startsWith('#') && c.length === 7) { const n = parseInt(c.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
  return c;
}
export { hexA, compact };
