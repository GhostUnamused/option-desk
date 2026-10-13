// Downloads NSE daily archives for a date range into the replay store, in the background, a few days at a time.
// Per trading day: the F&O bhavcopy (index options only are kept) and the all-indices close file
// (NIFTY 50, NIFTY BANK, India VIX OHLC). A weekday with neither file is recorded as a holiday. Weekends are
// probed with one request each, because NSE sometimes trades on them (budget days, Diwali muhurat, drills).
import { REPLAY } from '../config.js';
import { foUrls, indexUrl, unzipFirst, parseFo, parseIndexClose } from './bhavcopy.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const WORKERS = 3;
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every date in [from, to], never after today.
export function candidateDates(from, to) {
  const out = []; const last = to < istToday() ? to : istToday();
  for (let t = Date.parse(from); t <= Date.parse(last); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const isWeekend = (date) => { const wd = new Date(date + 'T00:00:00Z').getUTCDay(); return wd === 0 || wd === 6; };

// GET with retries for network errors, throttling and server errors. Resolves null on 404.
async function fetchBuf(url, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
      if (r.status === 404) return null;
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (attempt >= 3 || (r.status < 500 && r.status !== 403 && r.status !== 429)) throw new Error(`NSE answered ${r.status}`);
    } catch (e) {
      if (signal.aborted) throw new Error('Cancelled');
      if (attempt >= 3) throw new Error(e.message.startsWith('NSE') ? e.message : `Network error: ${e.cause?.code || e.message}`);
    }
    await sleep(1500 * 2 ** attempt);
  }
}

export class Downloader {
  constructor(store) { this.store = store; this.job = null; }

  status() {
    const j = this.job; if (!j) return null;
    return { running: j.running, from: j.from, to: j.to, total: j.total, done: j.done, saved: j.saved, holidays: j.holidays, failed: j.failed, notYet: j.notYet, current: j.current, error: j.error, cancelled: j.cancelled, startedAt: j.startedAt, finishedAt: j.finishedAt };
  }

  start(from, to, { retryHolidays = false } = {}) {
    if (this.job?.running) throw new Error('A download is already running.');
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(from) || !iso.test(to) || from > to) throw new Error('Pick a start date on or before the end date.');
    if (from < REPLAY.earliest) throw new Error(`History is available from ${REPLAY.earliest}.`);
    const dates = candidateDates(from, to).filter((d) => { const s = this.store.dayStatus(d); return !s || s === 'error' || (retryHolidays && s === 'holiday'); });
    const ctl = new AbortController();
    this.job = { running: true, from, to, total: dates.length, done: 0, saved: 0, holidays: 0, weekends: 0, failed: 0, notYet: 0, current: null, error: null, cancelled: false, startedAt: Date.now(), finishedAt: null, ctl, queue: dates.slice() };
    this.run(this.job);
    return this.status();
  }

  cancel() { if (this.job?.running) { this.job.cancelled = true; this.job.ctl.abort(); } return this.status(); }

  async run(job) {
    const worker = async () => {
      while (job.queue.length && !job.cancelled) {
        const date = job.queue.shift(); job.current = date;
        try { job[await this.fetchDay(date, job.ctl.signal)]++; }
        catch (e) {
          if (job.cancelled) break;
          job.failed++; job.error = `${date}: ${e.message}`;
          this.store.markDay(date, 'error', e.message);
          if (job.failed >= 8 && job.saved === 0) { job.error = `Stopped: NSE's archive is not answering (${e.message}). Check your internet connection and try again.`; job.cancelled = true; }
        }
        job.done++;
        await sleep(150);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    job.running = false; job.current = null; job.finishedAt = Date.now();
  }

  // Fetch, parse and store one date. Returns which counter it adds to.
  async fetchDay(date, signal) {
    let zip = null;
    if (isWeekend(date)) { zip = await fetchBuf(foUrls(date)[0], signal); if (!zip) { this.store.markDay(date, 'holiday', 'weekend'); return 'weekends'; } }
    else for (const url of foUrls(date)) { zip = await fetchBuf(url, signal); if (zip) break; }
    const idxBuf = await fetchBuf(indexUrl(date), signal);
    if (!zip) {
      if (date >= istToday()) return 'notYet'; // published in the evening
      if (idxBuf) throw new Error('Index closes found but no F&O bhavcopy');
      this.store.markDay(date, 'holiday');
      return 'holidays';
    }
    const fo = parseFo(unzipFirst(zip).toString('utf8'), date);
    const indices = idxBuf ? parseIndexClose(idxBuf.toString('utf8')) : {};
    for (const s of REPLAY.symbols) {
      if (!indices[s] && fo.underlying[s]) { const c = fo.underlying[s]; indices[s] = { open: c, high: c, low: c, close: c }; }
      if (!indices[s] && fo.options.some((o) => o.symbol === s)) throw new Error(`No ${s} index close for this day`);
    }
    if (!fo.options.length) throw new Error('No index options in the bhavcopy');
    this.store.saveDay(date, { format: fo.format, options: fo.options, indices });
    return 'saved';
  }
}
