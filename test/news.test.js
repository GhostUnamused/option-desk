// News: RSS parsing, headline scoring, and the replay rule that no headline from after the replay day's close shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { News, parseRss } from '../lib/news.js';
import { scoreHeadline, shockOf, mood } from '../lib/sentiment.js';
import { eventsUpTo, EVENTS } from '../lib/events.js';

const item = (title, pub, source = 'Test Wire') => `<item><title><![CDATA[${title} - ${source}]]></title><link>https://example.com/${encodeURIComponent(title)}</link><pubDate>${pub}</pubDate><source url="https://example.com">${source}</source></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss><channel><title>Feed</title>${items.join('')}</channel></rss>`;

test('parses RSS items and strips the source suffix', () => {
  const out = parseRss(rss(item('Sensex &amp; Nifty rally', 'Mon, 02 Feb 2026 08:00:00 GMT')));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Sensex & Nifty rally');
  assert.equal(out[0].source, 'Test Wire');
  assert.equal(out[0].t, Date.parse('2026-02-02T08:00:00Z'));
});

test('headline tone and shocks', () => {
  assert.equal(scoreHeadline('Sensex surges 1,100 points as markets rally').label, 'positive');
  assert.equal(scoreHeadline('Nifty crashes as panic selling grips Dalal Street').label, 'negative');
  assert.equal(scoreHeadline('Nifty fails to rally').label, 'negative');
  assert.equal(scoreHeadline('Infosys to announce results on Thursday').label, 'neutral');
  assert.equal(shockOf('RBI hikes repo rate by 50 bps')?.kind, 'policy');
  assert.equal(shockOf('Russia invades Ukraine; markets tumble')?.kind, 'geopolitical');
  assert.equal(shockOf('RBI governor speaks at a banking summit'), null);
  const m = mood([{ t: 0, sentiment: { score: 1, label: 'positive' } }, { t: 0, sentiment: { score: -1, label: 'negative' }, shock: { kind: 'policy', severity: 2 } }], 0);
  assert.ok(m.score < 0); assert.equal(m.shocks, 1);
});

test('replay news never shows a headline from after the replay day close', async () => {
  const feed = rss(
    item('Market rallies on Friday', 'Fri, 30 Jan 2026 08:00:00 GMT'), // date only, an earlier day: shown
    item('Morning: Nifty opens higher', 'Mon, 02 Feb 2026 04:30:00 GMT'), // 10:00 IST on the day: shown
    item('Evening wrap: Sensex sheds 1,500 points', 'Mon, 02 Feb 2026 08:00:00 GMT'), // date only on the day: held back
    item('After the bell: US futures slide', 'Mon, 02 Feb 2026 12:00:00 GMT'), // 17:30 IST: after the close
    item('Tuesday: markets recover', 'Tue, 03 Feb 2026 05:00:00 GMT'), // the next day
  );
  let asked = '';
  const n = new News({ fetcher: async (url) => { asked = decodeURIComponent(url); return feed; } });
  const d = await n.asOf('2026-02-02');
  assert.match(asked, /before:2026-02-03/);
  assert.deepEqual(d.items.map((i) => i.title).sort(), ['Market rallies on Friday', 'Morning: Nifty opens higher']);
  for (const i of d.items) assert.ok(i.t <= Date.parse('2026-02-02T15:30:00+05:30'));
  // The next replay day sees the date-only story from the day before.
  assert.ok((await n.asOf('2026-02-03')).items.some((i) => i.title.startsWith('Evening wrap')));
});

test('events are listed up to a date only', () => {
  assert.ok(eventsUpTo('2020-03-31').some((e) => e.title.includes('COVID')));
  assert.ok(eventsUpTo('2020-03-31').every((e) => e.date <= '2020-03-31'));
  assert.ok(EVENTS.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && ['scheduled', 'shock'].includes(e.kind)));
});
