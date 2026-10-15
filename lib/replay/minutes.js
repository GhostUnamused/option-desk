// Downloads one-minute history from INDstocks into the replay store, in the background, for minute-by-minute replay:
// index bars (NIFTY 50, NIFTY BANK, India VIX) and, for each expired NIFTY / BANK NIFTY expiry, the bars of the strikes
// around where the index traded in the days before that expiry (REPLAY.intraday sets how many days and strikes).
// INDstocks keeps index minutes from 19 Mar 2024 and expired contracts from the 3 Apr 2025 expiry; contracts that have
// not expired yet are not in its expired-contract history. Calls go through the provider's rate-limited raw().
import { REPLAY } from '../config.js';
import { TokenError } from '../indstocks.js';

const DAY = 864e5, WEEK = 7 * DAY;
const startOf = (date) => Date.parse(date + 'T00:00:00+05:30');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(date) + n * DAY);
const istToday = () => new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
export const NO_SOURCE = 'Minute prices come from INDstocks. Switch to live prices, connect INDstocks with the Data button (paste your access token), then switch back to replay and download.';

export class MinuteDownloader {
  // client: () => an IndstocksProvider with a token, or null. daily: the bhavcopy Downloader, started for the same dates.
  constructor(store, client, daily = null) { this.store = store; this.client = client; this.daily = daily; this.job = null; }

  source() { const c = this.client(); return { connected: Boolean(c?.usable()), problem: c?.usable() ? null : c?.problem?.message || NO_SOURCE }; }

  status() {
    const j = this.job; if (!j) return null;
    return { running: j.running, from: j.from, to: j.to, total: j.total, done: j.done, bars: j.bars, failed: j.failed, current: j.current, error: j.error, notes: j.notes, cancelled: j.cancelled, startedAt: j.startedAt, finishedAt: j.finishedAt };
  }

  start(from, to, symbols = REPLAY.symbols) {
    if (this.job?.running) throw new Error('A minute download is already running.');
    const isIso = /^\d{4}-\d{2}-\d{2}$/;
    if (!isIso.test(from) || !isIso.test(to) || from > to) throw new Error('Pick a start date on or before the end date.');
    const { indexFrom } = REPLAY.intraday;
    if (to < indexFrom) throw new Error(`Minute prices start on ${indexFrom}.`);
    if (from < indexFrom) from = indexFrom;
    if (to > istToday()) to = istToday();
    const c = this.client();
    if (!c?.usable()) throw new Error(c?.problem?.message || NO_SOURCE);
    symbols = [...new Set(symbols)].filter((s) => REPLAY.symbols.includes(s));
    if (!symbols.length) throw new Error('Choose at least one index.');
    // Replay also needs each day's closing prices (open interest, the trading calendar): fetch those too.
    try { if (!this.daily?.job?.running) this.daily?.start(from, to, { symbols }); } catch {}
    this.job = { running: true, from, to, symbols, total: 0, done: 0, bars: 0, failed: 0, current: null, error: null, notes: [], cancelled: false, startedAt: Date.now(), finishedAt: null };
    this.run(this.job, c, symbols).catch((e) => { this.job.error = e.message; }).finally(() => { this.job.running = false; this.job.current = null; this.job.finishedAt = Date.now(); });
    return this.status();
  }

  cancel() { if (this.job?.running) this.job.cancelled = true; return this.status(); }

  async run(job, c, symbols = REPLAY.symbols) {
    const { from, to } = job;
    const indexSymbols = [...symbols, 'INDIAVIX'];
    const windows = [];
    for (let t = startOf(from); t < startOf(to) + DAY; t += WEEK) windows.push([t, Math.min(t + WEEK, startOf(to) + DAY)]);
    // List the expiries first, so the progress bar knows the whole job.
    const expiries = [];
    for (const sym of symbols) {
      job.current = `Listing ${sym} expiries`;
      for (const e of await this.expiries(c, sym, from, to)) expiries.push([sym, e]);
    }
    job.total = indexSymbols.length * windows.length + expiries.length;
    if (to >= REPLAY.intraday.optionsFrom && !expiries.length) job.notes.push('No expired option contracts in these dates yet: INDstocks only has contracts after they expire.');
    else if (to < REPLAY.intraday.optionsFrom) job.notes.push(`Option minute prices start with the ${REPLAY.intraday.optionsFrom} expiry; before that only the index has minute prices.`);

    for (const sym of indexSymbols) {
      const code = await c.indexCode(sym);
      for (const [a, b] of windows) {
        if (job.cancelled) return;
        job.current = `${sym} index, week of ${iso(a + 19800e3)}`;
        if (!this.haveIndexWeek(sym, a, b)) {
          await this.guard(job, async () => {
            const j = await c.raw(`/market/historical/1minute?scrip-codes=${code}&start_time=${a}&end_time=${b}`);
            const bars = j.data?.[code]?.candles || [];
            this.store.saveIndexMinutes(sym, bars); job.bars += bars.length;
          });
        }
        job.done++;
      }
      this.store.countMinutes(sym, from, to);
    }
    for (const [sym, expiry] of expiries) {
      if (job.cancelled) return;
      job.current = `${sym} options expiring ${expiry}`;
      await this.guard(job, () => this.expiry(job, c, sym, expiry));
      job.done++;
    }
  }

  // Run one piece; an expired token stops the job, anything else is counted and skipped.
  async guard(job, fn) {
    try { await fn(); }
    catch (e) {
      if (e instanceof TokenError) { job.cancelled = true; throw e; }
      job.failed++; job.error = `${job.current}: ${e.message}`;
    }
  }

  // The week's index bars are already stored (and the week is over).
  haveIndexWeek(sym, a, b) {
    if (b > Date.now() - DAY) return false;
    const days = this.store.all("SELECT d.date, coalesce(m.index_bars, 0) n FROM days d LEFT JOIN minute_days m ON m.date = d.date AND m.symbol = ? WHERE d.status = 'trading' AND d.date >= ? AND d.date < ?", sym, iso(a + 19800e3), iso(b + 19800e3));
    return days.length > 0 && days.every((d) => d.n > 0);
  }

  // Expired expiries of a symbol whose download window [expiry − daysBefore, expiry] overlaps [from, to].
  async expiries(c, sym, from, to) {
    const before = REPLAY.intraday.daysBefore[sym] ?? 7;
    const lo = from > REPLAY.intraday.optionsFrom ? from : REPLAY.intraday.optionsFrom;
    const hi = addDays(to, before) < istToday() ? addDays(to, before) : istToday();
    const out = new Set();
    for (let a = lo; a <= hi; a = addDays(a, 360)) {
      const b = addDays(a, 359) < hi ? addDays(a, 359) : hi;
      const j = await c.raw(`/market/instruments/expired/expiries?underlying=${encodeURIComponent(sym)}&segment=DERIVATIVE&expiry_from=${a}&expiry_to=${b}`);
      for (const e of j.data || []) if (e >= lo && addDays(e, -before) <= to && e >= from) out.add(e);
    }
    return [...out].sort();
  }

  async expiry(job, c, sym, expiry) {
    const before = REPLAY.intraday.daysBefore[sym] ?? 7;
    const wFrom = addDays(expiry, -before) > job.from ? addDays(expiry, -before) : job.from;
    const wTo = expiry < job.to ? expiry : job.to;
    const had = this.store.expiryFetched(sym, expiry);
    if (had && had.f <= wFrom && had.t >= wTo) return;
    // Where the index traded over those days, from its minute bars (else the daily highs and lows).
    const a = startOf(wFrom), b = startOf(wTo) + DAY;
    let r = this.store.get('SELECT min(l) lo, max(h) hi FROM minute_index WHERE symbol = ? AND ts >= ? AND ts < ?', sym, a / 1000, b / 1000);
    if (r?.lo == null) r = this.store.get('SELECT min(low) lo, max(high) hi FROM indices WHERE symbol = ? AND date >= ? AND date <= ?', sym, wFrom, wTo);
    if (r?.lo == null) { job.notes.push(`${sym} ${expiry}: no index prices for those days, skipped.`); return; }
    const j = await c.raw(`/market/instruments/expired/contracts?underlying=${encodeURIComponent(sym)}&segment=DERIVATIVE&expiry=${expiry}`);
    const all = (j.data || []).filter((x) => x.option_type === 'CE' || x.option_type === 'PE');
    const pick = pickStrikes(all.map((x) => Number(x.strike_price)), r.lo, r.hi, REPLAY.intraday.strikesEachSide);
    const keep = all.filter((x) => pick.has(Number(x.strike_price)));
    // lot_size here is not reliable (checked Oct 2026): replay takes lots from the bhavcopy instead.
    const ids = new Map(keep.map((x) => [x.trading_symbol, this.store.contractId(sym, expiry, Number(x.strike_price), x.option_type, null, x.trading_symbol)]));
    const names = [...ids.keys()];
    for (let i = 0; i < names.length; i += 50) {
      const batch = names.slice(i, i + 50);
      for (let t = a; t < b; t += WEEK) {
        if (job.cancelled) return;
        const k = await c.raw(`/market/historical/expired/1minute?trading-symbols=${batch.join(',')}&segment=NFO&start_time=${t}&end_time=${Math.min(t + WEEK, b)}`);
        for (const name of batch) { const bars = k.data?.[name]?.candles || []; this.store.saveOptionMinutes(ids.get(name), bars); job.bars += bars.length; }
      }
    }
    this.store.markExpiry(sym, expiry, had && had.f < wFrom ? had.f : wFrom, had && had.t > wTo ? had.t : wTo, names.length);
    this.store.countMinutes(sym, wFrom, wTo);
  }
}

// Strikes from `each` steps below the low to `each` steps above the high, where a step is the gap between strikes
// near the money (NIFTY 50, BANK NIFTY 100; far strikes are often spaced wider).
export function pickStrikes(strikes, lo, hi, each) {
  const k = [...new Set(strikes)].sort((x, y) => x - y), mid = (lo + hi) / 2;
  const near = k.filter((x) => Math.abs(x / mid - 1) < 0.03);
  let step = Infinity;
  for (let i = 1; i < near.length; i++) step = Math.min(step, near[i] - near[i - 1]);
  if (!Number.isFinite(step)) step = mid > 30000 ? 100 : 50;
  return new Set(k.filter((x) => x >= lo - each * step && x <= hi + each * step));
}
