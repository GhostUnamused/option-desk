// Entry point: header quotes, tabs, polling.
import { api, el, $, $$, inr2, pct, tone, rs, srs, toast, store, vixMood } from './util.js';
import { initGlossary, term } from './glossary.js';
import { S, on, emit, setSymbol, loadExpiries, refreshAccount } from './state.js';
import * as learn from './learn.js';
import * as markets from './markets.js';
import * as chain from './chain.js';
import * as strategy from './strategy.js';
import * as positions from './positions.js';
import * as ticket from './ticket.js';
import { closeDrawer } from './drawer.js';

const TABS = { learn, markets, chain, strategy, positions };
let lastQuote = {};

// One plain sentence at the top of each tab saying what it is for.
const INTROS = {
  learn: ['Get a feel for how option prices move.', ' Six short lessons, each with an experiment on the sliders below. No real money, no market needed: drag things and watch what happens.'],
  markets: ['How is the market doing?', ' Check the index chart and the plain-English market read before you think about any trade.'],
  chain: ['Every option for this index on one screen.', ' Calls (bets on a rise) are on the left, puts (bets on a fall) on the right, and the strike price runs down the middle.'],
  strategy: ['Plan a trade before you place it.', ' Pick a ready-made strategy for your view of the market and see the most you could make or lose.'],
  positions: ['Your practice account.', ' Track open trades, profit and loss, and every order you have placed. All money here is pretend.'],
};

function intro(name) {
  return el('p', { class: 'intro' }, el('b', { text: INTROS[name][0] }), INTROS[name][1]);
}

function guide() {
  const go = (tab, text) => el('button', { class: 'btn ghost sm', type: 'button', text, onclick: () => showTab(tab) });
  const step = (title, body, btn) => el('li', {}, el('b', { text: title }), el('p', {}, ...body), btn);
  const g = el('section', { class: 'guide', id: 'guide', 'aria-labelledby': 'guideTitle' },
    el('div', { class: 'panel-h', style: { marginBottom: '0' } },
      el('div', {}, el('h2', { id: 'guideTitle', text: 'New to options? Start here' }),
        el('p', { class: 'note', style: { marginTop: '4px' }, text: 'Everything in Option Desk uses pretend money, so you can practise freely without risking a rupee.' })),
      el('span', { class: 'sp' }),
      el('button', { class: 'btn ghost sm', type: 'button', text: 'Hide guide', onclick: () => { g.hidden = true; store.set('guideHidden', true); } })),
    el('ol', { class: 'steps' },
      step('Learn how prices move', ['Six short lessons with sliders: what you pay for, then delta, theta, vega and gamma, each tried out before it is named.'], go('learn', 'Open lessons')),
      step('Read the market', ['See whether the index is rising or falling and how nervous traders are. The ', el('b', { text: 'Market read' }), ' panel below sums it up in plain words.'], null),
      step('Look at option prices', ['The option chain lists every ', term('strike'), '. Hover a price and press ', el('b', { text: 'B' }), ' to buy or ', el('b', { text: 'S' }), ' to sell.'], go('chain', 'Open option chain')),
      step('Try a ready-made strategy', ['Choose bullish, bearish or range-bound and see the ', term('max profit'), ' and ', term('max loss'), ' before you trade.'], go('strategy', 'Open strategy builder')),
      step('Track your practice trades', ['Watch your profit and loss update live, exit when you like, and reset the balance any time.'], go('positions', 'Open paper account'))),
    el('div', { class: 'basics' },
      el('div', {}, el('b', { text: 'Call' }), ' = a bet the index goes ', el('b', { class: 'up', text: 'up' }), '. ', el('b', { text: 'Put' }), ' = a bet it goes ', el('b', { class: 'down', text: 'down' }), '.'),
      el('div', {}, el('b', { text: 'Buying' }), ' an option: the most you can lose is the price you paid. ', el('b', { text: 'Selling' }), ' one: you earn the price, but losses can be large.'),
      el('div', {}, 'Words with a ', el('span', { class: 'term', tabindex: '0', 'data-tip': 'Hover, tap or tab to an underlined word to see what it means.', text: 'dotted underline' }), ' explain themselves when you hover or tap them.')));
  g.hidden = store.get('guideHidden', false);
  return g;
}

function renderTickers() {
  const q = S.quotes; if (!q) return;
  const box = $('#tickers');
  const items = q.indices;
  if (box.children.length !== items.length) {
    box.replaceChildren(...items.map((i) => {
      const b = el('button', { class: 'tick', type: 'button', 'data-sym': i.symbol, title: i.name },
        el('span', { class: 'n', text: i.short }), el('span', { class: 'v' }), el('span', { class: 'c' }));
      b.addEventListener('click', () => setSymbol(i.symbol));
      return b;
    }));
  }
  renderVix(q.vix);
  for (const i of items) {
    const b = box.querySelector(`[data-sym="${i.symbol}"]`); if (!b) continue;
    b.classList.toggle('on', i.symbol === S.symbol);
    const v = b.querySelector('.v'), c = b.querySelector('.c');
    v.textContent = inr2.format(i.last);
    c.textContent = pct(i.pct); c.className = 'c ' + tone(i.pct);
    const prev = lastQuote[i.symbol];
    if (prev != null && prev !== i.last) { b.classList.remove('flash-up', 'flash-down'); void b.offsetWidth; b.classList.add(i.last > prev ? 'flash-up' : 'flash-down'); }
    lastQuote[i.symbol] = i.last;
  }
  const m = q.market, mp = $('#mktPill');
  if (m) { mp.hidden = false; mp.className = 'pill ' + (m.open ? 'ok live' : 'warn'); mp.replaceChildren(el('span', { class: 'dot' }), m.open ? 'Market open' : 'Market closed'); mp.title = m.message || ''; }
  $('#symLabel').textContent = `${S.meta.indices[S.symbol].name} · lot ${S.meta.indices[S.symbol].lot}`;
  tickerFades();
}

// India VIX gets its own block: the number, today's change and a plain mood word coloured by how nervous the market is.
function renderVix(v) {
  const box = $('#vixBox'); box.hidden = !v; if (!v) return;
  const m = vixMood(v.last);
  box.className = 'vix ' + m.key;
  box.replaceChildren(
    el('span', { class: 'n' }, term('India VIX'), el('span', { class: 'mood', text: m.label })),
    el('span', { class: 'v' }, el('b', { text: v.last.toFixed(2) }), ' ', el('span', { class: 'c ' + tone(v.pct), text: pct(v.pct) })));
  box.title = m.hint;
}

// Fade whichever edge of the quote strip has more chips hidden past it.
function tickerFades() {
  const box = $('#tickers');
  box.classList.toggle('fade-l', box.scrollLeft > 2);
  box.classList.toggle('fade-r', box.scrollLeft + box.clientWidth < box.scrollWidth - 2);
}

function initTickerStrip() {
  const box = $('#tickers');
  box.addEventListener('scroll', tickerFades, { passive: true });
  new ResizeObserver(tickerFades).observe(box);
  // A normal mouse wheel scrolls the strip sideways when it overflows.
  box.addEventListener('wheel', (e) => {
    if (box.scrollWidth <= box.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault(); box.scrollLeft += e.deltaY;
  }, { passive: false });
}

function renderAcctMini() {
  const a = S.account; if (!a) return;
  $('#acctMini').replaceChildren(el('span', { class: 'k', text: 'Paper account' }), el('span', { class: 'v' }, el('span', { text: rs(a.available) + ' free · ' }), el('span', { class: tone(a.totalPnl), text: srs(a.totalPnl) })));
}

// Desktop app (OptionDesk.exe): version, live/simulated switch, updates, and telling the app when this window closes.
async function waitForRestart(msg) {
  document.body.style.opacity = '.4'; document.body.style.pointerEvents = 'none'; toast(msg);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { await api('/api/meta'); location.reload(); return; } catch {}
  }
  document.body.style.opacity = ''; document.body.style.pointerEvents = '';
  toast('Option Desk did not come back. Open it again from its shortcut.', 'err');
}

async function checkUpdate() {
  const u = await api('/api/update').catch(() => null); const b = $('#updPill');
  if (!u?.available) { b.hidden = true; return; }
  b.hidden = false; b.className = 'pill ok'; b.textContent = u.latest === u.current ? 'Update available' : `Update to ${u.latest}`; b.dataset.version = u.latest;
  b.title = (u.notes ? u.notes + '. ' : '') + (u.needsNewExe ? 'This update replaces the app file (about 100 MB).' : 'Small download.') + ' Your paper account is kept.';
}

function initDesktop() {
  const app = S.meta.app;
  $('#appVer').textContent = `Option Desk ${app.version}. `;
  if (!app.packaged) return;
  const mode = $('#modeBtn');
  mode.hidden = false;
  mode.textContent = S.meta.mock ? 'Switch to live prices' : 'Switch to simulated';
  mode.title = S.meta.mock ? 'Use real NSE prices and your main paper account' : 'Practise on a made-up market (works when NSE is closed or unreachable), with a separate paper account';
  mode.addEventListener('click', async () => {
    const toSim = !S.meta.mock;
    const msg = toSim
      ? 'Switch to the simulated market? Prices become made-up and you trade in a separate practice account. Option Desk restarts in a few seconds.'
      : 'Switch back to live NSE prices? Option Desk restarts in a few seconds.';
    if (!confirm(msg)) return;
    await api('/api/restart', { sim: toSim }).catch(() => {});
    waitForRestart(toSim ? 'Switching to the simulated market' : 'Switching to live NSE');
  });
  $('#updPill').addEventListener('click', async () => {
    if (!confirm(`Install the update now? Option Desk downloads it and restarts. Your paper account is kept.`)) return;
    toast('Downloading update');
    try { await api('/api/update', {}); waitForRestart('Installing update'); }
    catch (e) { toast(e.message, 'err'); }
  });
  if (app.updates) { checkUpdate(); setInterval(checkUpdate, 3 * 3600e3); }
  const id = Math.random().toString(36).slice(2);
  const ping = () => fetch('/api/ping?c=' + id, { method: 'POST' }).catch(() => {});
  ping(); setInterval(ping, 30000);
  addEventListener('pagehide', () => navigator.sendBeacon('/api/bye?c=' + id));
}

async function pollQuotes() {
  try {
    S.quotes = await api('/api/indices');
    const src = $('#srcPill');
    src.className = 'pill ' + (S.meta.mock ? 'warn' : 'ok'); src.textContent = S.meta.mock ? 'Simulated data' : 'Live NSE';
    renderTickers(); emit('quotes', S.quotes);
  } catch (e) {
    const src = $('#srcPill'); src.className = 'pill bad'; src.textContent = 'Data offline'; src.title = e.message;
  }
}

function showTab(name) {
  if (!TABS[name]) name = 'markets';
  S.tab = name;
  closeDrawer();
  for (const [k, mod] of Object.entries(TABS)) {
    const sec = $('#tab-' + k); const on = k === name;
    sec.hidden = !on;
    $(`.tabs [data-tab="${k}"]`).setAttribute('aria-selected', String(on));
    if (on) mod.show?.(); else mod.hide?.();
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}

function every(ms, fn) {
  let busy = false;
  const run = async () => { if (busy || document.hidden) return; busy = true; try { await fn(); } catch (e) { console.warn(e); } finally { busy = false; } };
  setInterval(run, ms);
  return run;
}

async function boot() {
  try { S.meta = await api('/api/meta'); }
  catch (e) { document.querySelector('main').replaceChildren(el('div', { class: 'panel empty', text: 'Could not reach the Option Desk server. Open Option Desk again (or run "node server.js") and reload this page.' })); return; }
  if (!S.meta.indices[S.symbol]) S.symbol = 'NIFTY';
  ticket.init();
  initGlossary();
  initTickerStrip();
  initDesktop();
  for (const [k, mod] of Object.entries(TABS)) { const sec = $('#tab-' + k); sec.append(intro(k)); mod.init?.(sec); }
  $('#tab-markets').prepend(guide());
  $('#guideBtn').addEventListener('click', () => { $('#guide').hidden = false; store.set('guideHidden', false); showTab('markets'); scrollTo({ top: 0, behavior: 'smooth' }); });
  const top = $('.top'); new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px')).observe(top);
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#acctMini').addEventListener('click', () => showTab('positions'));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  on('account', renderAcctMini);
  on('symbol', async () => { renderTickers(); await loadExpiries().catch((e) => toast(e.message, 'err')); emit('expiries'); });
  on('goto', (t) => showTab(t));

  await pollQuotes();
  await loadExpiries().catch((e) => toast(`Could not load expiries: ${e.message}`, 'err'));
  refreshAccount().catch(() => {});
  showTab(location.hash.slice(1) || 'markets');

  every(5000, pollQuotes);
  every(5000, () => TABS[S.tab].tick?.());
  every(8000, () => (S.tab !== 'positions' ? refreshAccount() : null));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollQuotes(); TABS[S.tab].tick?.(); } });
}

boot();
