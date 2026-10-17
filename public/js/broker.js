// One user-selected broker connection at a time. Credentials go to the local server and are never returned to the page.
import { api, el, $, toast } from './util.js';
import { S } from './state.js';

const PROVIDERS = [
  { id: 'indstocks', name: 'INDstocks', help: 'Paste the access token from your INDstocks API settings. It lasts 24 hours.', link: 'https://www.indstocks.com/app/api-trading/access-tokens' },
  { id: 'fyers', experimental: true, name: 'FYERS', help: 'Paste your FYERS Client ID and today’s access token. FYERS tokens expire daily.', link: 'https://myapi.fyers.in/dashboard' },
  { id: 'upstox', experimental: true, name: 'Upstox', help: 'Create a personal API app, generate today’s access token, and paste it here. Upstox tokens expire at 3:30 AM.', link: 'https://account.upstox.com/developer/apps' },
  { id: 'kotak', experimental: true, name: 'Kotak Neo', help: 'Create a Trade API app in Kotak Neo and paste its consumer key. Market-data requests use this single key; no TOTP or MPIN is needed.', link: 'https://kotakneo.com/platform/trade-api' },
  { id: 'breeze', experimental: true, name: 'ICICI Breeze', help: 'Enter your App Key and Secret Key, then paste today’s API_Session value from the login redirect. The session expires daily.', link: 'https://api.icicidirect.com/' },
  { id: 'angelone', experimental: true, name: 'Angel One', help: 'Enter your SmartAPI key, client code, trading PIN, and current six-digit TOTP. SmartAPI sessions expire at midnight.', link: 'https://smartapi.angelone.in/' },
];
let dlg, st = null, busy = false, askNse = false;
const EXPERIMENTAL_NOTE = 'Experimental: this connection has not been tested against a real account yet. If it fails, the app falls back to NSE website data only if you allowed it as a backup. Please report what you see on GitHub.';
const selected = () => PROVIDERS.find((p) => p.id === st?.provider) || PROVIDERS[0];

export function init() {
  if (S.meta.replay || !S.meta.broker) return;
  dlg = $('#broker'); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  const pill = $('#srcPill'); pill.hidden = false; pill.addEventListener('click', open);
  update(S.meta.broker);
  if (st.needsChoice) open();
}

export function update(s) {
  if (!s || !dlg) return;
  st = s; S.meta.broker = s;
  const pill = $('#srcPill'), p = selected(), via = s.answering || 'NSE';
  pill.className = 'pill ' + (s.expired ? 'bad' : s.connected ? 'ok' : '');
  pill.textContent = s.needsChoice ? 'Choose a data source' : s.expired ? `${p.name} token expired` : `Data: ${via}${s.stream === 'live' ? ' · live' : ''}`;
  pill.title = s.expired ? `${p.name} token expired. Connect with a fresh token.` : s.connected ? `Connected to ${p.name}. Click to change broker or manage the connection.` : s.nse ? 'Prices currently come from the NSE website. Click to connect one broker.' : 'No data source chosen yet. Click to connect a broker or choose NSE website data.';
}

function open() { render(); if (!dlg.open) dlg.showModal(); dlg.querySelector('select')?.focus(); }

function render(error = '') {
  if (busy) return;
  const p = selected(), status = st.connected
    ? el('div', { class: 'okbox', text: `Connected to ${p.name}. Live market data comes from your account.` })
    : st.nse && !st.connected ? el('div', { class: 'okbox', text: 'Using NSE website data. You can connect a broker at any time for steadier prices.' })
    : st.problem ? el('div', { class: 'warnbox', text: `${p.name} could not be reached: ${st.problem}. NSE website data will be used where available if you have allowed it.` }) : null;
  const picker = el('select', { class: 'inp tok', 'aria-label': 'Choose broker', onchange: async (e) => {
    try { update(await api('/api/broker/select', { provider: e.target.value })); render(); }
    catch (x) { toast(x.message, 'err'); }
  } }, ...PROVIDERS.map((x) => el('option', { value: x.id, text: x.name + (x.experimental ? ' (experimental)' : ''), selected: x.id === st.provider })));
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
      update(await api('/api/broker', { provider: p.id, credentials })); dlg.close();
      toast(`Connected to ${p.name}. Prices now come from your broker when available.`, 'ok');
    } catch (x) { busy = false; render(x.message); }
    finally { busy = false; }
  };
  const close = el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => dlg.close() });
  dlg.replaceChildren(el('form', { onsubmit: submit },
    el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: 'Connect your broker (recommended)' }), el('div', { class: 'note', text: 'Optionwise gets live market data from your own broker account. Trading stays paper-only.' })), close),
    el('div', { class: 'tk-b' }, status, picker,
      el('p', { text: p.help }),
      p.experimental ? el('div', { class: 'warnbox', text: EXPERIMENTAL_NOTE }) : null,
      el('ol', { class: 'bk-steps' }, el('li', {}, 'Open ', el('a', { href: p.link, target: '_blank', rel: 'noopener', text: `${p.name} API settings` }), ' and sign in.'), el('li', { text: p.id === 'kotak' ? 'Create or open your Trade API app and copy its consumer key.' : p.id === 'breeze' ? 'Create a Breeze API app, sign in to its login page, then copy API_Session from the redirect URL.' : p.id === 'angelone' ? 'Create a SmartAPI app and generate a current TOTP in your authenticator.' : 'Create or open your personal API app and copy its current market-data token.' })),
      clientId, breezeAppKey, breezeSecret, angelApiKey, angelClientCode, angelPin, token, err,
      el('p', { class: 'note', text: 'Credentials stay on this computer (encrypted for your Windows account). Optionwise only requests market data; it never sends orders to your broker.' }),
      nsePanel(),
      recorderBox()),
    el('div', { class: 'tk-f' }, forget, st.connected ? null : (st.nse ? el('button', { class: 'btn ghost', type: 'button', text: 'Turn off NSE data', onclick: () => setNse(false) }) : el('button', { class: 'btn ghost', type: 'button', text: 'No API key? Use NSE website data', onclick: () => { askNse = true; render(); dlg.querySelector('.bk-nse')?.scrollIntoView({ block: 'nearest' }); } })), connect)));
  if (error) dlg.querySelector('.tok:last-of-type')?.focus();
}

// NSE's website is off until the person chooses it: as the only source when they have no API key, or as a backup next to a broker.
async function setNse(on) {
  try { update(await api('/api/broker/nse', { enabled: on })); askNse = false; render(); if (on && !st.connected) dlg.close(); toast(on ? 'Using NSE website data.' : 'NSE website data is off.'); }
  catch (x) { toast(x.message, 'err'); }
}
function nsePanel() {
  if (askNse && !st.connected) return el('div', { class: 'warnbox bk-nse' },
    el('p', { text: 'Before you use NSE website data: Optionwise reads the same public pages nseindia.com shows in your browser, from your own computer. NSE’s Terms of Use restrict automated collection and the use of its content for virtual trading or simulation, and the pages can slow down, block you or change without notice. A broker connection avoids this. Continue only if you accept that.' }),
    el('div', { class: 'tk-f' }, el('button', { class: 'btn ghost', type: 'button', text: 'Back', onclick: () => { askNse = false; render(); } }), el('button', { class: 'btn', type: 'button', text: 'I understand, use NSE data', onclick: () => setNse(true) })));
  if (st.connected) return el('label', { class: 'check', style: { marginTop: '10px' } },
    el('input', { type: 'checkbox', checked: st.nse, onchange: (e) => setNse(e.target.checked) }),
    el('span', {}, el('b', { text: 'Also allow NSE website data as a backup' }), ': used only for things your broker does not provide, or if it is down. Off by default; NSE’s Terms of Use restrict automated collection, so this is your choice.'));
  return null;
}

// Minute recording for replay (lib/replay/recorder.js): works with any broker or with NSE data.
function recorderBox() {
  const box = el('div', { class: 'bk-rec', style: { marginTop: '10px' } });
  api('/api/recorder').then((r) => {
    if (r.available === false) return;
    const sw = el('input', { type: 'checkbox', checked: r.enabled, onchange: async () => {
      try { await api('/api/recorder', { enabled: sw.checked }); toast(sw.checked ? 'Minute prices will be saved for replay while the app is open during market hours.' : 'Minute recording is off.'); }
      catch (x) { sw.checked = !sw.checked; toast(x.message, 'err'); }
    } });
    const now = r.recording ? `Recording now from ${r.source || 'the current data source'}. ` : '';
    box.replaceChildren(el('label', { class: 'check' }, sw, el('span', {}, el('b', { text: 'Save minute prices for replay' }),
      `: while Optionwise is open during market hours, it saves NIFTY and BANK NIFTY option prices each minute so you can replay those days minute by minute later. Works with any broker, or none. ${now}${r.minuteDays ? `Minute replay has ${r.minuteDays} day${r.minuteDays === 1 ? '' : 's'} so far.` : ''} Roughly 5–10 MB per day.`)));
  }).catch(() => {});
  return box;
}
