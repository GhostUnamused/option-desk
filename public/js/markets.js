// Markets tab: live index chart, a plain-English market read, and all index quotes.
import { api, el, $, inr2, inr0, pct, tone, pts, themeColors, stdev, sma, fmtExpiry, daysTo, compact, vixMood } from './util.js';
import { term } from './glossary.js';
import { S, on, cfg, quote, loadChain, analysisExpiry, loadExpiries } from './state.js';
import { yearsTo } from './bs.js';

let root, chart, series = [], range = '1D', dailyCache = new Map(), lastDraw = 0, readBox, tableBox;

export function init(sec) {
  root = sec;
  const ranges = ['1D', '1M', '3M', '6M', '1Y'];
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Chart range' }, ranges.map((r) => el('button', { type: 'button', 'data-r': r, class: r === range ? 'on' : '', text: r, onclick: () => { range = r; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.r === r)); draw(true); } })));
  const head = el('div', { class: 'panel-h' },
    el('div', {}, el('h2', { id: 'mkName' }), el('div', {}, el('span', { class: 'big', id: 'mkLast', text: '—' }), ' ', el('span', { id: 'mkChg', class: 'mono' }))),
    el('span', { class: 'sp' }), seg);
  const legend = el('div', { class: 'legend', id: 'mkLegend' });
  const box = el('div', { class: 'chart', id: 'mkChart', style: { height: '440px' } });
  readBox = el('div', { class: 'read' }, el('p', { class: 'note', text: 'Loading the market read…' }));
  tableBox = el('div', { class: 'tw' });
  root.append(
    el('div', { class: 'cols' },
      el('div', { class: 'panel' }, head, box, legend),
      el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Market read' }), el('span', { class: 'sp' }), el('span', { class: 'note', id: 'readExp' })), readBox)),
    el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Index derivatives' }), el('span', { class: 'note', text: 'Click a row to switch the whole app to that index.' })), tableBox),
  );
  on('quotes', () => { if (S.tab === 'markets') { renderHead(); renderTable(); if (range === '1D') liveTick(); } });
  on('symbol', () => { if (S.tab === 'markets') { draw(true); renderHead(); } });
  on('expiries', () => { if (S.tab === 'markets') renderRead(); });
}

export function show() { if (!chart) makeChart(); renderHead(); renderTable(); draw(true); renderRead(); }
export function hide() {}
export async function tick() { renderRead(); }

function makeChart() {
  const c = themeColors();
  chart = LightweightCharts.createChart($('#mkChart'), {
    autoSize: true,
    layout: { attributionLogo: false, background: { type: 'solid', color: c.bg }, textColor: c.muted, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', fontSize: 12 },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.line }, timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 1 }, localization: { priceFormatter: (p) => inr2.format(p) },
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { const t = themeColors(); chart.applyOptions({ layout: { background: { type: 'solid', color: t.bg }, textColor: t.muted }, grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } } }); draw(true); });
}

function clearSeries() { series.forEach((s) => chart.removeSeries(s)); series = []; }

async function daily(symbol, days) {
  const k = `${symbol}|${days}`; const hit = dailyCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.rows;
  const rows = (await api(`/api/daily?symbol=${symbol}&days=${days}`)).rows;
  dailyCache.set(k, { at: Date.now(), rows }); return rows;
}

async function draw(reset) {
  if (!chart) return;
  const c = themeColors(); const sym = S.symbol; const legend = $('#mkLegend');
  try {
    if (range === '1D') {
      const d = await api(`/api/intraday?symbol=${sym}`);
      if (sym !== S.symbol || range !== '1D') return;
      clearSeries();
      const base = d.prevClose || d.points[0]?.v || 0;
      const s = chart.addBaselineSeries({ baseValue: { type: 'price', price: base }, topLineColor: c.up, bottomLineColor: c.down, topFillColor1: hexA(c.up, .22), topFillColor2: hexA(c.up, .02), bottomFillColor1: hexA(c.down, .02), bottomFillColor2: hexA(c.down, .22), lineWidth: 2, priceLineVisible: true });
      s.setData(d.points.map((p) => ({ time: p.t, value: p.v })));
      s.createPriceLine({ price: base, color: c.muted, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: 'Prev close' });
      series.push(s); chart.applyOptions({ timeScale: { timeVisible: true } });
      if (reset) chart.timeScale().fitContent();
      legend.replaceChildren(el('span', {}, el('i', { class: 'sw', style: { background: c.up } }), 'Above previous close'), el('span', {}, el('i', { class: 'sw', style: { background: c.down } }), 'Below previous close'), el('span', { text: `${d.points.length} one-minute points · refreshes every 5 s` }));
    } else {
      const days = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366 }[range];
      const rows = await daily(sym, days + 80);
      if (sym !== S.symbol || range === '1D') return;
      clearSeries();
      const closes = rows.map((r) => r.c); const s20 = sma(closes, 20), s50 = sma(closes, 50);
      const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      const idx = rows.map((r, i) => [r, i]).filter(([r]) => r.date >= cutoff);
      const cs = chart.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down });
      cs.setData(idx.map(([r]) => ({ time: r.date, open: r.o, high: r.h, low: r.l, close: r.c })));
      const l20 = chart.addLineSeries({ color: c.accent, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      l20.setData(idx.filter(([, i]) => s20[i] != null).map(([r, i]) => ({ time: r.date, value: s20[i] })));
      const l50 = chart.addLineSeries({ color: c.warn, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      l50.setData(idx.filter(([, i]) => s50[i] != null).map(([r, i]) => ({ time: r.date, value: s50[i] })));
      series.push(cs, l20, l50); chart.applyOptions({ timeScale: { timeVisible: false } });
      chart.timeScale().fitContent();
      legend.replaceChildren(el('span', {}, el('i', { class: 'sw', style: { background: c.accent } }), '20-day average'), el('span', {}, el('i', { class: 'sw', style: { background: c.warn } }), '50-day average'), el('span', { text: 'Daily candles: green closed higher than it opened, red lower' }));
    }
    lastDraw = Date.now();
  } catch (e) { legend.replaceChildren(el('span', { class: 'down', text: `Chart unavailable: ${e.message}` })); }
}

function liveTick() { if (Date.now() - lastDraw > 9000) draw(false); }

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
    // ATM implied vol and expected move.
    const atm = ch.rows.reduce((a, r) => (Math.abs(r.strike - spot) < Math.abs(a.strike - spot) ? r : a));
    const ivs = [atm.ce?.iv, atm.pe?.iv].filter((x) => x > 0); const iv = ivs.length ? ivs.reduce((a, b) => a + b) / ivs.length : null;
    const T = yearsTo(exp); const move = iv ? spot * iv / 100 * Math.sqrt(T) : null;
    // Positioning.
    const tot = ch.rows.reduce((a, r) => ({ ce: a.ce + (r.ce?.oi || 0), pe: a.pe + (r.pe?.oi || 0) }), { ce: 0, pe: 0 });
    const pcr = tot.ce ? tot.pe / tot.ce : null;
    const callWall = ch.rows.reduce((a, r) => ((r.ce?.oi || 0) > (a.ce?.oi || 0) ? r : a)).strike;
    const putWall = ch.rows.reduce((a, r) => ((r.pe?.oi || 0) > (a.pe?.oi || 0) ? r : a)).strike;
    let mp = null, best = Infinity;
    for (const x of ch.rows) { let pay = 0; for (const r of ch.rows) pay += (r.ce?.oi || 0) * Math.max(x.strike - r.strike, 0) + (r.pe?.oi || 0) * Math.max(r.strike - x.strike, 0); if (pay < best) { best = pay; mp = x.strike; } }
    // VIX percentile.
    const vixNow = S.quotes?.vix?.last; const vc = vixd.map((r) => r.c);
    const vixPct = vixNow && vc.length > 20 ? Math.round(vc.filter((v) => v < vixNow).length / vc.length * 100) : null;
    const mood = vixNow == null ? '' : vixMood(vixNow).label.toLowerCase();
    const rich = iv && rv ? iv - rv : null;

    $('#readExp').textContent = `Uses the ${fmtExpiry(exp)} expiry`;
    const row = (k, v, sub, cls = '') => el('div', { class: 'row' }, el('span', { class: 'k' }, term(k)), el('span', { class: 'v ' + cls }, v, sub ? el('small', { text: sub }) : null));
    const dayPos = q.high > q.low ? Math.round((q.last - q.low) / (q.high - q.low) * 100) : 50;
    const sum = [];
    sum.push(`${cfg(sym).short} is in ${trend[0] === 'Mixed' ? 'no clear trend' : 'an ' + trend[0].toLowerCase()} and trading in the ${dayPos > 66 ? 'top' : dayPos < 33 ? 'bottom' : 'middle'} of today's range.`);
    if (vixNow != null) sum.push(`India VIX at ${vixNow.toFixed(2)} says the market mood is ${mood}${vixPct != null ? ` (higher than ${vixPct}% of the past year)` : ''}.`);
    if (iv && move) sum.push(`Options price a move of about ±${pts(move)} points by ${fmtExpiry(exp)}.`);
    if (rich != null) sum.push(rich > 1.5 ? 'Options look expensive against recent movement, which favours sellers.' : rich < -1.5 ? 'Options look cheap against recent movement, which favours buyers.' : 'Options are priced roughly in line with recent movement.');
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
