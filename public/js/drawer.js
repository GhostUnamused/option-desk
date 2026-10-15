// Option detail drawer: live quote, intraday chart, Greeks per lot, Buy/Sell.
import { api, el, $, inr2, inr0, compact, pct, tone, rs, srs, instrument, themeColors, fmtLeft } from './util.js';
import { term } from './glossary.js';
import { S, emit, cfg, loadChain } from './state.js';
import { bs, yearsTo } from './bs.js';
import * as ticket from './ticket.js';
import { hexA } from './markets.js';
import { candleChart } from './candles.js';

let cur = null, chart = null, ser = null, timer = null, cc = null, range = '1D';
// INDstocks contracts have candle history (1D/5D/1M/life); NSE-website and replay ones only today's line.
const RANGES = [['1D', 'Today, by the minute'], ['5D', 'Last 5 days, 5-minute candles'], ['1M', 'Last month, hourly candles'], ['life', 'Since the contract was listed, daily candles']];
const hasCandles = (id) => /^[NB]FO_\d+$/.test(id || '') && !S.meta.replay;

export function open(leg) {
  cur = leg;
  const d = $('#drawer'); d.hidden = false;
  const close = el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: closeDrawer });
  d.replaceChildren(
    el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: instrument(leg) }), el('div', { class: 'note', text: fmtLeft(leg.expiry) })), close),
    el('div', { class: 'drawer-b' },
      el('div', {}, el('span', { class: 'big', id: 'drLtp', text: '—' }), ' ', el('span', { class: 'mono', id: 'drChg' })),
      el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { class: 'btn buy', type: 'button', text: 'Buy', onclick: () => ticket.open({ ...leg, side: 'BUY' }) }),
        el('button', { class: 'btn sell', type: 'button', text: 'Sell', onclick: () => ticket.open({ ...leg, side: 'SELL' }) }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Add to strategy', onclick: () => { emit('addLeg', { ...leg, side: 'BUY', lots: 1 }); emit('goto', 'strategy'); closeDrawer(); } })),
      el('div', { class: 'seg', id: 'drRange', hidden: true, role: 'group', 'aria-label': 'Chart range' }, RANGES.map(([r, t]) => el('button', { type: 'button', 'data-r': r, title: t, class: r === range ? 'on' : '', text: r === 'life' ? 'Life' : r, onclick: () => { range = r; $('#drRange').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.r === r)); loadCandles(cur, true); } }))),
      el('div', { class: 'chart', id: 'drChart', style: { height: '260px' } }),
      el('p', { class: 'note', id: 'drChartNote', text: 'Today\'s price, one point per trade print.' }),
      el('div', { class: 'kv', id: 'drKv' }),
      el('div', { class: 'kv', id: 'drGreeks' }),
      el('p', { class: 'note', text: 'Greeks are shown for one lot. Delta: rupees gained per 1-point rise in the index. Theta: rupees lost per day from time passing. Vega: rupees gained if implied volatility rises by 1 point.' }),
    ));
  if (chart) { chart.remove(); chart = null; }
  if (cc) { cc.remove(); cc = null; }
  candleId = null;
  const c = themeColors();
  chart = LightweightCharts.createChart($('#drChart'), { autoSize: true, layout: { attributionLogo: false, background: { type: 'solid', color: c.bg }, textColor: c.muted, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', fontSize: 11 }, grid: { vertLines: { visible: false }, horzLines: { color: c.grid } }, rightPriceScale: { borderColor: c.line }, timeScale: { borderColor: c.line, timeVisible: !S.meta.replay } });
  ser = chart.addAreaSeries({ lineColor: c.accent, topColor: hexA(c.accent, .25), bottomColor: hexA(c.accent, .02), lineWidth: 2 });
  update(true);
  clearInterval(timer); timer = setInterval(() => !document.hidden && update(false), 5000);
  document.addEventListener('keydown', esc);
}

// Candles from INDstocks for the chosen range. The first time it swaps the line chart for a candle chart.
let candleId = null;
async function loadCandles(leg, fit, id = candleId) {
  if (!leg || !id) return;
  candleId = id;
  if (!cc) { if (chart) { chart.remove(); chart = null; } cc = candleChart($('#drChart'), { height: 260 }); $('#drRange').hidden = false; }
  try {
    const d = await api(`/api/option-candles?id=${encodeURIComponent(id)}&range=${range}`);
    if (leg !== cur) return;
    cc.set(d.candles, { fit, daily: d.interval === '1day' });
    $('#drChartNote').textContent = d.candles.length ? RANGES.find(([r]) => r === range)[1] + '. Green candles closed higher than they opened. Bars along the bottom show how much traded.' : 'No trades in this range yet.';
  } catch (e) { $('#drChartNote').textContent = `Could not load the chart: ${e.message}`; }
}

function esc(e) { if (e.key === 'Escape' && !$('#ticket').open) closeDrawer(); }
export function closeDrawer() { $('#drawer').hidden = true; clearInterval(timer); cur = null; document.removeEventListener('keydown', esc); }

let n = 0;
async function update(first) {
  const leg = cur; if (!leg) return;
  try {
    const c = await loadChain(leg.symbol, leg.expiry);
    if (leg !== cur) return;
    const row = c.rows.find((r) => r.strike === leg.strike); const o = row && (leg.type === 'CE' ? row.ce : row.pe);
    if (!o) return;
    $('#drLtp').textContent = '₹' + inr2.format(o.ltp);
    const ch = $('#drChg'); ch.textContent = `${o.chg >= 0 ? '+' : '−'}${inr2.format(Math.abs(o.chg))} (${pct(o.pchg || 0)})`; ch.className = 'mono ' + tone(o.chg);
    const lot = cfg(leg.symbol).lot; const T = yearsTo(leg.expiry); const iv = (o.iv > 0 ? o.iv : 13) / 100;
    const g = bs(leg.type, c.spot, leg.strike, T, S.meta.riskFree, iv);
    const kv = (k, v) => [el('span', { class: 'k' }, term(k)), el('span', { class: 'v', text: v })];
    const be = leg.type === 'CE' ? leg.strike + o.ltp : leg.strike - o.ltp;
    $('#drKv').replaceChildren(...kv(S.meta.replay ? 'Sell / buy fill' : 'Bid / ask', `${inr2.format(o.bid)} / ${inr2.format(o.ask)}`), ...kv('Implied vol', o.iv > 0 ? o.iv.toFixed(2) + '%' : 'not reported'), ...kv('Open interest', `${inr0.format(o.oi)} (${o.chgOi >= 0 ? '+' : ''}${compact.format(o.chgOi)} today)`), ...kv('Volume', inr0.format(o.vol) + (S.meta.replay && !o.vol ? ' (cannot trade today)' : '')),
      ...kv('Spot', inr2.format(c.spot)), ...kv('Cost of one lot', `${rs(o.ask * lot)} to buy`), ...kv('Breakeven at expiry (buyer)', inr2.format(be)), ...kv('Model price at this IV', '₹' + inr2.format(g.price)));
    $('#drGreeks').replaceChildren(...kv('Delta (per lot)', `${srs(g.delta * lot)} per point · ${g.delta.toFixed(2)}`), ...kv('Theta (per lot)', `${srs(g.theta * lot)} per day`), ...kv('Vega (per lot)', `${srs(g.vega * lot)} per vol point`), ...kv('Gamma', g.gamma.toFixed(5)));
    if (hasCandles(o.id)) { if (first || candleId !== o.id || (range === '1D' && ++n % 2 === 0)) await loadCandles(leg, first || candleId !== o.id, o.id); }
    else if (first || ++n % 2 === 0) {
      const d = await api(`/api/option-intraday?id=${encodeURIComponent(o.id)}`);
      if (leg !== cur) return;
      ser.setData(d.points.map((p) => ({ time: p.t, value: p.v })));
      if (first) chart.timeScale().fitContent();
      $('#drChartNote').textContent = d.daily ? 'This option\'s daily price up to this day.' : d.points.length ? 'Today\'s traded price for this option.' : 'No trades yet today for this option.';
    }
  } catch (e) { $('#drChartNote').textContent = `Could not update: ${e.message}`; }
}
