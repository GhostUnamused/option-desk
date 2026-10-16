// Replay: practise on real past NSE days. A control bar under the tabs moves the replay clock (a few minutes in a
// minute-by-minute session, a day, a week, to the next expiry, or auto-play), and the Replay tab holds session setup,
// the trade journal, the end-of-session summary, history downloads and settings. The server disguises dates in blind
// mode, so this file never has to.
import { api, el, $, inr0, inr2, rs, srs, pct, tone, toast, store, fmtDay, fmtExpiry, daysTo, instrument } from './util.js';
import { term } from './glossary.js';
import { S, emit, on, newDay } from './state.js';
import { setClock } from './bs.js';

let root, bar, playing = false, speed = store.get('replaySpeed', 2000), stepping = false, dlTimer = null, status = null;
let playBy = store.get('replayPlayBy', 'min1'); // what one auto-play step is in a minute-by-minute session: min1 | min5 | day
const R = () => S.meta.replay;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const back = (iso, months) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };

export function applyClock() { setClock(() => (R()?.date ? R().now : Date.now())); }

export function init(sec) {
  root = sec;
  applyClock();
  bar = $('#replayBar'); bar.hidden = false;
  renderBar();
  on('account', () => { if (S.tab === 'replay' && R().active) renderJournalSoon(); });
  document.addEventListener('keydown', (e) => {
    if (!R().active || e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); step('day'); }
    if ((e.key === 'm' || e.key === 'M') && R().running) { e.preventDefault(); step('minutes', false, 1); }
  });
}

export async function show() { await renderTab(); }
export function hide() { clearInterval(dlTimer); dlTimer = null; }
export function tick() {}

// ---- Control bar ----
function renderBar() {
  const r = R();
  if (!r.available) { bar.replaceChildren(el('span', { class: 'pill bad', text: 'Replay unavailable' }), el('span', { class: 'note', text: r.error || '' })); return; }
  if (!r.active) {
    bar.replaceChildren(el('span', { class: 'pill warn', text: 'Replay' }),
      el('span', { class: 'note', text: r.ended ? 'Session finished. See your summary, or start another one.' : 'No session yet. Download some history and pick a day to start from.' }),
      el('span', { class: 'sp' }), el('button', { class: 'btn sm', type: 'button', text: r.ended ? 'Open summary' : 'Set up replay', onclick: () => emit('goto', 'replay') }));
    return;
  }
  const dayLabel = (r.blind ? `Day ${r.day} · ${fmtDay(r.date, { day: undefined, month: undefined, year: undefined, weekday: 'long' })}` : fmtDay(r.date)) + (r.intraday ? ` · ${r.running ? r.time : 'closed'}` : '');
  const exp = expirySummary(r);
  const btn = (text, title, fn, can = r.hasNext) => el('button', { type: 'button', text, title, disabled: stepping || playing || !can, onclick: fn });
  const minuteMode = r.intraday && r.running;
  const playTitle = minuteMode && playBy !== 'day' ? `Move forward ${playBy === 'min5' ? 'five minutes' : 'one minute'} at a time until you press Pause, then on to the next day. Pauses while an order ticket is open.` : 'Move forward one trading day at a time until you press Pause. Pauses while an order ticket is open.';
  const play = el('button', { class: 'play' + (playing ? ' on' : ''), type: 'button', id: 'rpPlay', 'aria-pressed': String(playing), text: playing ? 'Pause' : 'Play', title: playTitle, disabled: !r.hasNext && !r.running && !playing, onclick: togglePlay });
  const unit = r.intraday && playBy !== 'day' ? 'a step' : 'a day';
  const sp = el('select', { class: 'sel sm', 'aria-label': 'Auto-play speed', title: 'Auto-play speed', onchange: (e) => { speed = +e.target.value; store.set('replaySpeed', speed); } },
    [[4000, 'Slow'], [2000, 'Normal'], [800, 'Fast']].map(([v, t]) => new Option(`${t} (${v / 1000} s ${unit})`, v, false, v === speed)));
  const by = r.intraday ? el('select', { class: 'sel sm', 'aria-label': 'Auto-play step', title: 'How far each auto-play step moves', onchange: (e) => { playBy = e.target.value; store.set('replayPlayBy', playBy); renderBar(); } },
    [['min1', 'Play by 1 min'], ['min5', 'Play by 5 min'], ['day', 'Play by day']].map(([v, t]) => new Option(t, v, false, v === playBy))) : '';
  const tip = r.intraday && !r.running ? (r.hasNext ? 'The market has closed for this day. Step to the next day.' : '') : '';
  bar.replaceChildren(
    el('span', { class: 'pill warn', text: r.blind ? 'Blind replay' : 'Replay' }),
    el('b', { class: 'rp-date', text: dayLabel, title: r.blind ? 'Blind mode: the real date is hidden until you end the session.' : minuteMode ? `Prices are the last trades before ${r.time} IST on this day.` : 'Prices are this day\'s closing prices.' }),
    el('span', { class: 'note rp-expiries', title: exp, text: tip || (r.blind ? exp : `Day ${r.day} of your session${exp ? ' · ' + exp : ''}`) }),
    el('span', { class: 'sp' }),
    minuteMode ? el('div', { class: 'transport', role: 'group', 'aria-label': 'Move forward within the day' },
      btn('+1 min', 'One minute ahead (shortcut: M)', () => step('minutes', false, 1), true),
      btn('+5 min', 'Five minutes ahead', () => step('minutes', false, 5), true),
      btn('+15 min', 'Fifteen minutes ahead', () => step('minutes', false, 15), true),
      btn('To close', `Jump to 15:30, when the day closes (${r.minutesLeft} minutes from now). Positions expiring today settle then.`, () => step('close'), true)) : '',
    el('div', { class: 'transport', role: 'group', 'aria-label': 'Move forward in time' },
      btn(r.intraday ? 'Next day' : '+1 day', `Next trading day${r.intraday ? ', from its opening minute' : ''} (shortcut: N)`, () => step('day')),
      btn('+1 week', 'Jump a week ahead, one trading day at a time', () => step('week')),
      btn('Next expiry', `Jump to the next ${S.meta.indices[S.symbol]?.short || ''} expiry day${r.intraday ? ' (or, on expiry day, to its close)' : ''}. Positions expiring then are settled at that day's close.`, () => step('expiry')),
      play),
    by || '', sp,
    !r.hasNext && !r.running ? el('span', { class: 'note', text: 'End of downloaded history' }) : '');
}

async function step(by, quiet = false, n = 1) {
  if (stepping) return false;
  stepping = true; if (!playing) renderBar();
  try {
    const r = await api('/api/replay/step', { by, symbol: S.symbol, n });
    await afterDay();
    if (r.settled) toast(`${r.settled} position${r.settled > 1 ? 's' : ''} settled at expiry. See the Replay account tab.`, 'ok');
    else if (!quiet && r.days > 1) toast(`Moved ${r.days} trading days ahead.`);
    else if (!quiet && (by === 'minutes' || by === 'close') && !R().running) toast('The market has closed for the day (15:30). Step to the next day when you are ready.');
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
  finally {
    stepping = false;
    // Auto-play advances frequently. Keep the existing controls in place so an
    // open native select (speed or step size) is not dismissed on every step.
    if (playing) updateBarDate(); else renderBar();
  }
}

// Reload the replay state and clock. A minute step is not a new day: let the
// app refresh prices/account marks without clearing caches or rebuilding tabs.
async function afterDay() {
  const previousDate = R()?.date;
  S.meta = await api('/api/meta');
  applyClock();
  if (R()?.date !== previousDate) newDay();
  else emit('replayTick');
}

function updateBarDate() {
  const r = R();
  const label = bar.querySelector('.rp-date');
  if (!label || !r?.active) return;
  label.textContent = (r.blind ? `Day ${r.day} · ${fmtDay(r.date, { day: undefined, month: undefined, year: undefined, weekday: 'long' })}` : fmtDay(r.date)) + (r.intraday ? ` · ${r.running ? r.time : 'closed'}` : '');
  label.title = r.blind ? 'Blind mode: the real date is hidden until you end the session.' : r.running ? `Prices are the last trades before ${r.time} IST on this day.` : 'Prices are this day\'s closing prices.';
  const exp = expirySummary(r), detail = bar.querySelector('.rp-expiries');
  if (detail) { detail.title = exp; detail.textContent = r.blind ? exp : `Day ${r.day} of your session${exp ? ' · ' + exp : ''}`; }
}

function expirySummary(r) {
  const list = r.availableExpiries?.[S.symbol] || (r.nextExpiry?.[S.symbol] ? [r.nextExpiry[S.symbol]] : []);
  if (!list.length) return '';
  const short = S.meta.indices[S.symbol]?.short || S.symbol;
  const labels = list.map(({ date, kind }) => {
    const days = Math.max(0, Math.round(daysTo(date)));
    const when = date === r.date ? 'today' : r.blind ? `in ${days} day${days === 1 ? '' : 's'}` : fmtExpiry(date);
    return `${when} ${kind}`;
  });
  return `${short} ${list.length === 1 ? 'expiry' : 'expiries'}: ${labels.join(', ')}`;
}

async function togglePlay() {
  playing = !playing; renderBar();
  while (playing) {
    if (!$('#ticket').open && !document.hidden) {
      const r = R(), byMinute = r.intraday && r.running && playBy !== 'day';
      const ok = byMinute ? await step('minutes', true, playBy === 'min5' ? 5 : 1) : await step('day', true);
      if (!ok || (!R().hasNext && !R().running)) { playing = false; renderBar(); break; }
    }
    await sleep(speed);
  }
}
export function stopPlay() { if (playing) { playing = false; renderBar(); } }

// ---- Replay tab ----
async function renderTab() {
  try { status = await api('/api/replay'); } catch (e) { root.replaceChildren(intro(), el('div', { class: 'panel errbox', text: e.message })); return; }
  if (!status.available) { root.replaceChildren(intro(), el('div', { class: 'panel errbox', text: status.error })); return; }
  const parts = [];
  if (status.active) parts.push(sessionPanel(), await journalPanel(false));
  else {
    if (status.ended) parts.push(await journalPanel(true));
    parts.push(startPanel());
  }
  parts.push(dataPanel(), el('div', { class: 'cols' }, howPanel(), settingsPanel()));
  root.replaceChildren(intro(), ...parts.filter(Boolean));
  if (status.download?.running || status.minutes?.download?.running) watchDownload();
}

function intro() {
  return el('p', { class: 'intro' }, el('b', { text: 'Practise on real past days.' }), ' Pick a day in history and trade it at that day\'s closing prices, or minute by minute through the day, then step forward a few minutes, a day, a week or to the next expiry. Your replay balance is separate from the live paper account, so practise freely.');
}

const stat = (k, v, cls, s) => el('div', { class: 'stat' }, el('div', { class: 'k' }, term(k)), el('div', { class: 'v ' + (cls || ''), text: v }), s ? el('div', { class: 's', text: s }) : null);

function sessionPanel() {
  const a = S.account; const r = status;
  let armed = false;
  const endBtn = el('button', { class: 'btn danger', type: 'button', text: 'End session', onclick: async () => {
    if (!armed) { armed = true; endBtn.textContent = 'Confirm: end and see summary'; setTimeout(() => { armed = false; endBtn.textContent = 'End session'; }, 4000); return; }
    stopPlay(); endBtn.disabled = true;
    try { await api('/api/replay/end', {}); location.hash = '#replay'; location.reload(); }
    catch (e) { toast(e.message, 'err'); endBtn.disabled = false; }
  } });
  return el('div', { class: 'panel' },
    el('div', { class: 'panel-h' }, el('h2', { text: r.blind ? 'Blind session in progress' : 'Session in progress' }), el('span', { class: 'sp' }), endBtn),
    el('div', { class: 'grid' },
      stat('Replay day', r.blind ? `Day ${r.day}` : fmtDay(r.date), '', r.blind ? 'Real date hidden until the end' : `Day ${r.day} since ${fmtDay(r.startDate)}`),
      a ? stat('Account value', rs(a.equity), '', `Started with ${rs(a.startBalance)}`) : null,
      a ? stat('Total P&L', srs(a.totalPnl), tone(a.totalPnl), pct(a.totalPnl / a.startBalance * 100) + ' since start') : null,
      a ? stat('Open positions', String(a.positions.length), '', a.positions.length ? (r.running ? `Marked at the last trades before ${r.time}` : 'Marked at the day\'s close') : 'Nothing open') : null),
    el('p', { class: 'note', style: { marginTop: '10px' }, text: 'Ending the session closes nothing: open positions are valued at the last close. You then see your full summary' + (r.blind ? ' and the real dates.' : '.') }));
}

let journalTimer = null;
function renderJournalSoon() { clearTimeout(journalTimer); journalTimer = setTimeout(async () => { const box = $('#rpJournal'); if (box) box.replaceWith(await journalPanel(false)); }, 300); }

async function journalPanel(final) {
  let j; try { j = await api('/api/replay/journal'); } catch (e) { return el('div', { class: 'panel errbox', id: 'rpJournal', text: e.message }); }
  const st = j.stats; const sess = j.session;
  dayIdx = new Map(j.days.map((d, i) => [d.date, i + 1]));
  const head = final
    ? el('div', { class: 'panel-h' }, el('h2', { text: 'Session summary' }), el('span', { class: 'note', text: sess ? `${fmtDay(sess.startDate)} to ${fmtDay(sess.asOf)} · ${st.tradingDays} trading days${sess.blind ? ' · that was a blind session' : ''}` : '' }))
    : el('div', { class: 'panel-h' }, el('h2', { text: 'Trade journal' }), el('span', { class: 'note', text: 'Your reasons, results and P&L for each day of this session.' }));
  const wr = st.winRate == null ? '—' : `${Math.round(st.winRate)}%`;
  const stats = el('div', { class: 'grid' },
    stat('Total P&L', srs(st.totalPnl), tone(st.totalPnl), `${pct(st.returnPct)} on ${rs(st.startBalance)}`),
    stat('Booked P&L', srs(st.realized), tone(st.realized), `${st.closedTrades} closing fill${st.closedTrades === 1 ? '' : 's'}, ${st.settlements} at expiry`),
    stat('Win rate', wr, '', st.closedTrades ? `${st.wins} won, ${st.losses} lost${st.avgWin != null ? ` · avg win ${srs(st.avgWin)}` : ''}${st.avgLoss != null ? ` · avg loss ${srs(st.avgLoss)}` : ''}` : 'No closed trades yet'),
    stat('Best day', st.bestDay ? srs(st.bestDay.pnl) : '—', 'up', st.bestDay ? dayName(st.bestDay.date, sess) : ''),
    stat('Worst day', st.worstDay ? srs(st.worstDay.pnl) : '—', 'down', st.worstDay ? dayName(st.worstDay.date, sess) : ''),
    stat('Largest drop', rs(-st.maxDrawdown), st.maxDrawdown ? 'down' : '', 'Biggest fall from a high point of your account'),
    stat('Charges paid', rs(st.charges), '', `${st.orders} order${st.orders === 1 ? '' : 's'} placed`));
  const out = [head, stats];
  if (final) out.push(reflection(st));
  out.push(el('div', { class: 'cols', style: { marginTop: '12px' } },
    el('div', {}, el('h3', { class: 'sub', text: 'P&L by day' }), daysChart(j.days), daysTable(j.days, sess)),
    el('div', {}, el('h3', { class: 'sub', text: 'Trades and your reasons' }), tradesList(j.trades, sess))));
  return el('div', { class: 'panel', id: 'rpJournal' }, ...out);
}

const dayName = (iso, sess) => (sess?.blind && !sess.ended ? `Day ${dayIndex(iso)}` : fmtDay(iso));
let dayIdx = new Map();
function dayIndex(iso) { return dayIdx.get(iso) ?? '?'; }

function reflection(st) {
  const lines = [];
  if (!st.orders) lines.push('You did not place any trades. Next time, try one small trade and write down why before you place it.');
  else {
    lines.push(st.totalPnl >= 0 ? `You finished up ${rs(st.totalPnl)} (${pct(st.returnPct)}).` : `You finished down ${rs(Math.abs(st.totalPnl))} (${pct(st.returnPct)}).`);
    if (st.charges > Math.abs(st.totalPnl) / 2 && st.charges > 200) lines.push(`Charges of ${rs(st.charges)} took a big bite: fewer, better-planned trades keep more of what you make.`);
    if (st.withNotes < st.orders) lines.push(`${st.orders - st.withNotes} of your ${st.orders} orders had no written reason. Writing one down before each trade is the habit that teaches the most.`);
    if (st.winRate != null && st.avgLoss != null && st.avgWin != null && Math.abs(st.avgLoss) > st.avgWin * 1.5) lines.push('Your average loss is much bigger than your average win. Decide where you will exit before you enter.');
  }
  return el('p', { class: 'summary', style: { marginTop: '12px' }, text: lines.join(' ') });
}

function daysChart(days) {
  const W = 560, H = 120, m = 4;
  if (!days.length) return el('p', { class: 'note', text: 'No days yet.' });
  const big = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  const NS = 'http://www.w3.org/2000/svg'; const mk = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Profit or loss for each day of the session', class: 'rp-days' });
  const bw = (W - 2 * m) / days.length; const mid = H / 2;
  svg.append(mk('line', { x1: m, x2: W - m, y1: mid, y2: mid, stroke: 'var(--line)', 'vector-effect': 'non-scaling-stroke' }));
  days.forEach((d, i) => {
    const h = Math.abs(d.pnl) / big * (mid - 6);
    const r = mk('rect', { x: m + i * bw + bw * 0.15, width: Math.max(1, bw * 0.7), y: d.pnl >= 0 ? mid - h : mid, height: Math.max(d.pnl ? 1 : 0, h), fill: d.pnl >= 0 ? 'var(--up)' : 'var(--down)', rx: 1.5 });
    const t = document.createElementNS(NS, 'title'); t.textContent = `Day ${i + 1}: ${srs(d.pnl)}`; r.append(t); svg.append(r);
  });
  return el('div', { class: 'svgchart' }, svg);
}

function daysTable(days, sess) {
  const blind = sess?.blind && !sess.ended;
  return el('div', { class: 'tw', style: { maxHeight: '320px', marginTop: '8px' } }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', { class: 'l', text: 'Day' }), el('th', { text: 'Day P&L' }), el('th', { text: 'Total P&L' }), el('th', {}, term('Account value')))),
    el('tbody', {}, [...days].reverse().map((d, i) => el('tr', {},
      el('td', { class: 'l t', text: blind ? `Day ${days.length - i}` : fmtDay(d.date) }),
      el('td', { class: tone(d.pnl), text: srs(d.pnl) }), el('td', { class: tone(d.total), text: srs(d.total) }), el('td', { text: rs(d.equity) }))))));
}

function tradesList(trades, sess) {
  if (!trades.length) return el('p', { class: 'note', text: 'No trades yet. Place one from the Option chain or the Strategy builder; the order ticket asks why you are taking it.' });
  const blind = sess?.blind && !sess.ended;
  return el('div', { class: 'rp-trades' }, [...trades].reverse().map((o) => el('div', { class: 'rp-trade' },
    el('div', { class: 'rp-trade-h' },
      el('span', { class: 'muted', text: blind ? `Day ${dayIndex(o.date)}` : fmtDay(o.date) }),
      el('b', { class: o.side === 'BUY' ? 'up' : 'down', text: o.side === 'BUY' ? 'Buy' : 'Sell' }),
      el('span', { text: `${o.lots} × ${instrument(o)} @ ₹${inr2.format(o.price)}` }),
      el('span', { class: 'sp' }),
      o.realized ? el('b', { class: tone(o.realized), text: srs(o.realized) }) : null),
    o.note ? el('p', { class: 'rp-note', text: o.note }) : o.tag ? el('p', { class: 'note', text: o.tag }) : el('p', { class: 'note', text: 'No reason written down.' }))));
}

function startPanel() {
  const c = status.coverage;
  if (!c?.first) return el('div', { class: 'panel' }, el('h2', { text: 'Start a practice session' }), el('p', { class: 'note', style: { marginTop: '6px' }, text: 'First download some history below. Three to six months is a good start: about 1 MB per trading day.' }));
  const minStart = c.first, maxStart = c.last;
  const suggested = store.get('replayStart', null) || (() => { const d = new Date(Date.parse(c.first) + 90 * 864e5).toISOString().slice(0, 10); return d < c.last ? d : c.first; })();
  const date = el('input', { class: 'inp', type: 'date', id: 'rpStart', min: minStart, max: maxStart, value: suggested < minStart || suggested > maxStart ? minStart : suggested, style: { width: '11em' } });
  const rand = el('input', { type: 'checkbox', id: 'rpRandom', onchange: () => { date.disabled = rand.checked; } });
  const mc = status.minutes?.coverage;
  const intraday = el('input', { type: 'checkbox', id: 'rpIntraday', disabled: !mc?.days, checked: Boolean(mc?.days) && store.get('replayIntraday', false), onchange: () => {
    store.set('replayIntraday', intraday.checked);
    if (intraday.checked && mc.first && (date.value < mc.first || date.value > mc.last)) date.value = mc.first;
  } });
  const blind = el('input', { type: 'checkbox', id: 'rpBlind', onchange: () => { if (blind.checked && !rand.checked) { rand.checked = true; date.disabled = true; } } });
  const bal = el('input', { class: 'inp', type: 'number', id: 'rpBal', min: '10000', step: '50000', value: String(status.startBalance) });
  const go = el('button', { class: 'btn', type: 'button', text: 'Start session', onclick: async () => {
    go.disabled = true;
    try {
      store.set('replayStart', date.value);
      await api('/api/replay/start', { date: date.value, random: rand.checked, blind: blind.checked, balance: +bal.value, intraday: intraday.checked });
      location.hash = '#markets'; location.reload();
    } catch (e) { toast(e.message, 'err'); go.disabled = false; }
  } });
  const histDays = Math.round((Date.parse(date.value) - Date.parse(c.first)) / 864e5);
  return el('div', { class: 'panel' },
    el('div', { class: 'panel-h' }, el('h2', { text: status.ended ? 'Start another session' : 'Start a practice session' })),
    el('div', { class: 'rp-form' },
      el('label', { class: 'f', for: 'rpStart' }, 'Start on this day', date),
      el('label', { class: 'f', for: 'rpBal' }, 'Replay balance (₹)', bal),
      el('label', { class: 'check' }, rand, el('span', {}, el('b', { text: 'Random day' }), ' from your history')),
      el('label', { class: 'check' }, blind, el('span', {}, el('b', { text: 'Blind mode' }), ': hide the real date until you finish, so you trade what you see, not what you remember')),
      el('label', { class: 'check' }, intraday, el('span', {}, el('b', { text: 'Minute by minute' }), mc?.days ? `: watch each day unfold from 09:16 and trade at the prices of that minute. Minute prices downloaded for ${mc.days} day${mc.days === 1 ? '' : 's'}, ${fmtDay(mc.first)} to ${fmtDay(mc.last)}.` : ': download minute prices below first.')),
      go),
    el('p', { class: 'note', style: { marginTop: '10px' }, text: `You have history from ${fmtDay(c.first)} to ${fmtDay(c.last)}. Charts and the market read look back up to a year, so starting a few months after the first day gives them something to show${histDays < 60 ? ' (the day picked has under two months before it)' : ''}. Starting a session replaces the previous one and its balance.` }));
}

function dataPanel() {
  const c = status.coverage;
  if (!c) return el('div', { class: 'panel' }, el('h2', { text: 'Historical data' }), el('p', { class: 'note', style: { marginTop: '6px' }, text: 'Hidden during a blind session, because the list of downloaded days would give the dates away.' }));
  const m = status.minutes, mc = m?.coverage || {}, today = isoToday();
  const selected = new Set(store.get('replayDownloadSymbols', status.symbols || ['NIFTY', 'BANKNIFTY']));
  const to = el('input', { class: 'inp', type: 'date', id: 'rpTo', value: today, max: today, min: status.earliest, style: { width: '11em' } });
  const from = el('input', { class: 'inp', type: 'date', id: 'rpFrom', value: m?.indexFrom || back(today, 6), max: today, min: status.earliest, style: { width: '11em' } });
  const preset = (label, months) => el('button', { class: 'btn ghost sm', type: 'button', text: label, onclick: () => { to.value = today; from.value = months ? back(today, months) : m?.indexFrom || status.earliest; } });
  const choices = (status.symbols || ['NIFTY', 'BANKNIFTY']).map((symbol) => {
    const box = el('input', { type: 'checkbox', checked: selected.has(symbol), value: symbol, onchange: () => {
      const next = [...$('#rpSymbols').querySelectorAll('input:checked')].map((x) => x.value);
      if (!next.length) { box.checked = true; toast('Choose at least one index.', 'err'); return; }
      store.set('replayDownloadSymbols', next);
    } });
    return el('label', { class: 'check rp-symbol-choice' }, box, el('span', {}, el('b', { text: S.meta.indices[symbol]?.short || symbol })));
  });
  const dl = el('button', { class: 'btn', type: 'button', id: 'rpDl', text: m?.source.connected ? 'Download daily + minute history' : 'Download daily history', disabled: Boolean(status.download?.running || m?.download?.running), onclick: async () => {
    const symbols = [...$('#rpSymbols').querySelectorAll('input:checked')].map((x) => x.value);
    if (!symbols.length) { toast('Choose at least one index.', 'err'); return; }
    try {
      status.download = await api('/api/replay/download', { from: from.value, to: to.value, symbols });
      if (m?.source.connected) {
        status.minutes.download = await api('/api/replay/minutes/download', { from: from.value, to: to.value, symbols });
      } else toast('Daily history started. Connect INDstocks to include minute prices.', 'err');
      watchDownload();
    } catch (e) { toast(e.message, 'err'); watchDownload(); }
  } });
  const cov = c.first
    ? el('div', { class: 'grid' },
      stat('History from', fmtDay(c.first)), stat('History to', fmtDay(c.last)),
      stat('Trading days', inr0.format(c.tradingDays), '', `${c.holidays} holiday${c.holidays === 1 ? '' : 's'} skipped`),
      stat('On disk', `${c.megabytes} MB`, '', 'replay.db in your data folder'))
    : el('p', { class: 'note', text: 'Nothing downloaded yet.' });
  const gaps = c.ranges.length > 1 ? el('p', { class: 'note', style: { marginTop: '8px' }, text: `Downloaded in ${c.ranges.length} separate stretches: ${c.ranges.map((r) => `${fmtDay(r.from)} – ${fmtDay(r.to)}`).join('; ')}. Replay jumps over the gaps.` }) : null;
  const errs = c.errorDays ? el('p', { class: 'warnbox', style: { marginTop: '8px' }, text: `${c.errorDays} day${c.errorDays > 1 ? 's' : ''} could not be read (latest: ${c.errors.map((e) => `${e.date}: ${e.note}`).slice(0, 2).join('; ')}). Downloading the same range again retries them.` }) : null;
  const minuteSummary = mc.indexDays
    ? `${inr0.format(mc.indexDays)} index days, ${fmtDay(mc.indexFirst)} to ${fmtDay(mc.indexLast)} · option days: ${Object.entries(mc.bySymbol || {}).map(([s, n]) => `${S.meta.indices[s]?.short || s} ${n}`).join(' · ') || 'none yet'}`
    : 'No minute data downloaded yet.';
  const sourceNote = m?.source.connected
    ? `Minute source is connected. Index bars go back to ${fmtDay(m.indexFrom)}; expired option prices begin with the ${fmtDay(m.optionsFrom)} expiry. Earlier dates in your range still download daily history.`
    : `Minute source is not connected. ${m?.source.problem || 'Connect INDstocks from the Data button to add minute history.'} Daily history is still available.`;
  return el('div', { class: 'panel', id: 'rpData' },
    el('div', { class: 'panel-h rp-download-heading' }, el('h2', { text: 'Replay data' }), el('span', { class: 'note', text: 'One range, one download. Covered daily dates and complete minute windows are skipped; partial minute windows refresh safely.' })),
    cov, gaps, errs,
    el('div', { class: 'rp-download-summary' },
      el('b', { text: 'Minute history' }), el('span', { class: 'note', text: minuteSummary })),
    el('div', { class: 'rp-download-controls' },
      el('div', { class: 'rp-download-field' }, el('span', { class: 'rp-download-label', text: 'Indices' }), el('div', { class: 'rp-presets', id: 'rpSymbols' }, ...choices)),
      el('div', { class: 'rp-download-field' }, el('span', { class: 'rp-download-label', text: 'Date range' }),
        el('div', { class: 'rp-range' }, el('label', { class: 'f', for: 'rpFrom' }, 'From', from), el('label', { class: 'f', for: 'rpTo' }, 'To', to))),
      el('div', { class: 'rp-presets' }, preset('3 months', 3), preset('6 months', 6), preset('1 year', 12), preset('All minute history', 0)),
      dl),
    el('p', { class: 'note', style: { marginTop: '8px' }, text: `Daily NSE archives include options and closing prices for the selected indices${status.symbols?.length > selected.size ? ' only' : ''}. ${sourceNote} Minute option prices are available only for expired contracts. About 30 MB per month of minute history.` }),
    el('div', { id: 'rpProgress' }), el('div', { id: 'rpMinProgress' }));
}

function renderMinuteProgress() {
  const box = $('#rpMinProgress'); const d = status?.minutes?.download; if (!box || !d) return;
  const pctDone = d.total ? Math.round(d.done / d.total * 100) : d.running ? 0 : 100;
  const msg = d.running
    ? `${d.current || 'Starting'} · ${d.done} of ${d.total || '…'} steps`
    : d.cancelled ? `Stopped after ${d.done} of ${d.total} steps.` : `Finished: ${inr0.format(d.bars)} one-minute prices saved${d.failed ? `, ${d.failed} step${d.failed > 1 ? 's' : ''} failed` : ''}.`;
  box.replaceChildren(
    el('div', { class: 'rp-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctDone) }, el('i', { style: { width: pctDone + '%' } })),
    el('div', { class: 'rp-prog-row' }, el('span', { class: 'note', text: msg }), el('span', { class: 'sp' }),
      d.running ? el('button', { class: 'btn ghost sm', type: 'button', text: 'Cancel', onclick: () => api('/api/replay/minutes/cancel', {}).catch(() => {}) }) : null),
    d.error ? el('p', { class: d.running ? 'note' : 'warnbox', text: d.error }) : '',
    ...(d.notes || []).map((n) => el('p', { class: 'note', text: n })));
  const btn = $('#rpDl'); if (btn) btn.disabled = d.running || Boolean(status.download?.running);
}

function renderProgress() {
  renderMinuteProgress();
  const box = $('#rpProgress'); const d = status?.download; if (!box || !d) return;
  const pctDone = d.total ? Math.round(d.done / d.total * 100) : 100;
  const msg = d.running
    ? `Downloading ${d.current ? fmtDay(d.current) : ''} · ${d.done} of ${d.total} days`
    : d.cancelled ? `Stopped after ${d.done} of ${d.total} days.` : d.total ? `Finished: ${d.saved} trading days saved, ${d.holidays} holidays${d.notYet ? `, ${d.notYet} not published yet (NSE posts each day's files in the evening)` : ''}${d.failed ? `, ${d.failed} failed` : ''}.` : 'Everything in that range is already downloaded.';
  box.replaceChildren(
    el('div', { class: 'rp-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctDone) }, el('i', { style: { width: pctDone + '%' } })),
    el('div', { class: 'rp-prog-row' }, el('span', { class: 'note', text: msg }), el('span', { class: 'sp' }),
      d.running ? el('button', { class: 'btn ghost sm', type: 'button', text: 'Cancel', onclick: () => api('/api/replay/download/cancel', {}).catch(() => {}) }) : null),
    d.error ? el('p', { class: d.running ? 'note' : 'warnbox', text: d.error }) : '');
  const btn = $('#rpDl'); if (btn) btn.disabled = d.running || Boolean(status.minutes?.download?.running);
}

function watchDownload() {
  renderProgress();
  clearInterval(dlTimer);
  dlTimer = setInterval(async () => {
    try {
      const s = await api('/api/replay'); status.download = s.download; if (s.minutes) status.minutes.download = s.minutes.download; renderProgress();
      if (!s.download?.running && !s.minutes?.download?.running) { clearInterval(dlTimer); dlTimer = null; await renderTab(); }
    }
    catch {}
  }, 1500);
}

function settingsPanel() {
  const inp = el('input', { class: 'inp', type: 'number', id: 'rpRate', min: '0', max: '20', step: '0.25', value: String(+(status.riskFree * 100).toFixed(2)) });
  return el('div', { class: 'panel' },
    el('h2', { text: 'Settings' }),
    el('div', { class: 'rp-form', style: { marginTop: '10px' } },
      el('label', { class: 'f', for: 'rpRate' }, el('span', {}, term('Risk-free rate'), ' (% a year)'), inp),
      el('button', { class: 'btn ghost', type: 'button', text: 'Save', onclick: async () => {
        try { await api('/api/replay/settings', { riskFreePct: +inp.value }); S.meta = await api('/api/meta'); newDay(); toast(`Risk-free rate set to ${inp.value}%. Implied volatility and Greeks are recalculated with it.`, 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      } })),
    el('p', { class: 'note', style: { marginTop: '8px' }, text: 'Used to work out implied volatility and the Greeks from each option\'s closing price. India\'s short-term rate has mostly been 4% to 7%; small changes barely move the results.' }));
}

function howPanel() {
  const li = (b, t) => el('li', {}, el('b', { text: b }), ' ', t);
  return el('div', { class: 'panel' },
    el('h2', { text: 'How replay works' }),
    el('ul', { class: 'rp-how' },
      li('One price per day, or one a minute.', 'Each day uses NSE\'s official closing prices (the bhavcopy). In a minute-by-minute session the day runs from 09:16 to 15:30 instead: the index chart and option prices are the last trades before each minute, open interest is the previous day\'s, and the day\'s closing prices only appear at 15:30.'),
      li('Fills include slippage.', 'Buys fill a little above the close and sells a little below, more so for strikes far from the index or with few trades that day. Strikes with no trades at all that day cannot be traded.'),
      li('Expiry settles by itself.', 'Positions still open on expiry day close at their value against that day\'s index close, just like the exchange does.'),
      li('The clock only moves forward.', 'You cannot see tomorrow: every number on screen comes from that day or earlier.'),
      li('Separate money.', 'The replay balance has nothing to do with your live paper account.')));
}
