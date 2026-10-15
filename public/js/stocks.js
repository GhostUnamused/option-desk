// Stock options: search the ~200 NSE stocks that have options and follow some. A followed stock joins the symbol list
// everywhere (header, chain, strategy, charts) like an index. Data comes from INDstocks, so this needs the connection.
import { api, el, $, toast } from './util.js';
import { S, setSymbol, emit } from './state.js';

let dlg, seq = 0;

export function init() {
  dlg = $('#stocks');
  dlg?.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
export const available = () => Boolean(!S.meta.replay && S.meta.broker?.hasToken);

export function open() {
  if (!available()) { toast('Stock options come from INDstocks. Connect it with the Data button in the tab bar first.', 'err'); return; }
  const list = el('div', { class: 'st-list', role: 'listbox', 'aria-label': 'Stocks with options' }, el('p', { class: 'note', text: 'Loading the list of stocks with options (the first time each day takes a few seconds)…' }));
  const inp = el('input', { class: 'inp tok', type: 'search', placeholder: 'Search by name or symbol, e.g. Reliance, HDFCBANK', 'aria-label': 'Search stocks', oninput: () => search(inp.value, list) });
  dlg.replaceChildren(
    el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: 'Stock options' }), el('div', { class: 'note', text: 'Follow a stock to trade its options here, the same way as an index.' })),
      el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => dlg.close() })),
    el('div', { class: 'tk-b' }, inp, list,
      el('p', { class: 'note', text: 'Good to know: a stock moves more than an index, so its options cost more and margins are higher. Real stock options are settled by delivering shares at expiry; here they settle in cash at their intrinsic value. One lot is often hundreds of shares.' })));
  if (!dlg.open) dlg.showModal();
  inp.focus();
  search('', list);
}

async function search(q, list) {
  const my = ++seq;
  try {
    const r = await api(`/api/stocks?q=${encodeURIComponent(q)}`);
    if (my !== seq) return;
    const row = (s) => el('div', { class: 'st-row' + (s.watched ? ' on' : '') },
      el('div', {}, el('b', { text: s.symbol }), el('div', { class: 'note', text: `${s.name} · lot ${s.lot.toLocaleString('en-IN')} shares` })),
      s.watched
        ? el('div', { class: 'st-act' }, el('button', { class: 'btn ghost sm', type: 'button', text: 'Open', onclick: () => { dlg.close(); setSymbol(s.symbol); } }), el('button', { class: 'btn danger sm', type: 'button', text: 'Remove', onclick: () => change(s.symbol, false, list, q) }))
        : el('button', { class: 'btn sm', type: 'button', text: 'Follow', onclick: () => change(s.symbol, true, list, q) }));
    list.replaceChildren(
      ...(r.watchlist.length && !q ? [el('div', { class: 'st-h', text: `Following (${r.watchlist.length})` }), ...r.stocks.filter((s) => s.watched).map(row), el('div', { class: 'st-h', text: 'All stocks with options' })] : []),
      ...r.stocks.filter((s) => q || !s.watched).map(row),
      r.stocks.length ? '' : el('p', { class: 'note', text: `No stock with options matches "${q}".` }),
      !q && r.total > r.stocks.length ? el('p', { class: 'note', text: `Showing ${r.stocks.length} of ${r.total}. Type to search the rest.` }) : '');
  } catch (e) { list.replaceChildren(el('p', { class: 'errbox', text: e.message })); }
}

async function change(symbol, add, list, q) {
  try {
    const r = await api('/api/watchlist', { symbol, add });
    S.meta.indices = r.indices;
    emit('universe');
    if (add) { dlg.close(); setSymbol(symbol); toast(`Following ${symbol}. Its options are in the chain now.`, 'ok'); }
    else { if (S.symbol === symbol) setSymbol('NIFTY'); search(q, list); toast(`${symbol} removed.`); }
  } catch (e) { toast(e.message, 'err'); }
}
