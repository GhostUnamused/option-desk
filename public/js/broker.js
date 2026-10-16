// INDstocks connection: the data-source pill in the tab bar and the dialog where the owner pastes an access token.
// The token is sent to the local server once and never comes back; the page only ever sees the connection status.
import { api, el, $, toast, store } from './util.js';
import { S } from './state.js';

let dlg, st = null, warnedExpired = false;

export function init() {
  if (S.meta.replay || !S.meta.broker) return; // replay mode uses stored history, no broker
  dlg = $('#broker');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  const pill = $('#srcPill'); pill.hidden = false;
  pill.addEventListener('click', open);
  update(S.meta.broker);
  // First run: offer the connection once. "Use NSE website instead" stops the offer.
  if (!st.hasToken && !store.get('brokerSkip', false)) open();
}

// Called with the status the server sends along with each quote poll.
export function update(s) {
  if (!s || !dlg) return;
  st = s;
  S.meta.broker = s;
  const pill = $('#srcPill');
  const via = s.answering === 'INDstocks' ? 'INDstocks' : 'NSE website';
  pill.className = 'pill ' + (s.expired ? 'bad' : s.answering === 'INDstocks' ? 'ok' : s.hasToken ? 'warn' : '');
  pill.textContent = s.expired ? 'INDstocks token expired' : `Data: ${via}${s.answering === 'INDstocks' && s.stream === 'live' ? ' · live' : ''}`;
  pill.title = s.expired ? 'Paste a fresh INDstocks access token to get broker prices again. Until then prices come from NSE\'s website.'
    : s.answering === 'INDstocks' ? `Live prices from your INDstocks account${s.stream === 'live' ? ', streamed tick by tick' : ''}. Click to manage the connection.`
    : s.problem ? `INDstocks did not answer (${s.problem}), so prices come from NSE's website for now. Click for details.`
    : 'Prices come from NSE\'s public website. Click to connect INDstocks for steadier live prices.';
  if (s.expired && !warnedExpired) { warnedExpired = true; toast('Your INDstocks token has expired. Click the red pill in the tab bar to paste a fresh one.', 'err'); }
  if (!s.expired) warnedExpired = false;
}

function open() { render(); if (!dlg.open) dlg.showModal(); dlg.querySelector('input')?.focus(); }

function render(error = '') {
  const s = st;
  const close = el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => dlg.close() });
  const inp = el('input', { class: 'inp tok', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your access token', 'aria-label': 'INDstocks access token' });
  const err = el('div', { class: 'errbox', text: error, hidden: !error });
  const connect = el('button', { class: 'btn', type: 'submit', text: s.hasToken ? 'Save new token' : 'Connect' });
  const submit = async (e) => {
    e.preventDefault();
    if (!inp.value.trim()) { inp.focus(); return; }
    connect.disabled = true; connect.textContent = 'Checking…';
    try {
      const r = await api('/api/broker', { token: inp.value }); inp.value = '';
      update(r); store.set('brokerSkip', false); dlg.close();
      toast(`Connected to INDstocks${r.user ? ` as ${r.user}` : ''}. Live prices now come from your broker.`, 'ok');
    } catch (x) { inp.value = ''; render(x.message); }
  };
  const status = s.expired ? el('div', { class: 'errbox', text: 'Your token has expired or was replaced (each token lasts 24 hours). Paste a fresh one below.' })
    : s.hasToken && s.answering === 'INDstocks' ? el('div', { class: 'okbox', text: `Connected${s.user ? ` as ${s.user}` : ''}. Prices come from INDstocks.` })
    : s.hasToken && s.problem ? el('div', { class: 'warnbox', text: `INDstocks did not answer: ${s.problem}. Prices come from NSE's website until it does.` })
    : null;
  const envNote = s.source === 'env' ? el('p', { class: 'note', text: 'The token currently comes from the .env file next to server.js (developer setup). A token pasted here is used until the server restarts.' }) : null;

  dlg.replaceChildren(el('form', { onsubmit: submit },
    el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: 'Live prices from INDstocks' }), el('div', { class: 'note', text: 'Optional. Without it, prices come from NSE\'s public website.' })), close),
    el('div', { class: 'tk-b' },
      status,
      el('p', { text: 'If you have an INDstocks (INDmoney) account, Option Desk can read live prices and the option chain through its official API. This is steadier than NSE\'s website. Option Desk only reads prices: all trading here stays paper trading.' }),
      el('ol', { class: 'bk-steps' },
        el('li', {}, 'Open ', el('a', { href: s.tokenPage, target: '_blank', rel: 'noopener', text: 'INDstocks → API trading → Access tokens' }), ' and sign in.'),
        el('li', { text: 'Generate an access token and copy it.' }),
        el('li', { text: 'Paste it below and press Connect.' })),
      inp, err,
      el('p', { class: 'note', text: 'An access token works for 24 hours, so you paste a fresh one each trading day. It is encrypted with your Windows sign-in and kept only on this computer: it is never shown again, uploaded or written to logs.' }),
      envNote),
    el('div', { class: 'tk-f' },
      s.hasToken && s.source === 'saved' ? el('button', { class: 'btn danger', type: 'button', text: 'Disconnect', onclick: async () => { update(await api('/api/broker/forget', {})); dlg.close(); toast('INDstocks disconnected. The saved token was deleted.'); } }) : null,
      s.hasToken ? null : el('button', { class: 'btn ghost', type: 'button', text: 'Use NSE website instead', onclick: () => { store.set('brokerSkip', true); dlg.close(); } }),
      connect)));
  if (error) inp.focus();
}
