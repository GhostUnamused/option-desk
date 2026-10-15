// Paper account tab: balances, open positions with live P&L, portfolio payoff, equity curve, orders, reset.
import { api, el, $, inr0, inr2, rs, srs, pct, tone, instrument, fmtWhen, fmtLeft, toast, themeColors } from './util.js';
import { term } from './glossary.js';
import { S, on, emit, cfg, refreshAccount } from './state.js';
import { bs, yearsTo } from './bs.js';
import { drawPayoff, payoffLegend } from './payoff.js';
import { hexA } from './markets.js';

let root, eqChart = null, eqSeries = null, group = null, resetArmed = false;

export function init(sec) {
  root = sec;
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

export function show() { if (!eqChart) makeEq(); refreshAccount().catch((e) => toast(e.message, 'err')); }
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
  t.replaceChildren(el('thead', {}, el('tr', {}, ['Instrument', 'Expiry', 'Lots', 'Avg price', 'Now', 'Bid / ask', 'P&L', '', ''].map((h, i) => el('th', { class: i < 2 ? 'l' : '' }, term(h))))));
  const tb = el('tbody');
  for (const p of a.positions) {
    const cost = Math.abs(p.avg * p.qty);
    tb.append(el('tr', {},
      el('td', { class: 'l t' }, el('span', { class: 'pill ' + (p.qty > 0 ? 'ok' : 'bad'), text: p.qty > 0 ? 'Long' : 'Short' }), ' ', `${p.symbol} ${inr0.format(p.strike)} ${p.type}`),
      el('td', { class: 'l t', text: `${p.expiry.slice(8)}/${p.expiry.slice(5, 7)} · ${fmtLeft(p.expiry)}` }),
      el('td', { text: `${p.qty > 0 ? '+' : '−'}${p.lots} (${Math.abs(p.qty)})` }), el('td', { text: inr2.format(p.avg) }), el('td', { text: inr2.format(p.mark) }),
      el('td', { class: 'muted', text: p.bid != null ? `${inr2.format(p.bid)} / ${inr2.format(p.ask)}` : '—' }),
      el('td', { class: tone(p.pnl), text: srs(p.pnl) }), el('td', { class: tone(p.pnl), text: cost ? pct(p.pnl / cost * 100, 1) : '' }),
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
      el('td', { class: tone(x.realized), text: x.realized ? srs(x.realized) : '' }), el('td', { class: 'l t muted wrap', text: [x.tag, x.note].filter(Boolean).join(' · ') }))) : [el('tr', {}, el('td', { class: 'l t empty', colspan: '8', text: 'No orders yet.' }))]));
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
  const sel = $('#acGroup'); sel.replaceChildren(...groups.map((g) => { const [s, e] = g.split('|'); return new Option(`${cfg(s).short} · ${e.slice(8)}/${e.slice(5, 7)}`, g, false, g === group); }));
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
