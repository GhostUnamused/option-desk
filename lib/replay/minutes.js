// Downloads one-minute history from a broker into the replay store, in the background, for minute-by-minute replay:
// index bars (NIFTY 50, NIFTY BANK, India VIX) and, for each expired NIFTY / BANK NIFTY expiry, the bars of the strikes
// around where the index traded in the days before that expiry (REPLAY.intraday sets how many days and strikes).
// Any broker that sells expired-contract history can be the source (see "Minute-history sources" below): INDstocks
// (index minutes from 19 Mar 2024, expired contracts from the 3 Apr 2025 expiry) and Upstox with its Plus plan (the
// last six months of expiries). Contracts that have not expired yet are in neither; recorder.js fills those days.
import { REPLAY } from '../config.js';
import { TokenError } from '../indstocks.js';

const DAY = 864e5, WEEK = 7 * DAY;
const startOf = (date) => Date.parse(date + 'T00:00:00+05:30');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(date) + n * DAY);
const istToday = () => new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
export const NO_SOURCE = 'Downloading past minute prices needs a broker that sells expired-contract history: INDstocks, or Upstox with its Plus plan. Connect one with the Data button in live mode, then switch back to replay. Without one, keep the app open in live mode during market hours and it records minute prices for replay as it goes.';

// ---- Minute-history sources ----
// What the downloader needs from a broker. A provider offers one through minuteHistory(); INDstocks' is built here
// from its raw() calls. Bar times (ts) are true epoch seconds, prices in rupees, option volume in units.
//   { name, indexFrom, optionsFrom, batch, window,
//     indexBars(symbol, fromMs, toMs) → [{ ts, o, h, l, c }],
//     expiries(symbol, from, to) → expired expiry dates (YYYY-MM-DD) in [from, to],
//     contracts(symbol, expiry) → [{ name, strike, type }],
//     optionBars(names, expiry, fromMs, toMs) → { [name]: [{ ts, c, v }] } (at most `batch` names over `window` ms) }
export function indstocksHistory(c) {
  return {
    name: 'INDstocks', indexFrom: REPLAY.intraday.indexFrom, optionsFrom: REPLAY.intraday.optionsFrom, batch: 50, window: WEEK,
    async indexBars(sym, a, b) {
      const code = await c.indexCode(sym);
      return (await c.raw(`/market/historical/1minute?scrip-codes=${code}&start_time=${a}&end_time=${b}`)).data?.[code]?.candles || [];
    },
    async expiries(sym, from, to) {
      const out = [];
      for (let a = from; a <= to; a = addDays(a, 360)) {
        const b = addDays(a, 359) < to ? addDays(a, 359) : to;
        out.push(...((await c.raw(`/market/instruments/expired/expiries?underlying=${encodeURIComponent(sym)}&segment=DERIVATIVE&expiry_from=${a}&expiry_to=${b}`)).data || []));
      }
      return out;
    },
    // lot_size here is not reliable (checked Oct 2026): replay takes lots from the bhavcopy instead.
    async contracts(sym, expiry) {
      const j = await c.raw(`/market/instruments/expired/contracts?underlying=${encodeURIComponent(sym)}&segment=DERIVATIVE&expiry=${expiry}`);
      return (j.data || []).filter((x) => x.option_type === 'CE' || x.option_type === 'PE').map((x) => ({ name: x.trading_symbol, strike: Number(x.strike_price), type: x.option_type }));
    },
    async optionBars(names, expiry, a, b) {
      const k = await c.raw(`/market/historical/expired/1minute?trading-symbols=${names.join(',')}&segment=NFO&start_time=${a}&end_time=${b}`);
      return Object.fromEntries(names.map((n) => [n, k.data?.[n]?.candles || []]));
    },
  };
}
const historyOf = (c) => (typeof c?.minuteHistory === 'function' ? c.minuteHistory() : c ? indstocksHistory(c) : null);

export class MinuteDownloader {
  // client: () => a connected provider with minute history (or null). daily: the bhavcopy Downloader, run for the same dates.
  constructor(store, client, daily = null) { this.store = store; this.client = client; this.daily = daily; this.job = null; }

  source() {
    const c = this.client(), h = c?.usable() ? historyOf(c) : null;
    return { connected: Boolean(h), name: h?.name || null, problem: h ? null : c?.problem?.message || NO_SOURCE,
      indexFrom: h?.indexFrom || REPLAY.intraday.indexFrom, optionsFrom: h?.optionsFrom || REPLAY.intraday.optionsFrom };
  }

  status() {
    const j = this.job; if (!j) return null;
    return { running: j.running, from: j.from, to: j.to, total: j.total, done: j.done, bars: j.bars, failed: j.failed, current: j.current, error: j.error, notes: j.notes, cancelled: j.cancelled, startedAt: j.startedAt, finishedAt: j.finishedAt, source: j.source };
  }

  start(from, to, symbols = REPLAY.symbols) {
    if (this.job?.running) throw new Error('A minute download is already running.');
    const isIso = /^\d{4}-\d{2}-\d{2}$/;
    if (!isIso.test(from) || !isIso.test(to) || from > to) throw new Error('Pick a start date on or before the end date.');
    const c = this.client(), h = c?.usable() ? historyOf(c) : null;
    if (!h) throw new Error(c?.problem?.message || NO_SOURCE);
    if (to < h.indexFrom) throw new Error(`${h.name} minute prices start on ${h.indexFrom}.`);
    if (from < h.indexFrom) from = h.indexFrom;
    if (to > istToday()) to = istToday();
    symbols = [...new Set(symbols)].filter((s) => REPLAY.symbols.includes(s));
    if (!symbols.length) throw new Error('Choose at least one index.');
    // Replay also needs each day's closing prices (open interest, the trading calendar): fetch those too.
    try { if (!this.daily?.job?.running) this.daily?.start(from, to, { symbols }); } catch {}
    this.job = { running: true, from, to, symbols, total: 0, done: 0, bars: 0, failed: 0, current: null, error: null, notes: [], cancelled: false, startedAt: Date.now(), finishedAt: null, source: h.name };
    this.run(this.job, h, symbols).catch((e) => { this.job.error = e.message; }).finally(() => { this.job.running = false; this.job.current = null; this.job.finishedAt = Date.now(); });
    return this.status();
  }

  cancel() { if (this.job?.running) this.job.cancelled = true; return this.status(); }

  async run(job, h, symbols = REPLAY.symbols) {
    const { from, to } = job;
    const indexSymbols = [...symbols, 'INDIAVIX'];
    const windows = [];
    for (let t = startOf(from); t < startOf(to) + DAY; t += WEEK) windows.push([t, Math.min(t + WEEK, startOf(to) + DAY)]);
    // List the expiries first, so the progress bar knows the whole job.
    const expiries = [];
    for (const sym of symbols) {
      job.current = `Listing ${sym} expiries`;
      for (const e of await this.expiries(h, sym, from, to)) expiries.push([sym, e]);
    }
    job.total = indexSymbols.length * windows.length + expiries.length;
    if (to >= h.optionsFrom && !expiries.length) job.notes.push(`No expired option contracts in these dates yet: ${h.name} only has contracts after they expire. Days the app recorded in live mode fill the rest.`);
    else if (to < h.optionsFrom) job.notes.push(`${h.name} option minute prices start with the ${h.optionsFrom} expiry; before that only the index has minute prices.`);

    for (const sym of indexSymbols) {
      for (const [a, b] of windows) {
        if (job.cancelled) return;
        job.current = `${sym} index, week of ${iso(a + 19800e3)}`;
        if (!this.haveIndexWeek(sym, a, b)) {
          await this.guard(job, async () => {
            const bars = await h.indexBars(sym, a, b);
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
      await this.guard(job, () => this.expiry(job, h, sym, expiry));
      job.done++;
    }
  }

  // Run one piece; an expired token (or a plan without this history) stops the job, anything else is counted and skipped.
  async guard(job, fn) {
    try { await fn(); }
    catch (e) {
      if (e instanceof TokenError || e.auth) { job.cancelled = true; throw e; }
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
  async expiries(h, sym, from, to) {
    const before = REPLAY.intraday.daysBefore[sym] ?? 7;
    const lo = from > h.optionsFrom ? from : h.optionsFrom;
    const hi = addDays(to, before) < istToday() ? addDays(to, before) : istToday();
    if (lo > hi) return [];
    const out = new Set();
    for (const e of await h.expiries(sym, lo, hi)) if (e >= lo && e <= hi && addDays(e, -before) <= to && e >= from) out.add(e);
    return [...out].sort();
  }

  async expiry(job, h, sym, expiry) {
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
    const all = await h.contracts(sym, expiry);
    const pick = pickStrikes(all.map((x) => x.strike), r.lo, r.hi, REPLAY.intraday.strikesEachSide);
    const ids = new Map(all.filter((x) => pick.has(x.strike)).map((x) => [x.name, this.store.contractId(sym, expiry, x.strike, x.type, null, x.name)]));
    const names = [...ids.keys()], size = h.batch || 1, span = h.window || WEEK;
    for (let i = 0; i < names.length; i += size) {
      const batch = names.slice(i, i + size);
      for (let t = a; t < b; t += span) {
        if (job.cancelled) return;
        if (size < names.length) job.current = `${sym} options expiring ${expiry} (${Math.min(i + size, names.length)} of ${names.length} contracts)`;
        const got = await h.optionBars(batch, expiry, t, Math.min(t + span, b));
        for (const name of batch) { const bars = got[name] || []; this.store.saveOptionMinutes(ids.get(name), bars); job.bars += bars.length; }
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
