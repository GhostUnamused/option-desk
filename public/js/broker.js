// One user-selected broker connection at a time. Credentials go to the local server and are never returned to the page.
import { api, el, $, toast, store } from './util.js';
import { S } from './state.js';

const PROVIDERS = [
  { id: 'indstocks', name: 'INDstocks', help: 'Paste the access token from your INDstocks API settings. It lasts 24 hours.', link: 'https://www.indstocks.com/app/api-trading/access-tokens' },
  { id: 'fyers', name: 'FYERS', help: 'Paste your FYERS Client ID and today’s access token. FYERS tokens expire daily.', link: 'https://myapi.fyers.in/dashboard' },
  { id: 'upstox', name: 'Upstox', help: 'Create a personal API app, generate today’s access token, and paste it here. Upstox tokens expire at 3:30 AM.', link: 'https://account.upstox.com/developer/apps' },
  { id: 'kotak', name: 'Kotak Neo', help: 'Create a Trade API app in Kotak Neo and paste its consumer key. Market-data requests use this single key; no TOTP or MPIN is needed.', link: 'https://kotakneo.com/platform/trade-api' },
  { id: 'breeze', name: 'ICICI Breeze', help: 'Enter your App Key and Secret Key, then paste today’s API_Session value from the login redirect. The session expires daily.', link: 'https://api.icicidirect.com/' },
  { id: 'angelone', name: 'Angel One', help: 'Enter your SmartAPI key, client code, trading PIN, and current six-digit TOTP. SmartAPI sessions expire at midnight.', link: 'https://smartapi.angelone.in/' },
];
let dlg, st = null, busy = false;
const selected = () => PROVIDERS.find((p) => p.id === st?.provider) || PROVIDERS[0];

export function init() {
  if (S.meta.replay || !S.meta.broker) return;
  dlg = $('#broker'); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  const pill = $('#srcPill'); pill.hidden = false; pill.addEventListener('click', open);
  update(S.meta.broker);
  if (!st.providers?.some((p) => p.connected) && !store.get('brokerSkip', false)) open();
}

export function update(s) {
  if (!s || !dlg) return;
  st = s; S.meta.broker = s;
  const pill = $('#srcPill'), p = selected(), via = s.answering || 'NSE';
  pill.className = 'pill ' + (s.expired ? 'bad' : s.connected ? 'ok' : '');
  pill.textContent = s.expired ? `${p.name} token expired` : `Data: ${via}${s.stream === 'live' ? ' · live' : ''}`;
  pill.title = s.expired ? `${p.name} token expired. Connect with a fresh token.` : s.connected ? `Connected to ${p.name}. Click to change broker or manage the connection.` : 'Prices currently come from the NSE website. Click to connect one broker.';
}

function open() { render(); if (!dlg.open) dlg.showModal(); dlg.querySelector('select')?.focus(); }

function render(error = '') {
  if (busy) return;
  const p = selected(), status = st.connected
    ? el('div', { class: 'okbox', text: `Connected to ${p.name}. Live market data comes from your account.` })
    : st.problem ? el('div', { class: 'warnbox', text: `${p.name} could not be reached: ${st.problem}. NSE data will be used where available.` }) : null;
  const picker = el('select', { class: 'inp tok', 'aria-label': 'Choose broker', onchange: async (e) => {
    try { update(await api('/api/broker/select', { provider: e.target.value })); render(); }
    catch (x) { toast(x.message, 'err'); }
  } }, ...PROVIDERS.map((x) => el('option', { value: x.id, text: x.name, selected: x.id === st.provider })));
  const clientId = p.id === 'fyers' ? el('input', { class: 'inp tok', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'FYERS Client ID', 'aria-label': 'FYERS Client ID' }) : null;
  const breezeAppKey = p.id === 'breeze' ? el('input', { class: 'inp tok', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Breeze App Key', 'aria-label': 'Breeze App Key' }) : null;
  const breezeSecret = p.id === 'breeze' ? el('input', { class: 'inp tok', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Breeze Secret Key', 'aria-label': 'Breeze Secret Key' }) : null;
  const angelApiKey = p.id === 'angelone' ? el('input', { class: 'inp tok', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'SmartAPI Key', 'aria-label': 'SmartAPI Key' }) : null;
  const angelClientCode = p.id === 'angelone' ? el('input', { class: 'inp tok', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Client Code', 'aria-label': 'Client Code' }) : null;
  const angelPin = p.id === 'angelone' ? el('input', { class: 'inp tok', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Trading PIN', 'aria-label': 'Trading PIN' }) : null;
  const tokenLabel = p.id === 'kotak' ? 'consumer key' : p.id === 'breeze' ? 'API_Session' : p.id === 'angelone' ? 'current six-digit TOTP' : 'access token';
  const token = el('input', { class: 'inp tok', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: `Paste your ${p.name} ${tokenLabel}`, 'aria-label': `${p.name} ${tokenLabel}` });
  const err = el('div', { class: 'errbox', text: error, hidden: !error });
  const connect = el('button', { class: 'btn', type: 'submit', text: 'Connect' });
  const forget = st.providers?.find((x) => x.id === st.provider)?.connected ? el('button', { class: 'btn danger', type: 'button', text: `Disconnect ${p.name}`, onclick: async () => {
    try { update(await api('/api/broker/forget', { provider: st.provider })); render(); toast(`${p.name} disconnected. Its saved credentials were deleted.`); }
    catch (x) { toast(x.message, 'err'); }
  } }) : null;
  const submit = async (e) => {
    e.preventDefault(); if (!token.value.trim() || (clientId && !clientId.value.trim()) || (breezeAppKey && !breezeAppKey.value.trim()) || (breezeSecret && !breezeSecret.value.trim()) || (angelApiKey && !angelApiKey.value.trim()) || (angelClientCode && !angelClientCode.value.trim()) || (angelPin && !angelPin.value.trim())) return;
    busy = true; connect.disabled = true; connect.textContent = 'Checking…';
    try {
      const credentials = p.id === 'fyers' ? { clientId: clientId.value, accessToken: token.value }
        : p.id === 'breeze' ? { appKey: breezeAppKey.value, secretKey: breezeSecret.value, apiSession: token.value }
          : p.id === 'angelone' ? { apiKey: angelApiKey.value, clientCode: angelClientCode.value, pin: angelPin.value, totp: token.value }
            : { token: token.value };
      update(await api('/api/broker', { provider: p.id, credentials })); store.set('brokerSkip', false); dlg.close();
      toast(`Connected to ${p.name}. Prices now come from your broker when available.`, 'ok');
    } catch (x) { busy = false; render(x.message); }
    finally { busy = false; }
  };
  const close = el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => dlg.close() });
  dlg.replaceChildren(el('form', { onsubmit: submit },
    el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: 'Connect a broker' }), el('div', { class: 'note', text: 'Choose one broker for live market data. Trading stays paper-only.' })), close),
    el('div', { class: 'tk-b' }, status, picker,
      el('p', { text: p.help }),
      el('ol', { class: 'bk-steps' }, el('li', {}, 'Open ', el('a', { href: p.link, target: '_blank', rel: 'noopener', text: `${p.name} API settings` }), ' and sign in.'), el('li', { text: p.id === 'kotak' ? 'Create or open your Trade API app and copy its consumer key.' : p.id === 'breeze' ? 'Create a Breeze API app, sign in to its login page, then copy API_Session from the redirect URL.' : p.id === 'angelone' ? 'Create a SmartAPI app and generate a current TOTP in your authenticator.' : 'Create or open your personal API app and copy its current market-data token.' })),
      clientId, breezeAppKey, breezeSecret, angelApiKey, angelClientCode, angelPin, token, err,
      el('p', { class: 'note', text: 'Credentials stay on this computer (encrypted for your Windows account). Optionwise only requests market data; it never sends orders to your broker.' })),
    el('div', { class: 'tk-f' }, forget, st.connected ? null : el('button', { class: 'btn ghost', type: 'button', text: 'Use NSE data instead', onclick: () => { store.set('brokerSkip', true); dlg.close(); } }), connect)));
  if (error) dlg.querySelector('.tok:last-of-type')?.focus();
}
