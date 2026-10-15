// News & sentiment panel: headlines with a tone dot and shock tags, and an overall news mood.
// Live: the latest market headlines. Replay: headlines up to the close of the replay day (none in blind mode).
import { api, el, fmtDay } from './util.js';
import { S, on } from './state.js';

const cache = new Map(); let box, refreshBtn, filter = 'all', refreshing = false;
const TONE = { positive: ['up', 'Positive'], negative: ['down', 'Negative'], neutral: ['', 'Mixed'] };

export async function loadNews(symbol = S.symbol, force = false) {
  const hit = cache.get(symbol);
  if (hit && !force && Date.now() - hit.at < (S.meta.replay ? 10 * 60e3 : 60e3)) return hit.data;
  const data = await api(`/api/news?symbol=${symbol}${force && !S.meta.replay ? '&refresh=1' : ''}`);
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

export function panel() {
  box = el('div', { class: 'news' }, el('p', { class: 'note', text: 'Loading headlines…' }));
  const seg = el('div', { class: 'seg news-seg', role: 'group', 'aria-label': 'Which headlines' }, [['all', 'All'], ['shock', 'Shocks'], ['negative', 'Negative'], ['positive', 'Positive']].map(([k, t]) =>
    el('button', { type: 'button', class: k === filter ? 'on' : '', text: t, onclick: () => { filter = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === t)); render(); } })));
  refreshBtn = el('button', { class: 'btn ghost sm news-refresh', type: 'button', text: '↻ Refresh', title: 'Fetch the latest headlines now', onclick: () => refresh(true) });
  on('day', () => cache.clear());
  return el('div', { class: 'panel' }, el('div', { class: 'panel-h news-head' }, el('h2', { text: 'News & sentiment' }), refreshBtn, seg), box);
}

let last = null;
export async function refresh(force = false) {
  if (!box || refreshing) return;
  const symbol = S.symbol;
  refreshing = true;
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = 'Loading…'; }
  try { last = await loadNews(symbol, force); if (symbol === S.symbol) render(); }
  catch (e) { box.replaceChildren(el('p', { class: 'errbox', text: `News unavailable: ${e.message}` })); }
  finally { refreshing = false; if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh'; } if (symbol !== S.symbol) refresh(); }
}

function ago(t) {
  if (S.meta.replay) return new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

export function moodGauge(m) {
  const pos = Math.round((m.score + 1) * 50);
  const cls = m.score > 0.08 ? 'up' : m.score < -0.08 ? 'down' : '';
  const signed = `${m.score > 0 ? '+' : ''}${m.score.toFixed(2)}`;
  return el('section', { class: 'mood-card', 'aria-label': 'Headline tone summary' },
    el('div', { class: 'mood-top' },
      el('div', {}, el('span', { class: 'mood-kicker', text: 'HEADLINE TONE' }), el('div', { class: 'mood-title' }, el('b', { class: cls, text: m.label }), el('span', { class: 'mood-score', text: signed }))),
      el('span', { class: `confidence ${String(m.confidence || 'Low').toLowerCase()}`, title: 'Based on headline count, source variety and how many headlines contain directional language', text: `${m.confidence || 'Low'} confidence` })),
    el('div', { class: 'mood-bar', title: `Weighted score ${signed} on a −1 to +1 scale; recent headlines count more` }, el('i', { style: { left: `calc(${pos}% - 5px)` } })),
    el('div', { class: 'mood-ends' }, el('span', { text: 'Bearish' }), el('span', { text: 'Mixed' }), el('span', { text: 'Bullish' })),
    el('div', { class: 'mood-foot', text: `${m.total} headlines from ${m.sources || 0} sources · ${m.positive} positive / ${m.neutral} mixed / ${m.negative} negative` }));
}

const titleCase = (s) => s ? s.replace(/\b\w/g, (x) => x.toUpperCase()) : '';
function story(i) {
  const [cls, word] = TONE[i.sentiment.label] || TONE.neutral;
  const sources = i.sources || (i.source ? [i.source] : []);
  const byline = sources.length > 1 ? `${sources[0]} + ${sources.length - 1} more` : (i.source || 'News source');
  return el('li', { class: `story ${cls}` },
    el('span', { class: 'story-tone', title: `${word} headline tone` }),
    el('div', { class: 'story-body' },
      el('a', { class: 'story-title', href: i.link, target: '_blank', rel: 'noopener noreferrer', text: i.title }),
      i.summary ? el('div', { class: 'story-excerpt', text: i.summary }) : null,
      el('div', { class: 'story-verdict' }, el('b', { class: cls, text: word }), ' · ', titleCase(i.sentiment.reason || 'No clear directional signal'),
        i.shock ? el('span', { class: `impact-tag${i.shock.severity > 1 ? ' major' : ''}`, text: i.shock.severity > 1 ? 'Major market risk' : 'Worth watching' }) : null),
      el('div', { class: 'story-meta' }, el('span', { text: byline }), el('span', { text: ago(i.t) }),
        sources.length > 1 ? el('span', { class: 'replicated', text: `${sources.length} sources` }) : null)));
}

function render() {
  const d = last; if (!d) return;
  if (d.hidden) { box.replaceChildren(el('p', { class: 'note', text: d.reason })); return; }
  const items = d.items.filter((i) => filter === 'all' || (filter === 'shock' ? i.shock : i.sentiment.label === filter));
  const head = [moodGauge(d.mood)];
  if (d.mood.shocks) head.push(el('p', { class: 'shock-note' }, el('b', { text: `${d.mood.shocks} major market risk${d.mood.shocks > 1 ? 's' : ''}. ` }), 'These stories can move the whole market quickly. Read the source before acting on the tag.'));
  head.push(el('div', { class: 'news-context' },
    el('b', { text: 'Quick read' }),
    el('span', { text: S.meta.replay
      ? `Stories known by ${fmtDay(S.meta.replay.date)} at the replay time. Scores use the headline and any RSS excerpt available then.`
      : 'Scores use the headline and RSS excerpt when available. They judge wording, not the next price move; open the source for context.' })));
  box.replaceChildren(...head,
    el('div', { class: 'news-list-head' }, el('b', { text: filter === 'all' ? 'Latest stories' : `${titleCase(filter)} headlines` }), el('span', { class: 'note', text: `${items.length} shown` })),
    items.length ? el('ul', { class: 'news-list' }, items.map(story)) : el('p', { class: 'note news-empty', text: d.items.length ? 'No headlines match this filter.' : 'No headlines found for this day.' }),
    d.errors?.length ? el('p', { class: 'note', text: `Some sources did not answer: ${d.errors.join('; ')}` }) : '');
}
