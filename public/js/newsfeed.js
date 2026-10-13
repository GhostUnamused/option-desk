// News & sentiment panel: headlines with a tone dot and shock tags, and an overall news mood.
// Live: the latest market headlines. Replay: headlines up to the close of the replay day (none in blind mode).
import { api, el, fmtDay } from './util.js';
import { S, on } from './state.js';

const cache = new Map(); let box, filter = 'all';
const TONE = { positive: ['up', 'Positive'], negative: ['down', 'Negative'], neutral: ['', 'Neutral'] };

export async function loadNews(symbol = S.symbol, force = false) {
  const hit = cache.get(symbol);
  if (hit && !force && Date.now() - hit.at < (S.meta.replay ? 10 * 60e3 : 60e3)) return hit.data;
  const data = await api(`/api/news?symbol=${symbol}`);
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

export function panel() {
  box = el('div', { class: 'news' }, el('p', { class: 'note', text: 'Loading headlines…' }));
  const seg = el('div', { class: 'seg news-seg', role: 'group', 'aria-label': 'Which headlines' }, [['all', 'All'], ['shock', 'Shocks'], ['negative', 'Negative'], ['positive', 'Positive']].map(([k, t]) =>
    el('button', { type: 'button', class: k === filter ? 'on' : '', text: t, onclick: () => { filter = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === t)); render(); } })));
  on('day', () => cache.clear());
  return el('div', { class: 'panel' }, el('div', { class: 'panel-h' }, el('h2', { text: 'News & sentiment' }), el('span', { class: 'sp' }), seg), box);
}

let last = null;
export async function refresh() {
  if (!box) return;
  try { last = await loadNews(); render(); }
  catch (e) { box.replaceChildren(el('p', { class: 'errbox', text: `News unavailable: ${e.message}` })); }
}

function ago(t) {
  if (S.meta.replay) return new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

export function moodGauge(m) {
  const pos = Math.round((m.score + 1) * 50);
  const cls = m.score > 0.08 ? 'up' : m.score < -0.08 ? 'down' : '';
  return el('div', { class: 'mood' },
    el('div', { class: 'mood-h' }, el('span', { class: 'note', text: 'News mood' }), el('b', { class: cls, text: m.label }), el('span', { class: 'sp' }),
      el('span', { class: 'note', text: `${m.positive} positive · ${m.negative} negative · ${m.neutral} neutral${m.watch ? ` · ${m.watch} to watch` : ''}` })),
    el('div', { class: 'mood-bar', title: `Score ${m.score.toFixed(2)} on a −1 to +1 scale` }, el('i', { style: { left: `calc(${pos}% - 2px)` } })),
    el('div', { class: 'mood-ends' }, el('span', { text: 'Bearish' }), el('span', { text: 'Bullish' })));
}

function render() {
  const d = last; if (!d) return;
  if (d.hidden) { box.replaceChildren(el('p', { class: 'note', text: d.reason })); return; }
  const items = d.items.filter((i) => filter === 'all' || (filter === 'shock' ? i.shock : i.sentiment.label === filter));
  const head = [moodGauge(d.mood)];
  if (d.mood.shocks) head.push(el('p', { class: 'shock-note' }, el('b', { text: `${d.mood.shocks} shock headline${d.mood.shocks > 1 ? 's' : ''}. ` }), 'News like this (wars, rate decisions, budgets, crashes) can make the index gap and option prices jump. Sellers of options are most exposed.'));
  head.push(el('p', { class: 'note', text: S.meta.replay ? `Headlines from the days before ${fmtDay(S.meta.replay.date)}, plus that day's ones timed before the 3:30 pm close. Stories dated only by day appear from the next day, since they may have come out after the close.` : 'Scored by word choice, not by a person: treat the mood as a rough guide, and read the headline.' }));
  box.replaceChildren(...head,
    items.length ? el('ul', { class: 'news-list' }, items.map((i) => {
      const [cls, word] = TONE[i.sentiment.label];
      return el('li', {}, el('i', { class: 'dot ' + cls, title: word }),
        el('div', {}, el('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer', text: i.title }),
          el('div', { class: 'meta' }, el('span', { text: [i.source, ago(i.t)].filter(Boolean).join(' · ') }), i.shock ? el('span', { class: 'shock' + (i.shock.severity > 1 ? ' hi' : ''), title: i.shock.severity > 1 ? 'News of this kind can make the whole market gap' : 'Worth knowing: can move the market', text: `${i.shock.severity > 1 ? 'Shock' : 'Watch'}: ${i.shock.kind}` }) : null)));
    })) : el('p', { class: 'note', text: d.items.length ? 'No headlines match this filter.' : 'No headlines found for this day.' }),
    d.errors?.length ? el('p', { class: 'note', text: `Some sources did not answer: ${d.errors.join('; ')}` }) : '');
}
