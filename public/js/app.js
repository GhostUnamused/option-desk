// Entry point: header quotes, tabs, polling.
import { api, el, $, $$, inr2, pct, tone, rs, srs, toast, store, vixMood, fmtDay } from './util.js';
import { initGlossary, term } from './glossary.js';
import { S, on, emit, setSymbol, loadExpiries, refreshAccount } from './state.js';
import * as learn from './learn.js';
import * as markets from './markets.js';
import * as chain from './chain.js';
import * as strategy from './strategy.js';
import * as positions from './positions.js';
import * as ticket from './ticket.js';
import * as replay from './replay.js';
import { closeDrawer } from './drawer.js';
import * as broker from './broker.js';
import * as live from './live.js';
import * as stocks from './stocks.js';

const TABS = { learn, markets, chain, strategy, positions };
// Replay mode before any session: only the lessons and the Replay tab have anything to show.
const replayIdle = () => Boolean(S.meta?.replay && !S.meta.replay.date); // ended sessions stay viewable; the server refuses their orders
const NEEDS_MARKET = ['markets', 'chain', 'strategy', 'positions'];
let lastQuote = {}, offline = null, quotesAt = 0;

// One plain sentence at the top of each tab saying what it is for.
const INTROS = {
  learn: ['Get a feel for how option prices move.', ' Six short lessons, each with an experiment on the sliders below. No real money, no market needed: drag things and watch what happens.'],
  markets: ['How is the market doing?', ' Check the index chart and the plain-English market read before you think about any trade.'],
  chain: ['Every option on one screen.', ' Calls (bets on a rise) are on the left, puts (bets on a fall) on the right, and the strike price runs down the middle.'],
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

// Session block in the header. Live: market open or closed and the IST clock, ticking every second.
// Replay: which past day the prices come from.
const pad2 = (n) => String(n).padStart(2, '0');
const istParts = (ms) => { const d = new Date(ms + 5.5 * 3600e3); return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() }; };
function sessionView() {
  const r = S.meta.replay;
  if (r) {
    if (!r.date) return { key: 'replay-idle', led: 'warn', label: 'Historical replay', main: 'Not started', sub: '', title: 'Start a session in the Replay tab.' };
    return { key: 'replay', led: 'warn', label: r.blind ? 'Blind replay' : 'Historical replay', main: r.blind ? `Day ${r.day}` : fmtDay(r.date, { weekday: undefined }), sub: 'close', title: 'Prices are this day\'s closing prices (15:30 IST).' };
  }
  const t = istParts(Date.now()); const clock = `${pad2(t.h)}:${pad2(t.m)}:${pad2(t.s)}`;
  const updated = quotesAt ? `Prices last updated ${new Date(quotesAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST.` : '';
  if (offline) return { key: 'offline', led: 'bad', label: 'Data offline', main: clock, sub: 'IST', title: `${offline} ${updated}` };
  const m = S.quotes?.market;
  if (!m) return { key: 'connecting', led: '', label: 'Connecting', main: clock, sub: 'IST', title: '' };
  const left = 15 * 60 + 30 - (t.h * 60 + t.m);
  const sub = m.open && left > 0 ? `closes in ${left >= 60 ? `${Math.floor(left / 60)} h ` : ''}${left % 60} min` : 'IST';
  return { key: m.open ? 'open' : 'closed', led: m.open ? 'ok live' : '', label: m.open ? 'Market open' : 'Market closed', main: clock, sub, title: [m.message, updated, 'NSE trades 9:15 to 15:30 IST, Monday to Friday.'].filter(Boolean).join(' ') };
}
function renderSession() {
  const box = $('#session'); if (!S.meta) return;
  const v = sessionView(); box.hidden = false; box.title = v.title;
  if (box.dataset.key !== v.key) {
    box.dataset.key = v.key;
    box.replaceChildren(el('span', { class: 'pill ' + v.led, text: v.label }), el('span', { class: 'clk' }, el('b', {}), el('span', { class: 'z' })));
  }
  box.querySelector('.clk b').textContent = v.main; box.querySelector('.clk .z').textContent = v.sub;
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
  $('#acctMini').replaceChildren(el('span', { class: 'k', text: S.meta.replay ? 'Replay account' : 'Paper account' }), el('span', { class: 'v' }, el('span', { text: rs(a.available) + ' free · ' }), el('span', { class: tone(a.totalPnl), text: srs(a.totalPnl) })));
}

// Desktop app (OptionDesk.exe): version, live/simulated switch, updates, and telling the app when this window closes.
// Full-screen "please wait" while the app downloads an update or restarts. Returns a function that removes it.
function busy(title, detail) {
  const secs = el('span', { text: '0 s' });
  const box = el('div', { class: 'busy', role: 'alertdialog', 'aria-live': 'polite' },
    el('div', { class: 'busy-card' }, el('b', { text: title }), el('p', { text: detail }), el('p', { class: 'muted' }, 'Elapsed: ', secs)));
  document.body.append(box);
  const t0 = Date.now(), timer = setInterval(() => { secs.textContent = Math.round((Date.now() - t0) / 1000) + ' s'; }, 1000);
  return () => { clearInterval(timer); box.remove(); };
}

// Poll until the restarted app answers and is in the expected state, then reload into it.
async function waitForRestart(done, close) {
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { if (done(await api('/api/meta'))) { location.reload(); return; } } catch {}
  }
  close();
  toast('Option Desk did not come back. Open it again from its shortcut.', 'err');
}

// A newly opened window asks GitHub afresh (force); after that the server's 15-minute memory is enough.
async function checkUpdate(force = false) {
  const u = await api('/api/update' + (force ? '?force=1' : '')).catch(() => null); const b = $('#updPill');
  if (!u?.available) { b.hidden = true; return; }
  b.hidden = false; b.className = 'pill ok'; b.textContent = u.latest === u.current ? 'Update available' : `Update to ${u.latest}`; b.dataset.version = u.latest; b.dataset.big = u.needsNewExe ? '1' : '';
  b.title = (u.notes ? u.notes + '. ' : '') + (u.needsNewExe ? 'This update replaces the app file (about 100 MB).' : 'Small download.') + ' Your paper account is kept.';
}

function initDesktop() {
  const app = S.meta.app;
  $('#appVer').textContent = `Option Desk ${app.version}. `;
  if (!app.packaged) return;
  const mode = $('#modeBtn');
  mode.hidden = false;
  mode.textContent = S.meta.mock ? 'Switch to live prices' : 'Switch to replay';
  mode.title = S.meta.mock ? 'Use real NSE prices and your main paper account' : 'Practise on real past days, one day at a time (works when the market is closed), with a separate replay balance';
  mode.addEventListener('click', async () => {
    const toSim = !S.meta.mock;
    const msg = toSim
      ? 'Switch to replay? You practise on real past days at their closing prices, with a separate replay balance. Option Desk restarts in a few seconds.'
      : 'Switch back to live NSE prices? Your replay session is kept for next time. Option Desk restarts in a few seconds.';
    if (!confirm(msg)) return;
    replay.stopPlay();
    const close = busy(toSim ? 'Switching to replay' : 'Switching to live NSE prices', 'Option Desk is restarting. This page reloads by itself in a few seconds.');
    await api('/api/restart', { sim: toSim }).catch(() => {});
    waitForRestart((m) => m.app.started !== app.started && m.mock === toSim, close);
  });
  $('#updPill').addEventListener('click', async () => {
    const big = $('#updPill').dataset.big === '1';
    if (!confirm(`Install the update now? Option Desk downloads it (${big ? 'about 100 MB' : 'about 0.5 MB'}) and restarts. Your paper account is kept.`)) return;
    const close = busy('Updating Option Desk', `Downloading ${big ? 'about 100 MB, which can take a minute or two' : 'a small update'}. Option Desk then restarts and this page reloads by itself. Keep this window open.`);
    try {
      const r = await api('/api/update', {});
      store.set('updatedTo', r.version);
      waitForRestart((m) => m.app.started !== app.started && m.app.version === r.version, close);
    } catch (e) { close(); toast(`Update failed: ${e.message}`, 'err'); }
  });
  const updated = store.get('updatedTo', null);
  if (updated) { store.set('updatedTo', null); if (updated === app.version) toast(`Updated to Option Desk ${app.version}.`); }
  if (app.updates) { checkUpdate(true); setInterval(() => checkUpdate(), 30 * 60e3); }
  const id = Math.random().toString(36).slice(2);
  // If the app underneath was updated or switched while this window stayed open, reload so the page matches it.
  const ping = () => api('/api/ping?c=' + id, {}).then((r) => { if (r.version && (r.version !== app.version || r.mock !== S.meta.mock)) location.reload(); }).catch(() => {});
  ping(); setInterval(ping, 30000);
  addEventListener('pagehide', () => navigator.sendBeacon('/api/bye?c=' + id));
}

async function pollQuotes() {
  if (replayIdle()) { renderSession(); return; }
  try {
    S.quotes = await api('/api/indices');
    offline = null; quotesAt = Date.now();
    renderTickers(); emit('quotes', S.quotes); broker.update(S.quotes.broker);
  } catch (e) { offline = e.message; }
  renderSession();
}

function showTab(name) {
  if (!TABS[name]) name = S.meta?.replay && replayIdle() ? 'replay' : 'markets';
  if (replayIdle() && NEEDS_MARKET.includes(name)) name = 'replay';
  S.tab = name;
  closeDrawer();
  for (const [k, mod] of Object.entries(TABS)) {
    const sec = $('#tab-' + k); const on = k === name;
    sec.hidden = !on;
    $(`.tabs [data-tab="${k}"]`).setAttribute('aria-selected', String(on));
    if (on) mod.show?.(); else mod.hide?.();
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  moveInk();
}

// One underline slides between tabs instead of each tab drawing its own.
function moveInk() {
  const b = $('.tabs [aria-selected="true"]'), ink = $('#tabInk'); if (!b || !ink) return;
  ink.style.width = b.offsetWidth - 24 + 'px'; ink.style.transform = `translateX(${b.offsetLeft + 12}px)`;
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
  if (S.meta.replay) initReplay();
  ticket.init();
  initGlossary();
  initTickerStrip();
  initDesktop();
  broker.init();
  stocks.init();
  on('universe', () => pollQuotes());
  // Streamed index ticks: header numbers move at once; the rest of the page catches up at most once a second.
  let lastEmit = 0;
  live.init(() => { renderTickers(); if (Date.now() - lastEmit > 1000) { lastEmit = Date.now(); emit('quotes', S.quotes); } });
  for (const [k, mod] of Object.entries(TABS)) { const sec = $('#tab-' + k); if (INTROS[k]) sec.append(intro(k)); mod.init?.(sec); }
  $('#tab-markets').prepend(guide());
  $('#guideBtn').addEventListener('click', () => { $('#guide').hidden = false; store.set('guideHidden', false); showTab('markets'); scrollTo({ top: 0, behavior: 'smooth' }); });
  const top = $('.top'); new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px')).observe(top);
  const tabs = $('.tabs'); new ResizeObserver(() => document.documentElement.style.setProperty('--tabs-h', tabs.getBoundingClientRect().height + 'px')).observe(tabs);
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#acctMini').addEventListener('click', () => showTab('positions'));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  on('account', renderAcctMini);
  on('symbol', async () => { renderTickers(); await loadExpiries().catch((e) => toast(e.message, 'err')); emit('expiries'); });
  on('goto', (t) => showTab(t));

  await pollQuotes();
  if (!replayIdle()) {
    await loadExpiries().catch((e) => toast(`Could not load expiries: ${e.message}`, 'err'));
    refreshAccount().catch(() => {});
  }
  showTab(location.hash.slice(1) || 'markets');

  every(5000, pollQuotes);
  if (!S.meta.replay) setInterval(() => { if (!document.hidden) renderSession(); }, 1000);
  addEventListener('resize', moveInk); document.fonts?.ready.then(moveInk);
  every(5000, () => TABS[S.tab].tick?.());
  every(8000, () => (S.tab !== 'positions' && !replayIdle() ? refreshAccount() : null));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollQuotes(); TABS[S.tab].tick?.(); } });
}

// Replay mode: a Replay tab and control bar, a clock set to the replay day, and a full refresh whenever the day changes.
function initReplay() {
  TABS.replay = replay;
  $('.tabs [data-tab="replay"]').hidden = false;
  $('.tabs [data-tab="positions"]').textContent = 'Replay account';
  for (const k of NEEDS_MARKET) if (replayIdle()) { const b = $(`.tabs [data-tab="${k}"]`); b.classList.add('off'); b.title = 'Start a replay session in the Replay tab first'; }
  on('day', async () => {
    await pollQuotes();
    await loadExpiries().catch(() => {});
    emit('expiries');
    await refreshAccount().catch(() => {});
    TABS[S.tab].show?.();
  });
}

boot();
