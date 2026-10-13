// Strategy builder: presets, editable legs at live prices, payoff, odds, Greeks, scenarios, place as a paper trade.
import { api, el, $, inr0, inr2, rs, srs, pts, store, toast, fmtExpiry, fmtLeft } from './util.js';
import { term } from './glossary.js';
import { S, on, emit, cfg, loadChain, loadExpiries, analysisExpiry } from './state.js';
import { yearsTo, bs } from './bs.js';
import { analyze, greeks, drawPayoff, pnlAt, payoffLegend } from './payoff.js';
import * as ticket from './ticket.js';

const PRESETS = [
  ['Bullish', [
    ['long_call', 'Long call', [[1, 'CE', 0]], 'Buy a call. Gains if the index rises well above the strike. Most you can lose is what you paid.'],
    ['bull_call', 'Bull call spread', [[1, 'CE', 0], [-1, 'CE', 4]], 'Buy a call, sell a higher one. Cheaper than a plain call, with capped profit and capped loss.'],
    ['bull_put', 'Bull put spread', [[-1, 'PE', -2], [1, 'PE', -6]], 'Sell a put, buy a lower one as protection. You keep the credit if the index stays above the sold strike.'],
    ['short_put', 'Short put', [[-1, 'PE', -4]], 'Sell a put and keep the premium if the index stays above the strike. Large losses if it falls hard.'],
  ]],
  ['Bearish', [
    ['long_put', 'Long put', [[1, 'PE', 0]], 'Buy a put. Gains if the index falls well below the strike. Most you can lose is what you paid.'],
    ['bear_put', 'Bear put spread', [[1, 'PE', 0], [-1, 'PE', -4]], 'Buy a put, sell a lower one. Cheaper than a plain put, with capped profit and capped loss.'],
    ['bear_call', 'Bear call spread', [[-1, 'CE', 2], [1, 'CE', 6]], 'Sell a call, buy a higher one as protection. You keep the credit if the index stays below the sold strike.'],
    ['short_call', 'Short call', [[-1, 'CE', 4]], 'Sell a call and keep the premium if the index stays below the strike. Losses have no ceiling if it rallies.'],
  ]],
  ['Big move either way', [
    ['long_straddle', 'Long straddle', [[1, 'CE', 0], [1, 'PE', 0]], 'Buy a call and a put at the same strike. Wins on a big move in either direction; loses if the index sits still.'],
    ['long_strangle', 'Long strangle', [[1, 'CE', 4], [1, 'PE', -4]], 'Like a straddle with cheaper out-of-the-money options. Needs an even bigger move.'],
  ]],
  ['Quiet, range-bound', [
    ['iron_condor', 'Iron condor', [[-1, 'CE', 4], [1, 'CE', 8], [-1, 'PE', -4], [1, 'PE', -8]], 'Sell a range and buy protection on both sides. Earns if the index stays inside; loss is capped.'],
    ['iron_fly', 'Iron butterfly', [[-1, 'CE', 0], [-1, 'PE', 0], [1, 'CE', 6], [1, 'PE', -6]], 'Sell the at-the-money straddle with wings bought further out. Bigger credit, narrower sweet spot, capped loss.'],
    ['short_strangle', 'Short strangle', [[-1, 'CE', 6], [-1, 'PE', -6]], 'Sell a call and a put far from spot. Earns if the index stays between them; losses have no ceiling.'],
  ]],
];
const PRESET = Object.fromEntries(PRESETS.flatMap(([, list]) => list.map(([k, n, legs, blurb]) => [k, { name: n, legs, blurb }])));

let root, legs = store.get('strategyLegs', []), preset = store.get('strategyPreset', 'bull_call'), days = 0, margin = null, chains = {}, structureKey = '', placed = null;

export function init(sec) {
  root = sec;
  const sel = el('select', { class: 'sel', id: 'stPreset', 'aria-label': 'Strategy', onchange: (e) => loadPreset(e.target.value) },
    el('option', { value: '', disabled: true, text: 'Choose a strategy…' }),
    PRESETS.map(([g, list]) => el('optgroup', { label: g }, list.map(([k, n]) => new Option(n, k, false, k === preset)))));
  root.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-h' }, el('h2', { id: 'stTitle', text: 'Strategy builder' }), el('span', { class: 'sp' }),
        el('label', { class: 'note', for: 'stPreset', text: 'Start from' }), sel,
        el('button', { class: 'btn ghost sm', type: 'button', text: 'Add a leg', onclick: addBlank }),
        el('button', { class: 'btn ghost sm', type: 'button', text: 'Clear', onclick: () => { legs = []; preset = 'custom'; placed = null; save(); renderAll(); } }),
        el('button', { class: 'btn', type: 'button', id: 'stPlace', text: 'Place as paper trade', onclick: placeAll })),
      el('p', { class: 'note', id: 'stBlurb', style: { marginBottom: '10px' } }),
      el('div', { class: 'tw' }, el('table', { class: 'legs', id: 'stLegs' })),
    ),
    el('div', { class: 'cols' },
      el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'Profit and loss by index level' }), el('span', { class: 'sp' }), el('span', { class: 'note', id: 'stExp' })),
        payoffLegend('Before expiry'), el('div', { class: 'svgchart', id: 'stChart', style: { marginTop: '8px' } }),
        el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }, id: 'stSlider' },
          el('label', { class: 'note', for: 'stDays', text: 'Show the dashed curve after' }), el('input', { type: 'range', id: 'stDays', min: '0', max: '0', value: '0', style: { flex: '1 1 200px' }, oninput: (e) => { days = +e.target.value; renderCalc(); } }), el('span', { class: 'mono', id: 'stDaysOut', text: 'today' }))),
      el('div', { class: 'panel' }, el('h2', { text: 'The numbers', style: { marginBottom: '10px' } }), el('div', { class: 'grid', id: 'stMetrics', style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } }))),
    el('div', { class: 'cols' },
      el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'What if the index moves?' }), el('span', { class: 'note', text: 'Rupee P&L for the whole position, with implied volatility unchanged.' })), el('div', { class: 'tw' }, el('table', { class: 'heat', id: 'stHeat' }))),
      el('div', { class: 'panel' }, el('h2', { text: 'How it reacts (Greeks)', style: { marginBottom: '10px' } }), el('div', { class: 'grid', id: 'stGreeks', style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } }))),
  );
  on('addLeg', (l) => {
    // A leg from the chain starts a new custom strategy unless you are already building one, so it never lands inside a ready-made preset.
    if (legs.length && legs[0].symbol !== l.symbol) { legs = []; toast(`Strategy switched to ${cfg(l.symbol).short}.`); }
    else if (legs.length && preset !== 'custom') { legs = []; toast('Started a new custom strategy with this leg.'); }
    placed = null;
    legs.push({ symbol: l.symbol, expiry: l.expiry, strike: l.strike, type: l.type, side: l.side || 'BUY', lots: l.lots || 1 });
    preset = 'custom'; save(); if (S.tab === 'strategy') renderAll();
  });
  on('symbol', () => { if (S.tab === 'strategy') renderAll(); });
  window.addEventListener('resize', () => { if (S.tab === 'strategy') renderCalc(); });
}

function save() { store.set('strategyLegs', legs); store.set('strategyPreset', preset); }
function structureMatchesPreset() { return preset !== 'custom'; }

// Place the legs as one basket. Once they are in, the builder empties so the next strategy starts clean.
function placeAll() {
  if (!legs.length) return toast('Add at least one leg first.', 'err');
  const name = PRESET[preset]?.name && structureMatchesPreset() ? PRESET[preset].name : 'Custom strategy';
  ticket.openBasket(legs.map((l) => ({ ...l })), name, () => {
    placed = { name, n: legs.length, symbol: legs[0].symbol };
    legs = []; preset = 'custom'; days = 0; save(); renderAll();
  });
}

async function loadPreset(key) {
  if (!PRESET[key]) return;
  preset = key; placed = null; const p = PRESET[key]; const sym = S.symbol; await loadExpiries(sym);
  const exp = S.expiry[sym] && yearsTo(S.expiry[sym]) * 365 > 0.5 ? S.expiry[sym] : analysisExpiry(sym);
  const c = await loadChain(sym, exp); const step = cfg(sym).step;
  const atm = c.rows.reduce((a, r) => (Math.abs(r.strike - c.spot) < Math.abs(a.strike - c.spot) ? r : a)).strike;
  const strikes = c.rows.map((r) => r.strike); const near = (k) => strikes.reduce((a, b) => (Math.abs(b - k) < Math.abs(a - k) ? b : a));
  legs = p.legs.map(([side, type, off]) => ({ symbol: sym, expiry: exp, strike: near(atm + off * step), type, side: side > 0 ? 'BUY' : 'SELL', lots: 1 }));
  days = 0; save(); renderAll();
}

async function addBlank() {
  placed = null;
  const sym = legs[0]?.symbol || S.symbol; const exp = legs[0]?.expiry || S.expiry[sym];
  const c = chains[`${sym}|${exp}`] || (chains[`${sym}|${exp}`] = await loadChain(sym, exp).catch(() => null)); const atm = c ? c.rows.reduce((a, r) => (Math.abs(r.strike - c.spot) < Math.abs(a.strike - c.spot) ? r : a)).strike : 0;
  legs.push({ symbol: sym, expiry: exp, strike: atm, type: 'CE', side: 'BUY', lots: 1 }); preset = 'custom'; save(); renderAll();
}

export async function show() {
  // Saved legs whose expiry has passed (or, in replay, belongs to another day) can't be priced: start again from the preset.
  if (legs.length) {
    await loadExpiries(legs[0].symbol).catch(() => {});
    const open = S.expiries[legs[0].symbol] || [];
    if (open.length && legs.some((l) => !open.includes(l.expiry))) { legs = []; save(); toast('The saved strategy\'s expiry is over, so it was rebuilt on the nearest expiry.'); }
  }
  if (!legs.length && !placed) { await loadPreset(PRESET[preset] ? preset : 'bull_call').catch((e) => toast(e.message, 'err')); return; }
  renderAll();
}
export function hide() {}
export async function tick() { await refreshQuotes(); renderPrices(); renderCalc(); }

async function refreshQuotes() {
  const pairs = [...new Set(legs.map((l) => `${l.symbol}|${l.expiry}`))];
  if (legs[0]) await loadExpiries(legs[0].symbol).catch(() => {});
  await Promise.all(pairs.map(async (p) => { const [s, e] = p.split('|'); chains[p] = await loadChain(s, e).catch(() => chains[p]); }));
}

function quoteFor(l) {
  const c = chains[`${l.symbol}|${l.expiry}`]; const row = c?.rows.find((r) => r.strike === l.strike); const o = row && (l.type === 'CE' ? row.ce : row.pe);
  if (!o) return null;
  const mid = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.ltp;
  return { ...o, mid, fill: l.side === 'BUY' ? (o.ask > 0 ? o.ask : o.ltp) : (o.bid > 0 ? o.bid : o.ltp), spot: c.spot };
}

function model() {
  const sym = legs[0]?.symbol; if (!sym) return null;
  const c = chains[`${sym}|${legs[0].expiry}`]; if (!c) return null;
  const spot = c.spot; const lot = cfg(sym).lot; const r = S.meta.riskFree;
  const atm = c.rows.reduce((a, x) => (Math.abs(x.strike - spot) < Math.abs(a.strike - spot) ? x : a));
  const ivs = [atm.ce?.iv, atm.pe?.iv].filter((x) => x > 0); const atmIv = (ivs.length ? ivs.reduce((a, b) => a + b) / ivs.length : 13) / 100;
  const pl = legs.map((l) => {
    const q = quoteFor(l); const iv = q && q.iv > 0 ? q.iv / 100 : atmIv; const entry = q ? q.fill : 0;
    const qty = (l.side === 'BUY' ? 1 : -1) * l.lots * lot; const adj = q ? q.mid - bs(l.type, spot, l.strike, yearsTo(l.expiry), r, iv).price : 0;
    return { ...l, qty, entry, iv, adj, q };
  });
  return { spot, lot, r, atmIv, pl };
}

function renderAll() {
  refreshQuotes().then(() => { renderLegs(); renderCalc(); fetchMargin(); });
}

function renderLegs() {
  const t = $('#stLegs'); const sym = legs[0]?.symbol || S.symbol;
  $('#stTitle').textContent = `Strategy builder · ${cfg(sym).short}`;
  $('#stPreset').value = PRESET[preset] ? preset : '';
  const blurb = $('#stBlurb');
  if (placed && !legs.length) blurb.replaceChildren(el('span', { class: 'placed' }, el('b', { text: `${placed.name} placed.` }), ` Its ${placed.n} leg${placed.n > 1 ? 's are' : ' is'} now in your account. Choose another strategy above or add a leg to start a new one.`), ' ',
    el('button', { class: 'btn ghost sm', type: 'button', text: 'See my positions', onclick: () => emit('goto', 'positions') }));
  else blurb.replaceChildren(PRESET[preset]?.blurb || (legs.length ? 'Custom strategy. Change any leg below; everything recalculates at live prices.' : 'Choose a ready-made strategy above, or add legs one at a time.'));
  if (legs.length && sym !== S.symbol) blurb.append(' ', el('button', { class: 'btn ghost sm', type: 'button', text: `Start a ${PRESET[preset]?.name || 'bull call spread'} on ${cfg(S.symbol).short} instead`, onclick: () => loadPreset(PRESET[preset] ? preset : 'bull_call') }));
  const exps = S.expiries[sym] || [];
  t.replaceChildren(el('thead', {}, el('tr', {}, ['Action', 'Type', 'Expiry', 'Strike', 'Lots', 'Fill price', 'Bid / ask', 'IV', 'Premium', ''].map((h, i) => el('th', { class: i < 4 ? 'l' : '' }, term(h))))));
  const tb = el('tbody');
  legs.forEach((l, i) => {
    const c = chains[`${l.symbol}|${l.expiry}`]; const strikes = c ? c.rows.map((r) => r.strike) : [l.strike];
    const change = (f) => (e) => { f(e.target.value); preset = 'custom'; save(); renderAll(); };
    tb.append(el('tr', { 'data-i': String(i) },
      el('td', { class: 'l' }, el('select', { 'aria-label': 'Buy or sell', onchange: change((v) => { l.side = v; }) }, new Option('Buy', 'BUY', false, l.side === 'BUY'), new Option('Sell', 'SELL', false, l.side === 'SELL'))),
      el('td', { class: 'l' }, el('select', { 'aria-label': 'Call or put', onchange: change((v) => { l.type = v; }) }, new Option('Call', 'CE', false, l.type === 'CE'), new Option('Put', 'PE', false, l.type === 'PE'))),
      el('td', { class: 'l' }, el('select', { 'aria-label': 'Expiry', onchange: change((v) => { l.expiry = v; }) }, exps.map((e) => new Option(fmtExpiry(e), e, false, e === l.expiry)))),
      el('td', { class: 'l' }, el('select', { 'aria-label': 'Strike', onchange: change((v) => { l.strike = +v; }) }, strikes.map((k) => new Option(inr0.format(k), k, false, k === l.strike)))),
      el('td', {}, el('input', { type: 'number', min: '1', step: '1', value: String(l.lots), 'aria-label': 'Lots', onchange: change((v) => { l.lots = Math.max(1, Math.round(+v || 1)); }) })),
      el('td', { class: 'p-fill' }), el('td', { class: 'p-ba muted' }), el('td', { class: 'p-iv' }), el('td', { class: 'p-prem' }),
      el('td', {}, el('button', { class: 'x', type: 'button', 'aria-label': 'Remove leg', text: '×', onclick: () => { legs.splice(i, 1); preset = 'custom'; save(); renderAll(); } }))));
  });
  if (!legs.length) tb.append(el('tr', {}, el('td', { class: 'l t empty', colspan: '10', text: placed ? 'Nothing here yet: the last strategy has been placed.' : 'No legs yet. Pick a strategy above, add a leg, or press B/S then "Add to strategy" from the option chain.' })));
  t.append(tb);
  renderPrices();
}

function renderPrices() {
  const lot = legs[0] ? cfg(legs[0].symbol).lot : 0;
  legs.forEach((l, i) => {
    const tr = document.querySelector(`#stLegs tr[data-i="${i}"]`); if (!tr) return; const q = quoteFor(l);
    tr.querySelector('.p-fill').textContent = q ? inr2.format(q.fill) : '—';
    tr.querySelector('.p-ba').textContent = q ? `${inr2.format(q.bid)} / ${inr2.format(q.ask)}` : '—';
    tr.querySelector('.p-iv').textContent = q && q.iv > 0 ? q.iv.toFixed(1) + '%' : '—';
    const prem = q ? (l.side === 'BUY' ? -1 : 1) * q.fill * l.lots * lot : 0; const pc = tr.querySelector('.p-prem'); pc.textContent = q ? srs(prem) : '—'; pc.className = 'p-prem ' + (prem >= 0 ? 'up' : 'down');
  });
}

async function fetchMargin() {
  if (!legs.length) { margin = null; return; }
  const key = JSON.stringify(legs); structureKey = key;
  try { const pv = await api('/api/preview', { legs }); if (structureKey === key) { margin = pv; renderCalc(); } } catch (e) { margin = { error: e.message }; renderCalc(); }
}

function renderCalc() {
  const m = model(); const chart = $('#stChart');
  if (!m) { drawPayoff(chart, [], {}); $('#stExp').textContent = ''; $('#stSlider').hidden = true; $('#stMetrics').replaceChildren(); $('#stGreeks').replaceChildren(); $('#stHeat').replaceChildren(); return; }
  const firstExp = legs.map((l) => l.expiry).sort()[0]; const dleft = Math.max(0, Math.floor(yearsTo(firstExp) * 365));
  const sl = $('#stDays'); sl.max = String(dleft); if (days > dleft) days = dleft; sl.value = String(days); $('#stSlider').hidden = dleft < 1;
  $('#stDaysOut').textContent = days ? `${days} day${days > 1 ? 's' : ''}` : 'today';
  $('#stExp').textContent = `Expiry ${fmtExpiry(firstExp)} · ${fmtLeft(firstExp)}`;
  drawPayoff(chart, m.pl, { spot: m.spot, iv: m.atmIv, days, r: m.r, nowLabel: days ? `In ${days} day${days > 1 ? 's' : ''}` : 'Today' });
  const a = analyze(m.pl, m.spot, m.atmIv, m.r);
  const net = m.pl.reduce((s, l) => s - l.qty * l.entry, 0);
  const stat = (k, v, cls, s) => el('div', { class: 'stat' }, el('div', { class: 'k' }, term(k)), el('div', { class: 'v ' + (cls || ''), text: v }), s ? el('div', { class: 's', text: s }) : null);
  const rr = a.maxP === Infinity || a.maxL === -Infinity || a.maxL >= 0 ? '—' : `${(a.maxP / Math.abs(a.maxL)).toFixed(2)} : 1`;
  const mg = margin && !margin.error ? Math.max(0, margin.marginAfter - margin.marginBefore) : null;
  $('#stMetrics').replaceChildren(
    stat(net >= 0 ? 'Credit received' : 'Cost to enter', rs(Math.abs(net)), net >= 0 ? 'up' : '', net >= 0 ? 'Paid to you upfront' : 'You pay this upfront'),
    stat('Chance of profit', `${Math.round(a.pop * 100)}%`, '', 'At expiry, using today\'s implied volatility'),
    stat('Max profit', a.maxP === Infinity ? 'Unlimited' : rs(a.maxP), 'up'),
    stat('Max loss', a.maxL === -Infinity ? 'Unlimited' : rs(a.maxL), 'down', a.maxL === -Infinity ? 'Needs a hard stop-loss' : ''),
    stat('Breakeven', a.be.length ? a.be.map((b) => pts(b)).join(' / ') : '—', '', 'Index level where the expiry line crosses zero'),
    stat('Reward to risk', rr),
    stat('Margin needed', mg == null ? (margin?.error ? 'Unavailable' : '…') : rs(mg), '', 'Estimate, from your paper account'),
    stat('Average outcome', srs(a.ev), a.ev >= 0 ? 'up' : 'down', 'If implied volatility is right. Negative is the cost of the bid–ask spread and fair pricing.'),
  );
  const g = greeks(m.pl, m.spot, m.r);
  $('#stGreeks').replaceChildren(
    stat('Delta', srs(g.delta), g.delta >= 0 ? 'up' : 'down', 'Gain for each 1-point rise in the index'),
    stat('Theta', `${srs(g.theta)} / day`, g.theta >= 0 ? 'up' : 'down', g.theta >= 0 ? 'Time is on your side' : 'Time costs you this each day'),
    stat('Vega', srs(g.vega), g.vega >= 0 ? 'up' : 'down', 'Gain if implied volatility rises 1 point'),
    stat('Gamma', g.gamma.toFixed(3), '', 'How quickly delta changes as the index moves'),
  );
  const moves = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3];
  const mid = Math.floor(dleft / 2);
  const cols = dleft < 1 ? [['Now', { days: 0 }], ['At expiry', { atExpiry: true }]] : [['Now', { days: 0 }], [`In ${mid} day${mid === 1 ? '' : 's'}`, { days: mid }], ['At expiry', { atExpiry: true }]];
  const vals = moves.map((mv) => cols.map(([, o]) => pnlAt(m.pl, m.spot * (1 + mv / 100), { ...o, r: m.r, spot: m.spot })));
  const big = Math.max(1, ...vals.flat().map(Math.abs));
  $('#stHeat').replaceChildren(el('thead', {}, el('tr', {}, el('th', { class: 'l', text: 'Index move' }), cols.map(([h]) => el('th', { style: { textAlign: 'center' }, text: h })))),
    el('tbody', {}, moves.map((mv, i) => el('tr', {}, el('td', { class: 'l', text: `${mv > 0 ? '+' : ''}${mv}% (${pts(m.spot * (1 + mv / 100))})` }),
      vals[i].map((v) => el('td', { text: srs(v), style: { background: `color-mix(in srgb, ${v >= 0 ? 'var(--up)' : 'var(--down)'} ${Math.round(Math.min(1, Math.abs(v) / big) * 30)}%, transparent)` } }))))));
}
