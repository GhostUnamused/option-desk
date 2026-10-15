// Option chain tab: broker-style chain with hover Buy/Sell, live refresh, and an open-interest chart.
import { el, $, inr0, inr2, compact, pct, tone, pts, fmtExpiryLong, fmtLeft, store, toast } from './util.js';
import { S, on, emit, cfg, loadChain, loadExpiries, setSymbol } from './state.js';
import { bs, yearsTo } from './bs.js';
import * as ticket from './ticket.js';
import * as drawer from './drawer.js';
import { term } from './glossary.js';
import * as expired from './expired.js';
import * as stocks from './stocks.js';

let root, tbody, statsBox, oiBox, win = store.get('chainWin', 12), greeks = store.get('chainGreeks', true), full = store.get('chainFull', false), oiMode = 'oi', centerNext = true, lastKey = '';

export function init(sec) {
  root = sec;
  const symSel = el('select', { class: 'sel', id: 'chSym', 'aria-label': 'Underlying', onchange: (e) => { if (e.target.value === '__add') { e.target.value = S.symbol; stocks.open(); } else setSymbol(e.target.value); } });
  const expSel = el('select', { class: 'sel', id: 'chExp', 'aria-label': 'Expiry', onchange: (e) => { S.expiry[S.symbol] = e.target.value; centerNext = true; refresh(true); } });
  const winSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Strikes shown' }, [[8, '±8'], [12, '±12'], [20, '±20'], [999, 'All']].map(([n, t]) => el('button', { type: 'button', class: n === win ? 'on' : '', text: t, onclick: (e) => { win = n; store.set('chainWin', n); e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); centerNext = true; render(); } })));
  const viewSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Columns shown' }, [[false, 'Simple'], [true, 'Full detail']].map(([v, t]) => el('button', { type: 'button', class: v === full ? 'on' : '', text: t, title: v ? 'Show every column: change in OI, volume, bid and ask' : 'Show only the key columns', onclick: (e) => { full = v; store.set('chainFull', v); e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); render(); } })));
  const gBtn = el('label', { class: 'note', style: { display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } }, el('input', { type: 'checkbox', id: 'chGreeks', checked: greeks, onchange: (e) => { greeks = e.target.checked; store.set('chainGreeks', greeks); render(); } }), 'Show delta');
  statsBox = el('div', { class: 'grid', id: 'chStats' });
  tbody = el('tbody');
  const table = el('table', { class: 'chain' }, el('thead', { id: 'chHead' }), tbody);
  oiBox = el('div', { class: 'svgchart', id: 'oiChart' });
  const oiSeg = el('div', { class: 'seg' }, [['oi', 'Open interest'], ['chg', 'Change today']].map(([k, t]) => el('button', { type: 'button', class: k === oiMode ? 'on' : '', text: t, onclick: (e) => { oiMode = k; e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); drawOI(); } })));
  root.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-h' }, symSel, expSel, el('span', { class: 'note', id: 'chLeft' }), el('span', { class: 'sp' }), viewSeg, winSeg, gBtn),
      statsBox),
    el('div', { class: 'panel', style: { padding: '0' } },
      el('p', { class: 'note', id: 'chHint', hidden: true, style: { padding: '8px 12px', borderBottom: '1px solid var(--line)' }, text: 'The table is wider than your window. Hold Shift and scroll, or drag the bar at the bottom of the table, to see the far columns. "Simple" view shows fewer columns.' }),
      el('div', { class: 'tw chain-wrap', id: 'chWrap', style: { border: '0' } }, table)),
    el('div', { class: 'legend' },
      el('span', {}, el('i', { class: 'sw', style: { background: 'var(--itm)', outline: '1px solid var(--line)' } }), term('In the money', 'itm'), ' (worth something if it expired now)'),
      el('span', {}, el('i', { class: 'sw', style: { background: 'var(--accent)' } }), term('At the money', 'atm strike'), ' strike, closest to the index'),
      el('span', {}, el('i', { class: 'sw', style: { background: 'var(--down)', opacity: '.35' } }), 'Bar behind OI shows how many contracts are open')),
    el('p', { class: 'note', text: 'How to trade: hover a price and press B to buy or S to sell (on a phone, tap the buttons under the price). Click a price first to see its chart and Greeks. ' + (S.meta.replay ? 'Prices are that day\'s closes. Buys fill a little above the close and sells a little below (slippage); faded prices did not trade that day and cannot be filled.' : 'Buys fill at the ask, sells at the bid.') }),
    el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Where writers are positioned' }), el('span', { class: 'sp' }), oiSeg),
      el('div', { class: 'legend', style: { marginBottom: '6px' } }, el('span', {}, el('i', { class: 'sw', style: { background: 'var(--down)' } }), 'Calls (a ceiling: writers bet against a rise)'), el('span', {}, el('i', { class: 'sw', style: { background: 'var(--up)' } }), 'Puts (a floor: writers bet against a fall)')), oiBox),
    S.meta.replay ? null : expired.panel(),
  );
  on('symbol', () => { centerNext = true; if (S.tab === 'chain') { fillSelects(); refresh(true); } });
  on('universe', () => { if (S.tab === 'chain') fillSelects(); });
  on('expiries', () => { if (S.tab === 'chain') { fillSelects(); refresh(true); } });
  // Streamed prices: move the price cells in place (keeps the hover Buy/Sell buttons), with a brief flash.
  on('ticks', ({ options }) => {
    if (S.tab !== 'chain' || !chainData) return;
    for (const r of chainData.rows) for (const o of [r.ce, r.pe]) {
      if (!o || !options.has(o.id)) continue;
      const cell = tbody.querySelector(`td[data-id="${o.id}"]`); if (!cell) continue;
      const [p, ch] = cell.children, old = p.textContent, now = inr2.format(o.ltp);
      if (old === now) continue;
      p.textContent = now; ch.textContent = pct(o.pchg || 0, 1); ch.className = 'chg ' + tone(o.chg);
      cell.classList.remove('tick-up', 'tick-down'); void cell.offsetWidth; cell.classList.add(o.ltp > parseFloat(old.replace(/,/g, '')) ? 'tick-up' : 'tick-down');
    }
  });
}

function fillSelects() {
  const ss = $('#chSym'); ss.replaceChildren(...Object.entries(S.meta.indices).map(([k, v]) => new Option(v.short, k, false, k === S.symbol)), ...(stocks.available() ? [new Option('＋ Stock options…', '__add')] : []));
  const es = $('#chExp'); es.replaceChildren(...(S.expiries[S.symbol] || []).map((e) => new Option(fmtExpiryLong(e), e, false, e === S.expiry[S.symbol])));
  $('#chLeft').textContent = S.expiry[S.symbol] ? fmtLeft(S.expiry[S.symbol]) : '';
}

export async function show() { await loadExpiries().catch(() => {}); fillSelects(); refresh(true); if (!S.meta.replay) expired.show(); }
export function hide() {}
export function tick() { refresh(false); }

let chainData = null;
// What the options are on, in words: 'share' for a stock, 'index' otherwise.
const what = () => (cfg()?.kind === 'stock' ? 'share' : 'index');
async function refresh(force) {
  const sym = S.symbol, exp = S.expiry[sym]; if (!exp) return;
  try {
    const c = await loadChain(sym, exp, force);
    if (sym !== S.symbol || exp !== S.expiry[sym]) return;
    chainData = c; render(); drawOI();
  } catch (e) { tbody.replaceChildren(el('tr', {}, el('td', { colspan: '19', class: 'empty t', text: `Could not load the chain: ${e.message}` }))); }
}

function render() {
  const c = chainData; if (!c || !c.rows.length) return;
  $('#chLeft').textContent = fmtLeft(c.expiry);
  const spot = c.spot; const T = yearsTo(c.expiry); const r = S.meta.riskFree;
  const atmIdx = c.rows.reduce((bi, row, i) => (Math.abs(row.strike - spot) < Math.abs(c.rows[bi].strike - spot) ? i : bi), 0);
  const rows = win >= 999 ? c.rows : c.rows.slice(Math.max(0, atmIdx - win), atmIdx + win + 1);
  const atm = c.rows[atmIdx];
  const ivA = [atm.ce?.iv, atm.pe?.iv].filter((x) => x > 0); const atmIv = ivA.length ? ivA.reduce((a, b) => a + b) / ivA.length : 13;
  const maxOi = Math.max(1, ...rows.map((x) => Math.max(x.ce?.oi || 0, x.pe?.oi || 0)));
  const key = `${c.symbol}|${c.expiry}|${win}|${greeks}|${full}`;

  const callCols = ['OI', ...(full ? ['Chg OI', 'Volume'] : []), 'IV', ...(greeks ? ['Delta'] : []), ...(full ? ['Bid', 'Ask'] : []), 'LTP'];
  const head = (h) => el('th', {}, term(h === 'LTP' ? 'Price' : h, h));
  if (key !== lastKey) {
    $('#chHead').replaceChildren(
      el('tr', {}, el('th', { class: 'side ce', colspan: String(callCols.length) }, term('Calls', 'call'), ` · gain if the ${what()} rises`), el('th', { class: 'side', text: '' }), el('th', { class: 'side pe', colspan: String(callCols.length) }, term('Puts', 'put'), ` · gain if the ${what()} falls`)),
      el('tr', {}, ...callCols.map(head), el('th', { style: { textAlign: 'center' } }, term('Strike')), ...[...callCols].reverse().map(head)));
  }
  const frag = [];
  let spotPlaced = false;
  for (const row of rows) {
    if (!spotPlaced && row.strike > spot) { frag.push(spotRow(callCols.length * 2 + 1, spot)); spotPlaced = true; }
    const tr = el('tr', { class: row === atm ? 'atm' : '' });
    for (const t of ['CE', 'PE']) {
      const o = t === 'CE' ? row.ce : row.pe; const itm = t === 'CE' ? row.strike < spot : row.strike > spot;
      const cells = [];
      const td = (txt, cls = '') => el('td', { class: (itm ? 'itm ' : '') + cls, text: txt });
      if (!o) { for (let i = 0; i < callCols.length; i++) cells.push(td('—')); }
      else {
        const oiTd = td(compact.format(o.oi), t === 'CE' ? 'ce-oi' : 'pe-oi'); oiTd.prepend(el('span', { class: 'oibar', style: { width: `${(o.oi / maxOi) * 100}%` } }));
        const iv = o.iv > 0 ? o.iv : atmIv;
        const delta = bs(t, spot, row.strike, T, r, iv / 100).delta;
        const ltp = el('td', { 'data-id': o.id || null, class: (itm ? 'itm ' : '') + `ltp act ${t === 'CE' ? 'ce-ltp' : 'pe-ltp'}` + (o.traded === false ? ' notraded' : ''), title: o.traded === false ? 'No trades in this option on this day, so it cannot be bought or sold in replay. The price shown is NSE\'s settlement estimate.' : 'Click for chart and Greeks', onclick: (e) => { if (!e.target.closest('.bs')) drawer.open({ symbol: c.symbol, expiry: c.expiry, strike: row.strike, type: t }); } },
          el('span', { text: inr2.format(o.ltp) }), el('span', { class: 'chg ' + tone(o.chg), text: pct(o.pchg || (o.ltp - o.chg ? (o.chg / (o.ltp - o.chg)) * 100 : 0), 1) }),
          el('span', { class: 'bs' }, el('button', { class: 'b', type: 'button', title: 'Buy', text: 'B', onclick: () => ticket.open({ symbol: c.symbol, expiry: c.expiry, strike: row.strike, type: t, side: 'BUY' }) }), el('button', { class: 's', type: 'button', title: 'Sell', text: 'S', onclick: () => ticket.open({ symbol: c.symbol, expiry: c.expiry, strike: row.strike, type: t, side: 'SELL' }) })));
        cells.push(oiTd);
        if (full) cells.push(td((o.chgOi > 0 ? '+' : '') + compact.format(o.chgOi), tone(o.chgOi)), td(compact.format(o.vol)));
        cells.push(td(o.iv > 0 ? o.iv.toFixed(1) : '—'));
        if (greeks) cells.push(td((Math.abs(delta) < 0.005 ? 0 : delta).toFixed(2)));
        if (full) cells.push(td(o.bid ? inr2.format(o.bid) : '—'), td(o.ask ? inr2.format(o.ask) : '—'));
        cells.push(ltp);
      }
      if (t === 'CE') { tr.append(...cells, el('td', { class: 'k', text: inr0.format(row.strike) })); }
      else tr.append(...cells.reverse());
    }
    frag.push(tr);
  }
  if (!spotPlaced) frag.push(spotRow(callCols.length * 2 + 1, spot));
  tbody.replaceChildren(...frag);
  lastKey = key;
  const w = $('#chWrap'); const wide = w.scrollWidth > w.clientWidth + 1;
  $('#chHint').hidden = !wide;
  // Start centred on the ATM row and, when the table is too wide, on the strike column so both sides peek out.
  if (centerNext) { centerNext = false; const a = tbody.querySelector('tr.atm'); if (a) w.scrollTop = Math.max(0, a.offsetTop - w.clientHeight / 2); if (wide) w.scrollLeft = (w.scrollWidth - w.clientWidth) / 2; }

  const tot = c.rows.reduce((a, x) => ({ ce: a.ce + (x.ce?.oi || 0), pe: a.pe + (x.pe?.oi || 0) }), { ce: 0, pe: 0 });
  let mp = null, best = Infinity;
  for (const x of c.rows) { let pay = 0; for (const y of c.rows) pay += (y.ce?.oi || 0) * Math.max(x.strike - y.strike, 0) + (y.pe?.oi || 0) * Math.max(y.strike - x.strike, 0); if (pay < best) { best = pay; mp = x.strike; } }
  const straddle = (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0);
  const stat = (k, v, s) => el('div', { class: 'stat' }, el('div', { class: 'k' }, term(k)), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null);
  statsBox.replaceChildren(
    stat('Spot', inr2.format(spot), c.timestamp ? `As of ${String(c.timestamp).split(' ').pop()} IST` : S.meta.replay ? 'Index close that day' : ''),
    stat('ATM strike', inr0.format(atm.strike), `Straddle ₹${inr2.format(straddle)}`),
    stat('ATM implied vol', atmIv.toFixed(1) + '%', `Expected move ±${pts(spot * atmIv / 100 * Math.sqrt(T))}`),
    stat('Put–call ratio', tot.ce ? (tot.pe / tot.ce).toFixed(2) : '—', tot.ce ? (tot.pe > tot.ce ? 'More puts open than calls' : 'More calls open than puts') : ''),
    stat('Max pain', inr0.format(mp), 'Where most options expire worthless'),
    stat('Lot size', String(cfg(c.symbol).lot), `1 point = ₹${cfg(c.symbol).lot} per lot`),
  );
}

function spotRow(span, spot) { return el('tr', { class: 'spot' }, el('td', { colspan: String(span) }, el('div', {}, el('span', { text: `Spot ${inr2.format(spot)}` })))); }

function drawOI() {
  const c = chainData; if (!c) return;
  const spot = c.spot;
  const atmIdx = c.rows.reduce((bi, row, i) => (Math.abs(row.strike - spot) < Math.abs(c.rows[bi].strike - spot) ? i : bi), 0);
  const rows = c.rows.slice(Math.max(0, atmIdx - 15), atmIdx + 16);
  const W = Math.max(320, oiBox.clientWidth || 800), H = 240, m = { l: 52, r: 8, t: 10, b: 24 };
  const val = (o) => (oiMode === 'oi' ? o?.oi || 0 : o?.chgOi || 0);
  const vals = rows.flatMap((r) => [val(r.ce), val(r.pe)]);
  const lo = Math.min(0, ...vals), hi = Math.max(1, ...vals);
  const X = (i) => m.l + (i + 0.5) * (W - m.l - m.r) / rows.length, bw = Math.max(2, (W - m.l - m.r) / rows.length * 0.38);
  const Y = (v) => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
  const NS = 'http://www.w3.org/2000/svg'; const mk = (t, a, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Open interest by strike' });
  const ticks = 4; for (let i = 0; i <= ticks; i++) { const v = lo + (hi - lo) * i / ticks; svg.append(mk('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }), mk('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)', 'font-family': 'var(--mono)' }, compact.format(v))); }
  svg.append(mk('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: 'var(--muted)' }));
  const every = Math.ceil(rows.length / Math.floor((W - m.l) / 52));
  rows.forEach((r, i) => {
    const vc = val(r.ce), vp = val(r.pe);
    svg.append(mk('rect', { x: X(i) - bw, y: Math.min(Y(vc), Y(0)), width: bw - 1, height: Math.abs(Y(vc) - Y(0)), fill: 'var(--down)', rx: 1.5 }));
    svg.append(mk('rect', { x: X(i) + 1, y: Math.min(Y(vp), Y(0)), width: bw - 1, height: Math.abs(Y(vp) - Y(0)), fill: 'var(--up)', rx: 1.5 }));
    if (i % every === 0) svg.append(mk('text', { x: X(i), y: H - 7, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)', 'font-family': 'var(--mono)' }, inr0.format(r.strike)));
  });
  const xs = (s) => { const a = rows[0].strike, b = rows[rows.length - 1].strike; return X(0) + (s - a) / (b - a) * (X(rows.length - 1) - X(0)); };
  svg.append(mk('line', { x1: xs(spot), x2: xs(spot), y1: m.t, y2: H - m.b, stroke: 'var(--accent)', 'stroke-dasharray': '4 3', 'stroke-width': 1.5 }));
  svg.append(mk('text', { x: Math.min(xs(spot) + 4, W - 80), y: m.t + 10, 'font-size': 11, fill: 'var(--accent-text)', 'font-family': 'var(--mono)' }, `Spot ${inr0.format(spot)}`));
  oiBox.replaceChildren(svg);
}
