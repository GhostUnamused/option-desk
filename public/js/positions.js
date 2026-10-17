// Paper account tab: balances, open positions with live P&L, portfolio payoff, equity curve, orders, reset.
import { api, el, $, inr0, inr2, rs, srs, pct, tone, instrument, fmtWhen, fmtLeft, toast, themeColors } from './util.js';
import { term } from './glossary.js';
import { S, on, emit, cfg, refreshAccount } from './state.js';
import { bs, yearsTo } from './bs.js';
import { drawPayoff, payoffLegend } from './payoff.js';
import { hexA } from './markets.js';
import * as drawer from './drawer.js';

let root, eqChart = null, eqSeries = null, group = null, resetArmed = false, exitDlg;

export function init(sec) {
  root = sec;
  exitDlg = el('dialog', { class: 'exit-rule-dialog', 'aria-label': 'Stop-loss and take-profit rules' });
  document.body.append(exitDlg);
  exitDlg.addEventListener('click', (e) => { if (e.target === exitDlg) exitDlg.close(); });
  root.append(
    el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: S.meta.replay ? 'Replay account' : 'Paper account' }), el('span', { class: 'note', id: 'acSince' })), el('div', { class: 'grid', id: 'acStats' })),
    el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Open positions' }), el('span', { class: 'sp' }), el('span', { class: 'note', text: S.meta.replay ? (S.meta.replay.intraday ? 'Marked at the last trade before the replay minute (the closing price once the day ends).' : 'Marked at the day\'s closing price.') : 'Marked at the live bid–ask midpoint. Refreshes every 5 s.' }), el('button', { class: 'btn danger sm', type: 'button', id: 'acExitAll', text: 'Exit all', onclick: exitAll })),
      el('div', { class: 'tw' }, el('table', { id: 'acPos' }))),
    el('div', { class: 'cols' },
      el('div', { class: 'panel', id: 'acPayPanel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'What your positions do at expiry' }), el('span', { class: 'sp' }), el('select', { class: 'sel', id: 'acGroup', 'aria-label': 'Position group', onchange: (e) => { group = e.target.value; renderPayoff(); } })),
        payoffLegend('Today'), el('div', { class: 'svgchart', id: 'acPayoff', style: { marginTop: '8px' } })),
      el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Account value over time' })), el('div', { class: 'chart', id: 'acEq', style: { height: '260px' } }), el('p', { class: 'note', id: 'acEqNote', style: { marginTop: '6px' } }))),
    el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Order history' })), el('div', { class: 'tw', style: { maxHeight: '420px' } }, el('table', { id: 'acOrders' }))),
    S.meta.replay ? '' : el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Start over' }), el('span', { class: 'note', text: 'Closes everything and resets your dummy balance. This cannot be undone.' })),
      el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' } },
        el('label', { class: 'f', for: 'acBal' }, 'Starting balance (₹)', el('input', { class: 'inp', id: 'acBal', type: 'number', step: '50000', min: '10000', value: '500000' })),
        el('button', { class: 'btn danger', type: 'button', id: 'acReset', text: 'Reset account', onclick: reset }))),
  );
  on('account', () => { if (S.tab === 'positions') render(); });
}

export function show() { if (!eqChart) makeEq(); refreshAccount(true).catch((e) => toast(e.message, 'err')); }
export function hide() {}
export function tick() { return refreshAccount(); }

function makeEq() {
  const c = themeColors();
  eqChart = LightweightCharts.createChart($('#acEq'), { autoSize: true, layout: { attributionLogo: false, background: { type: 'solid', color: c.bg }, textColor: c.muted, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', fontSize: 12 }, grid: { vertLines: { visible: false }, horzLines: { color: c.grid } }, rightPriceScale: { borderColor: c.line }, timeScale: { borderColor: c.line, timeVisible: true }, localization: { priceFormatter: (p) => '₹' + inr0.format(p) } });
  eqSeries = eqChart.addAreaSeries({ lineColor: c.accent, topColor: hexA(c.accent, .22), bottomColor: hexA(c.accent, .02), lineWidth: 2 });
}

function render() {
  const a = S.account; if (!a) return;
  const stat = (k, v, cls, s) => el('div', { class: 'stat' }, el('div', { class: 'k' }, term(k)), el('div', { class: 'v ' + (cls || ''), text: v }), s ? el('div', { class: 's', text: s }) : null);
  $('#acSince').textContent = `Started ${fmtWhen(Date.parse(a.createdAt), S.meta.replay)} with ${rs(a.startBalance)}`;
  $('#acStats').replaceChildren(
    stat('Account value', rs(a.equity), '', 'Cash plus what your positions are worth now'),
    stat('Total P&L', srs(a.totalPnl), tone(a.totalPnl), pct(a.totalPnl / a.startBalance * 100) + ' since start'),
    stat('Open P&L', srs(a.unrealized), tone(a.unrealized), 'On positions still open'),
    stat('Booked P&L', srs(a.realized), tone(a.realized), 'From closed and expired trades'),
    stat('Charges paid', rs(a.charges), '', chargeSplit(a)),
    stat('Margin blocked', rs(a.margin), '', 'Estimate for sold options'),
    stat('Free to trade', rs(a.available), a.available < 0 ? 'down' : ''),
  );
  // Positions
  const t = $('#acPos');
  t.replaceChildren(el('thead', {}, el('tr', {}, ['Instrument', 'Expiry', 'Lots', 'Avg price', 'Now', 'Bid / ask', 'P&L', 'Return / stop-loss & target', 'Action'].map((h, i) => el('th', { class: i < 2 || i === 7 ? 'l' : '' }, term(h))))));
  const tb = el('tbody');
  for (const p of a.positions) {
    const cost = Math.abs(p.avg * p.qty);
    tb.append(el('tr', {},
      el('td', { class: 'l t' }, el('span', { class: 'pill ' + (p.qty > 0 ? 'ok' : 'bad'), text: p.qty > 0 ? 'Long' : 'Short' }), ' ', el('button', { class: 'linkbtn', type: 'button', title: 'Open this option\'s price chart and details', text: `${p.symbol} ${inr0.format(p.strike)} ${p.type}`, onclick: () => drawer.open({ symbol: p.symbol, expiry: p.expiry, strike: p.strike, type: p.type }) })),
      el('td', { class: 'l t', text: `${p.expiry.slice(8)}/${p.expiry.slice(5, 7)} · ${fmtLeft(p.expiry)}` }),
      el('td', { text: `${p.qty > 0 ? '+' : '−'}${p.lots} (${Math.abs(p.qty)})` }), el('td', { text: inr2.format(p.avg) }), el('td', { text: inr2.format(p.mark) }),
      el('td', { class: 'muted', text: p.bid != null ? `${inr2.format(p.bid)} / ${inr2.format(p.ask)}` : '—' }),
      el('td', { class: tone(p.pnl), text: srs(p.pnl) }),
      el('td', { class: 'l exit-rule-cell' },
        el('span', { class: 'muted', text: cost ? pct(p.pnl / cost * 100, 1) : '' }),
        el('div', { class: 'note exit-rule-summary' }, exitRuleText(p).map((t) => el('div', { text: t }))), exitTrack(p),
        el('button', { class: 'btn ghost sm', type: 'button', text: p.exitRules ? 'Edit stop-loss / target' : 'Add stop-loss / target', onclick: () => editExitRules(p) })),
      el('td', {}, el('button', { class: 'btn ghost sm', type: 'button', text: 'Exit', onclick: (e) => exitOne(p, e.target) }))));
  }
  if (!a.positions.length) tb.append(el('tr', {}, el('td', { class: 'l t empty', colspan: '9', text: 'No open positions. Buy or sell from the option chain, or place a strategy from the builder.' })));
  else tb.append(el('tr', {}, el('td', { class: 'l t', colspan: '6', text: 'Total' }), el('td', { class: tone(a.unrealized), text: srs(a.unrealized) }), el('td', { colspan: '2' })));
  t.append(tb);
  $('#acExitAll').hidden = !a.positions.length;
  renderPayoff();
  // Equity curve (shift to IST so the axis shows Indian time)
  const pts = []; for (const e of a.equityCurve) { const tt = Math.floor(e.t / 1000) + 19800; if (pts.length && pts[pts.length - 1].time >= tt) continue; pts.push({ time: tt, value: e.v }); }
  eqSeries.setData(pts); eqChart.timeScale().fitContent();
  eqSeries.applyOptions({ lineColor: a.equity >= a.startBalance ? themeColors().up : themeColors().down });
  $('#acEqNote').textContent = S.meta.replay ? `One point per replay day (${pts.length} so far), at each day's close${S.meta.replay.intraday ? ' (the latest minute for the day that is running)' : ''}.` : `${pts.length} snapshots, recorded after every order and every few minutes while the app is open.`;
  // Orders
  const o = $('#acOrders');
  o.replaceChildren(el('thead', {}, el('tr', {}, ['Time', 'Instrument', 'Side', 'Lots', 'Price', 'Charges', 'Booked P&L', 'Note'].map((h, i) => el('th', { class: i < 3 || i === 7 ? 'l' : '' }, term(h))))),
    el('tbody', {}, a.orders.length ? a.orders.map((x) => el('tr', {}, el('td', { class: 'l', text: fmtWhen(x.t, S.meta.replay) }), el('td', { class: 'l t', text: instrument(x) }),
      el('td', { class: 'l ' + (x.side === 'BUY' ? 'up' : 'down'), text: x.side === 'BUY' ? 'Buy' : 'Sell' }), el('td', { text: String(x.lots) }), el('td', { text: inr2.format(x.price) }), el('td', { text: inr2.format(x.charges) }),
      el('td', { class: tone(x.realized), text: x.realized ? srs(x.realized) : '' }), el('td', { class: 'l t muted wrap' }, [x.tag, x.note, x.plan ? `Exit plan: ${x.plan}` : ''].filter(Boolean).join(' · '), x.explanation ? explainPnl(x.explanation) : null))) : [el('tr', {}, el('td', { class: 'l t empty', colspan: '8', text: 'No orders yet.' }))]));
}

// Lines for the positions table: each trigger and how far the option's price is from it now.
function exitRuleText(p) {
  const r = p.exitRules; if (!r) return ['No stop-loss or target'];
  const away = (lvl) => (p.mark > 0 ? ` (${Math.abs((lvl / p.mark - 1) * 100).toFixed(0)}% away)` : '');
  return [r.stop != null ? `Stop-loss ₹${inr2.format(r.stop)}${away(r.stop)}` : '', r.target != null ? `Target ₹${inr2.format(r.target)}${away(r.target)}` : ''].filter(Boolean);
}

// A small track from stop-loss to target with the entry and the current price on it, so you can see which is closer.
function exitTrack(p) {
  const r = p.exitRules; if (r?.stop == null || r?.target == null) return null;
  const lo = Math.min(r.stop, r.target), hi = Math.max(r.stop, r.target), at = (v) => `${Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100))}%`;
  const stopLeft = r.stop < r.target;
  return el('div', { class: 'exit-track', title: `Stop-loss ₹${inr2.format(r.stop)} · entry ₹${inr2.format(p.avg)} · now ₹${inr2.format(p.mark)} · target ₹${inr2.format(r.target)}` },
    el('span', { class: 'et-bar', style: { background: `linear-gradient(90deg, ${stopLeft ? 'var(--down-soft), var(--up-soft)' : 'var(--up-soft), var(--down-soft)'})` } }),
    el('span', { class: 'et-entry', style: { left: at(p.avg) } }), el('span', { class: 'et-now', style: { left: at(p.mark) } }));
}

const toTick = (v) => Math.max(0.05, Math.round(v * 20) / 20);

function editExitRules(p) {
  const long = p.qty > 0, units = Math.abs(p.qty), cost = p.avg * units;
  const stop = el('input', { class: 'inp', id: 'exitStop', type: 'number', min: '0.05', step: '0.05', value: p.exitRules?.stop ?? '', placeholder: 'Blank = none' });
  const target = el('input', { class: 'inp', id: 'exitTarget', type: 'number', min: '0.05', step: '0.05', value: p.exitRules?.target ?? '', placeholder: 'Blank = none' });
  // Quick picks are a percentage move in the option's price from your entry price.
  const chip = (input, move) => el('button', { class: 'chip', type: 'button', text: `${move > 0 ? '+' : '−'}${Math.abs(move)}%`, title: `₹${inr2.format(toTick(p.avg * (1 + move / 100)))}: the option's price ${move > 0 ? 'up' : 'down'} ${Math.abs(move)}% from your entry`,
    onclick: () => { input.value = toTick(p.avg * (1 + move / 100)).toFixed(2); update(); } });
  const stopChips = (long ? [-20, -30, -50] : [25, 50, 100]).map((m) => chip(stop, m));
  const targetChips = (long ? [25, 50, 100] : [-25, -50, -75]).map((m) => chip(target, m));
  const outcome = el('div', { class: 'exit-outcome' });
  const chartBox = el('div', { class: 'exit-chart' }), chartNote = el('p', { class: 'note', text: 'Loading this option\'s price…' });
  let chart = null, series = null;
  const lines = {};

  const num = (input) => (input.value === '' ? null : Number(input.value));
  function update() {
    const sv = num(stop), tv = num(target);
    // The chart's horizontal lines follow what you type.
    if (series) {
      for (const k of Object.keys(lines)) { series.removePriceLine(lines[k]); delete lines[k]; }
      const c = themeColors();
      lines.entry = series.createPriceLine({ price: p.avg, color: c.muted, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: long ? 'Bought at' : 'Sold at' });
      if (sv > 0) lines.stop = series.createPriceLine({ price: sv, color: c.down, lineWidth: 2, axisLabelVisible: true, title: 'Stop-loss' });
      if (tv > 0) lines.target = series.createPriceLine({ price: tv, color: c.up, lineWidth: 2, axisLabelVisible: true, title: 'Target' });
    }
    const pnl = (lvl) => (lvl - p.avg) * p.qty;
    const rows = [];
    const warn = (t) => rows.push(el('p', { class: 'exit-warn', text: t }));
    const line = (k, lvl) => el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v ' + tone(pnl(lvl)), text: `about ${srs(pnl(lvl))} (${pct(pnl(lvl) / cost * 100, 0)})` }));
    if (sv > 0) {
      rows.push(line('If the stop-loss is hit', sv));
      if (long ? sv >= p.mark : sv <= p.mark) warn(`The option is already at ₹${inr2.format(p.mark)}, ${long ? 'at or below' : 'at or above'} this stop-loss, so it would close the position on the next check.`);
    }
    if (tv > 0) {
      rows.push(line('If the target is hit', tv));
      if (long ? tv <= p.mark : tv >= p.mark) warn(`The option is already at ₹${inr2.format(p.mark)}, ${long ? 'at or above' : 'at or below'} this target, so it would close the position on the next check.`);
    }
    if (sv > 0 && tv > 0 && pnl(sv) < 0 && pnl(tv) > 0) rows.push(el('div', { class: 'kv' }, el('span', { class: 'k' }, term('Reward to risk')), el('span', { class: 'v', text: `${(pnl(tv) / -pnl(sv)).toFixed(1)} : 1` })));
    if (!rows.length) rows.push(el('p', { class: 'note', text: 'No exits set. Pick a stop-loss, a target, or both.' }));
    else rows.push(el('p', { class: 'note', text: 'Before charges. The exit is a market order, so a fast move can fill a little worse than the trigger price.' }));
    outcome.replaceChildren(...rows);
  }
  stop.addEventListener('input', update); target.addEventListener('input', update);

  const save = el('button', { class: 'btn', type: 'button', text: 'Save', onclick: async (e) => {
    if ((stop.value && !stop.reportValidity()) || (target.value && !target.reportValidity())) return;
    e.target.disabled = true;
    try {
      const result = await api('/api/exit-rules', { key: p.key, stop: stop.value, target: target.value });
      S.account = result.account; emit('account', result.account); exitDlg.close();
      toast(stop.value || target.value ? 'Stop-loss and target saved.' : 'Stop-loss and target removed.', 'ok');
    } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  } });
  const clear = el('button', { class: 'btn ghost', type: 'button', text: 'Remove both', hidden: !p.exitRules, onclick: () => { stop.value = ''; target.value = ''; update(); save.click(); } });
  const explain = long
    ? 'Like a broker\'s stop-loss + target (Zerodha calls it a GTT OCO order): two trigger prices on this option. If its price falls to the stop-loss, the position is sold to cap your loss. If it rises to the target, it is sold to book the profit. Whichever comes first wins and the other is cancelled.'
    : 'Like a broker\'s stop-loss + target (Zerodha calls it a GTT OCO order): two trigger prices on this option. You sold it, so you lose when its price rises. If it rises to the stop-loss, the position is bought back to cap your loss. If it falls to the target, it is bought back to book the profit. Whichever comes first wins and the other is cancelled.';
  exitDlg.replaceChildren(
    el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: 'Stop-loss and target' }),
      el('div', { class: 'note', text: `${long ? 'Bought' : 'Sold'} ${p.symbol} ${inr0.format(p.strike)} ${p.type} · ${p.lots} lot${p.lots === 1 ? '' : 's'} (${units}) at ₹${inr2.format(p.avg)} · now ₹${inr2.format(p.mark)}` })),
      el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => exitDlg.close() })),
    el('div', { class: 'exit-rule-body' },
      el('p', { class: 'note', text: explain }),
      chartBox, chartNote,
      el('div', { class: 'exit-fields' },
        el('div', {}, el('label', { class: 'f', for: 'exitStop' }, `Stop-loss, ${long ? 'below' : 'above'} ₹${inr2.format(p.mark)}`, stop), el('div', { class: 'chips' }, stopChips)),
        el('div', {}, el('label', { class: 'f', for: 'exitTarget' }, `Target, ${long ? 'above' : 'below'} ₹${inr2.format(p.mark)}`, target), el('div', { class: 'chips' }, targetChips))),
      outcome,
      el('p', { class: 'note', text: S.meta.replay ? 'Replay checks the triggers at every step, using the option\'s last traded price.' : 'Checked every few seconds against the option\'s last traded price while the market is open and the app is running. A real broker checks on its servers even when your app is closed.' })),
    el('div', { class: 'tk-f' }, clear, el('span', { class: 'sp' }), el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => exitDlg.close() }), save));
  exitDlg.onclose = () => { if (chart) { chart.remove(); chart = null; series = null; } };
  if (!exitDlg.open) exitDlg.showModal();

  // This option's price so far (today's minutes, or its daily closes in end-of-day replay), with the trigger lines on it.
  const c = themeColors();
  chart = LightweightCharts.createChart(chartBox, { autoSize: true, layout: { attributionLogo: false, background: { type: 'solid', color: 'transparent' }, textColor: c.muted, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', fontSize: 11 }, grid: { vertLines: { visible: false }, horzLines: { color: c.grid } }, rightPriceScale: { borderColor: c.line, scaleMargins: { top: 0.12, bottom: 0.12 } }, timeScale: { borderColor: c.line, timeVisible: true }, localization: { priceFormatter: (v) => '₹' + inr2.format(v) }, handleScroll: false, handleScale: false });
  // Keep every trigger line in view even when the price never came near it.
  series = chart.addLineSeries({ color: c.accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    autoscaleInfoProvider: (orig) => { const r = orig(); if (!r) return r; const lv = [p.avg, num(stop), num(target)].filter((v) => v > 0); return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...lv), maxValue: Math.max(r.priceRange.maxValue, ...lv) } }; } });
  update();
  if (!p.id) { chartNote.textContent = 'No price history for this option.'; return; }
  const mine = chart;
  api(`/api/option-intraday?id=${encodeURIComponent(p.id)}`).then((d) => {
    if (chart !== mine) return;
    const seen = new Set(), pts = d.points.filter((x) => !seen.has(x.t) && seen.add(x.t)).map((x) => ({ time: x.t, value: x.v }));
    series.setData(pts); chart.timeScale().fitContent(); update();
    chartNote.textContent = !pts.length ? 'No trades in this option yet today.' : d.daily ? 'This option\'s daily closing price up to today. Red is your stop-loss, green your target.' : 'This option\'s price today, minute by minute. Red is your stop-loss, green your target.';
  }).catch((e) => { chartNote.textContent = `Could not load this option's price: ${e.message}`; });
}

function explainPnl(x) {
  const row = (label, value) => el('div', { class: 'kv' }, el('span', { class: 'k', text: label }), el('span', { class: 'v ' + tone(value), text: srs(value) }));
  return el('details', { class: 'pnl-explain' }, el('summary', { text: 'Explain P&L' }),
    row('Index movement', x.spot), row('Time passing', x.time), row('IV change', x.volatility),
    row('Pricing and fill difference', x.residual), row('Gross booked P&L', x.gross),
    row('Entry and exit charges', -(x.entryCharges + x.exitCharges)), row('After these charges', x.netAfterCharges),
    el('p', { class: 'note', text: x.note }));
}

// Brokerage is what the broker keeps; the rest goes to the government and the exchange.
function chargeSplit(a) {
  const p = a.chargeParts; if (!p || !a.charges) return 'Brokerage, STT, exchange fees, GST, stamp duty';
  const taxes = a.charges - p.brokerage;
  return `${rs(p.brokerage)} brokerage, ${rs(Math.max(0, taxes))} taxes and fees`;
}

function renderPayoff() {
  const a = S.account; const panel = $('#acPayPanel'); if (!a) return;
  const groups = [...new Set(a.positions.map((p) => `${p.symbol}|${p.expiry}`))];
  panel.hidden = !groups.length; if (!groups.length) return;
  if (!groups.includes(group)) group = groups[0];
  const sel = $('#acGroup');
  const existing = [...sel.options].map((o) => o.value);
  if (groups.length !== existing.length || groups.some((g, i) => g !== existing[i])) {
    sel.replaceChildren(...groups.map((g) => { const [s, e] = g.split('|'); return new Option(`${cfg(s).short} · ${e.slice(8)}/${e.slice(5, 7)}`, g, false, g === group); }));
  }
  sel.hidden = groups.length < 2;
  const [sym] = group.split('|'); const spot = a.spots[sym]; const r = S.meta.riskFree;
  const ps = a.positions.filter((p) => `${p.symbol}|${p.expiry}` === group);
  const ivs = ps.map((p) => p.iv).filter((x) => x > 0); const atmIv = (ivs.length ? ivs.reduce((x, y) => x + y) / ivs.length : 13) / 100;
  const legs = ps.map((p) => { const iv = p.iv > 0 ? p.iv / 100 : atmIv; return { type: p.type, strike: p.strike, expiry: p.expiry, qty: p.qty, entry: p.avg, iv, adj: p.mark - bs(p.type, spot, p.strike, yearsTo(p.expiry), r, iv).price }; });
  drawPayoff($('#acPayoff'), legs, { spot, iv: atmIv, r });
}

async function exitOne(p, btn) {
  btn.disabled = true; btn.textContent = 'Exiting…';
  try { const r = await api('/api/exit', { key: p.key }); S.account = r.account; emit('account', r.account); toast(`Closed ${instrument(p)} at ₹${inr2.format(r.fills[0].price)}.`, 'ok'); }
  catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Exit'; }
}

let exitArmed = false;
async function exitAll(e) {
  const btn = e.target;
  if (!exitArmed) { exitArmed = true; btn.textContent = 'Confirm: exit all'; setTimeout(() => { exitArmed = false; btn.textContent = 'Exit all'; }, 4000); return; }
  exitArmed = false; btn.disabled = true;
  for (const p of [...S.account.positions]) { try { await api('/api/exit', { key: p.key }); } catch (err) { toast(err.message, 'err'); } }
  btn.disabled = false; btn.textContent = 'Exit all'; await refreshAccount(); toast('All positions closed.', 'ok');
}

async function reset() {
  const btn = $('#acReset');
  if (!resetArmed) { resetArmed = true; btn.textContent = 'Confirm reset'; setTimeout(() => { resetArmed = false; btn.textContent = 'Reset account'; }, 4000); return; }
  resetArmed = false; btn.textContent = 'Reset account';
  try { S.account = await api('/api/reset', { balance: +$('#acBal').value }); emit('account', S.account); toast(`Account reset to ${rs(S.account.startBalance)}.`, 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}
