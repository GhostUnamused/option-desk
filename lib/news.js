// Market news with sentiment, from public RSS feeds (no keys). Live: the latest headlines from Google News plus
// Economic Times, Business Standard and Mint market feeds. Replay: a Google News search bounded to the days before
// the replay date, and only items published by that day's close are kept (the as-of rule, applied to news).
import fs from 'node:fs';
import { scoreHeadline, shockOf, mood } from './sentiment.js';
import { INDICES } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
const TOPIC = { NIFTY: '(nifty OR sensex OR "stock market" OR "dalal street" OR RBI)', BANKNIFTY: '("bank nifty" OR "banking stocks" OR nifty OR sensex OR RBI)' };
// Search words for a symbol: the index topics above, a stock's company name, or a BSE index by name.
function topic(symbol) {
  const u = INDICES[symbol];
  if (TOPIC[symbol] || !u) return TOPIC[symbol] || TOPIC.NIFTY;
  if (u.kind === 'stock') return `("${u.name.replace(/ (ltd|limited)\.?$/i, '')}" OR "${symbol} share")`;
  return `("${u.name}" OR sensex OR nifty)`;
}
const FEEDS = [
  ['Economic Times', 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms'],
  ['Business Standard', 'https://www.business-standard.com/rss/markets-106.rss'],
  ['Mint', 'https://www.livemint.com/rss/markets'],
];
const closeTime = (date) => Date.parse(date + 'T15:30:00+05:30');
const addDays = (date, n) => new Date(Date.parse(date) + n * 864e5).toISOString().slice(0, 10);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m))
  .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? decode(m[1]) : ''; };

export function parseRss(xml, fallbackSource = '') {
  const out = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0];
    let title = tag(it, 'title'); const source = tag(it, 'source') || fallbackSource;
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const t = Date.parse(tag(it, 'pubDate'));
    const link = tag(it, 'link') || (/<link\s*\/?>\s*([^<\s]+)/i.exec(it)?.[1] ?? '');
    if (title && Number.isFinite(t)) out.push({ title, source, link, t });
  }
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter((w) => w.length > 3).slice(0, 8).join(' ');
function enrich(items, max = 40) {
  const seen = new Set(), out = [];
  for (const i of items.sort((a, b) => b.t - a.t)) {
    const k = norm(i.title); if (seen.has(k)) continue; seen.add(k);
    out.push({ ...i, sentiment: scoreHeadline(i.title), shock: shockOf(i.title) });
    if (out.length >= max) break;
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
}

export class News {
  constructor({ cacheFile = null, fetcher = fetchText } = {}) {
    this.fetcher = fetcher; this.live = new Map(); this.cacheFile = cacheFile;
    this.disk = {}; try { if (cacheFile) this.disk = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    this.inflight = new Map();
  }

  once(key, fn) { if (!this.inflight.has(key)) this.inflight.set(key, fn().finally(() => this.inflight.delete(key))); return this.inflight.get(key); }

  // Latest headlines, cached for 3 minutes. Sources that fail are skipped and named in `errors`.
  async latest(symbol = 'NIFTY') {
    const hit = this.live.get(symbol);
    if (hit && Date.now() - hit.at < 180e3) return hit.data;
    return this.once('live|' + symbol, async () => {
      const jobs = [['Google News', gnews(`${topic(symbol)} when:2d`)], ...FEEDS];
      const errors = [], all = [];
      await Promise.all(jobs.map(async ([name, url]) => { try { all.push(...parseRss(await this.fetcher(url), name === 'Google News' ? '' : name)); } catch (e) { errors.push(`${name}: ${e.message}`); } }));
      if (!all.length && hit) return hit.data;
      if (!all.length) throw new Error(`No news source answered (${errors.join('; ')})`);
      const cutoff = Date.now() - 3 * 864e5;
      const items = enrich(all.filter((i) => i.t >= cutoff && i.t <= Date.now() + 36e5));
      const data = { items, mood: mood(items), at: Date.now(), errors };
      this.live.set(symbol, { at: Date.now(), data });
      return data;
    });
  }

  // Headlines from the days before a past date, plus that day's ones timed before its close. Never later.
  // Google gives many older stories a date only (stamped 08:00 GMT); one dated the replay day may have come out after
  // the close, so those wait for the next replay day. Cached on disk: the past does not change.
  // at: the replay time (a minute during the day in minute-by-minute replay); defaults to the close.
  async asOf(date, symbol = 'NIFTY', at = closeTime(date)) {
    const key = `${symbol}|${date}`, close = closeTime(date), dayStart = Date.parse(date + 'T00:00:00+05:30');
    const known = (i) => i.t <= Math.min(at, close) && !(i.t >= dayStart && i.t % 864e5 === 8 * 36e5);
    let raw = this.disk[key];
    if (!raw) {
      raw = await this.once(key, async () => {
        const q = `${TOPIC[symbol] || TOPIC.NIFTY} after:${addDays(date, -4)} before:${addDays(date, 1)}`;
        const items = parseRss(await this.fetcher(gnews(q)));
        const kept = items.filter((i) => i.t <= close).map(({ title, source, link, t }) => ({ title, source, link, t }));
        this.disk[key] = kept; this.save();
        return kept;
      });
    }
    // Checked again on the way out, so a bad cache entry can never show a later headline.
    const items = enrich(raw.filter(known));
    return { items, mood: mood(items, Math.min(at, close), 24), at: Math.min(at, close), errors: [] };
  }

  save() {
    if (!this.cacheFile) return;
    const keys = Object.keys(this.disk); if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete this.disk[k];
    try { const tmp = this.cacheFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.disk)); fs.renameSync(tmp, this.cacheFile); } catch {}
  }
}
