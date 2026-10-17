// Expired options: pick a past expiry, strike and call/put, and see how that contract traded, minute by minute on its
// last day or over its last weeks. This panel appears only for providers that implement its expired-contract APIs.
import { api, el, $, fmtExpiryLong, store } from './util.js';
import { S, on } from './state.js';
import { candleChart } from './candles.js';
import { term } from './glossary.js';

const RANGES = [['day', 'Expiry day', 'Its last day, one candle a minute'], ['week', 'Last week', 'Its last 7 days, 5-minute candles'], ['life', 'Last 6 weeks', 'Up to 45 days before expiry, hourly candles']];
let box, cc = null, state = { symbol: null, expiry: null, contracts: [], strike: null, type: store.get('expType', 'CE'), range: store.get('expRange', 'day') }, seq = 0;

export function panel() {
  box = el('div', { class: 'panel', id: 'expPanel' },
    el('div', { class: 'panel-h' }, el('h2', { text: 'Expired options' }), el('span', { class: 'note', text: 'Replay how a contract that has already expired actually traded.' })),
    el('div', { id: 'expBody' }, el('p', { class: 'note', text: 'Connect a provider that includes expired option history to load past contracts.' })));
  on('symbol', () => { if (S.tab === 'chain' && box.dataset.ready) load(); });
  return box;
}

// Called when the Option chain tab is shown.
export async function show() {
  if (S.meta.replay) { box.hidden = true; return; }
  const st = S.quotes?.broker;
  if (!st?.capabilities?.expiredOptions) {
    $('#expBody').replaceChildren(el('p', { class: 'note', text: 'The selected provider does not include expired option history.' }));
    return;
  }
  if (!st?.hasToken || st.expired) {
    $('#expBody').replaceChildren(el('p', { class: 'note', text: 'Connect the selected data provider with the Data button in the tab bar to use this.' }));
    return;
  }
  if (state.symbol !== S.symbol) await load();
}

async function load() {
  const my = ++seq; state.symbol = S.symbol; box.dataset.ready = '1';
  $('#expBody').replaceChildren(el('p', { class: 'note', text: 'Loading past expiries…' }));
  try {
    const [{ expiries }, daily] = await Promise.all([api(`/api/expired/expiries?symbol=${S.symbol}`), api(`/api/daily?symbol=${S.symbol}&days=730`).catch(() => ({ rows: [] }))]);
    if (my !== seq) return;
    state.closes = new Map(daily.rows.map((r) => [r.date, r.c]));
    if (!expiries.length) { $('#expBody').replaceChildren(el('p', { class: 'note', text: `No expired ${S.symbol} options are available from this provider.` })); return; }
    state.expiries = expiries; state.expiry = expiries[0];
    build(); await pickExpiry(state.expiry);
  } catch (e) { $('#expBody').replaceChildren(el('p', { class: 'note', text: `Could not load expired options: ${e.message}` })); }
}

function build() {
  const seg = (items, cur, set) => el('div', { class: 'seg', role: 'group' }, items.map(([v, t, title]) => el('button', { type: 'button', class: v === cur ? 'on' : '', text: t, title, onclick: (e) => { e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); set(v); } })));
  const expSel = el('select', { class: 'sel', 'aria-label': 'Expired expiry', onchange: (e) => pickExpiry(e.target.value) }, ...state.expiries.map((d) => new Option(fmtExpiryLong(d), d)));
  const strikeSel = el('select', { class: 'sel', id: 'expStrike', 'aria-label': 'Strike', onchange: (e) => { state.strike = Number(e.target.value); draw(true); } });
  $('#expBody').replaceChildren(
    el('div', { class: 'panel-h' }, expSel, strikeSel,
      seg([['CE', 'Call'], ['PE', 'Put']], state.type, (v) => { state.type = v; store.set('expType', v); draw(true); }),
      el('span', { class: 'sp' }), seg(RANGES, state.range, (v) => { state.range = v; store.set('expRange', v); draw(true); })),
    el('div', { class: 'chart', id: 'expChart' }),
    el('p', { class: 'note', id: 'expNote' }),
    S.meta.broker?.provider === 'fyers' ? el('p', { class: 'note', text: 'FYERS Standard allows 10 expired intraday-history requests per day. These charts use that allowance.' }) : null,
    el('p', { class: 'note' }, 'Tip: compare a ', term('call'), ' and a ', term('put'), ' at the same strike on expiry day to see ', term('theta'), ' take the last of their ', term('time value'), '.'));
  if (cc) cc.remove();
  cc = candleChart($('#expChart'), { height: 300 });
}

async function pickExpiry(expiry) {
  const my = ++seq; state.expiry = expiry;
  try {
    const { contracts } = await api(`/api/expired/contracts?symbol=${state.symbol}&expiry=${expiry}`);
    if (my !== seq) return;
    state.contracts = contracts;
    const strikes = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);
    // Start at the money: the strike nearest where the index closed on expiry day (it traded busily right to the end).
    const spot = state.closes?.get(expiry) || S.quotes?.indices.find((i) => i.symbol === state.symbol)?.last || strikes[Math.floor(strikes.length / 2)];
    state.strike = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), strikes[0]);
    $('#expStrike').replaceChildren(...strikes.map((k) => new Option(k.toLocaleString('en-IN'), k, false, k === state.strike)));
    await draw(true);
  } catch (e) { $('#expNote').textContent = `Could not load contracts: ${e.message}`; }
}

async function draw(fit) {
  const c = state.contracts.find((x) => x.strike === state.strike && x.type === state.type);
  if (!c) { cc.set([]); $('#expNote').textContent = 'No such contract for this expiry.'; return; }
  const my = ++seq; $('#expNote').textContent = 'Loading…';
  try {
    const d = await api(`/api/expired/candles?contract=${encodeURIComponent(c.symbol)}&expiry=${state.expiry}&range=${state.range}`);
    if (my !== seq) return;
    cc.set(d.candles, { fit });
    const last = d.candles[d.candles.length - 1];
    const r = RANGES.find(([v]) => v === state.range);
    $('#expNote').textContent = d.candles.length
      ? `${c.symbol}: ${r[2]}. It expired on ${fmtExpiryLong(state.expiry)} with a last trade at ₹${last.c.toLocaleString('en-IN')}. Bars along the bottom show how much traded.`
      : `${c.symbol} did not trade in this window. Try a strike nearer the index, or a longer range.`;
  } catch (e) { $('#expNote').textContent = `Could not load the chart: ${e.message}`; }
}
