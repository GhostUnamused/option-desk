// The as-of gate. In replay mode every read of market data goes through getSnapshot(asOf): the snapshot only
// queries rows dated on or before asOf, and checks every row it returns, so a replay can never see the future.
// A backtester uses the same function: for each day, take getSnapshot(day) and decide from that alone.
// With opts.at (epoch ms during the day) the snapshot is as of that minute: today's end-of-day rows (bhavcopy, index
// close) stay hidden until 15:30, and today is built from the one-minute bars that had finished by then.
import { bs, impliedVol, yearsTo } from '../../public/js/bs.js';
import { lotOn } from '../config.js';

// Market close on a date, as epoch ms. Replay "now" is always a close: that is when bhavcopy prices are struck.
export const closeTime = (date) => Date.parse(date + 'T15:30:00+05:30');
export const dayStart = (date) => Date.parse(date + 'T00:00:00+05:30');
// Replay clock time for a minute of the day (minutes after midnight IST).
export const minuteTime = (date, minute) => dayStart(date) + minute * 60e3;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const hhmm = (ms) => new Date(ms + 19800e3).toISOString().slice(11, 16);

export class AsOfViolation extends Error {}

export function getSnapshot(store, asOf, opts = {}) {
  if (!isDate(asOf)) throw new Error(`getSnapshot needs a YYYY-MM-DD date, got ${asOf}`);
  if (opts.at != null && !(opts.at >= dayStart(asOf) && opts.at <= closeTime(asOf))) throw new Error(`getSnapshot: ${opts.at} is not a time during ${asOf}'s session`);
  return new Snapshot(store, asOf, opts);
}

class Snapshot {
  constructor(store, asOf, { riskFree = 0.06, at = null } = {}) {
    this.store = store; this.date = asOf; this.riskFree = riskFree; this.now = at ?? closeTime(asOf);
    // Before the close the day is still running, and its end-of-day rows are the future.
    this.live = this.now < closeTime(asOf);
    this.dayFrom = dayStart(asOf) / 1000;
    this.barLimit = Math.floor(this.now / 1000) - 60; // a bar starting at ts has finished at ts + 60
    this.memo = new Map();
  }
  get time() { return hhmm(this.now); }

  // Every query passes through here. Each SQL statement bounds itself (date <= asOf for daily rows, ts <= the last
  // finished bar for minute rows), and each returned row carries its date or bar time so the gate can check it.
  // A row from the future is a bug, so it throws instead of filtering.
  rows(sql, ...params) {
    if (!/\bdate\s*(<=|=|<)\s*\?/.test(sql) && !/\bts\s*<=\s*\?/.test(sql)) throw new AsOfViolation('Snapshot query without a date bound');
    const out = this.store.all(sql, ...params);
    for (const r of out) {
      if ('ts' in r) { if (!Number.isInteger(r.ts) || r.ts > this.barLimit) throw new AsOfViolation(`Bar at ${hhmm(r.ts * 1000)} leaked into the ${this.date} ${this.time} snapshot`); }
      else if (!isDate(r.date) || r.date > this.date || (this.live && r.date === this.date)) throw new AsOfViolation(`Row dated ${r.date} leaked into the ${this.date} ${this.live ? this.time + ' ' : ''}snapshot`);
    }
    return out;
  }
  once(key, fn) { if (!this.memo.has(key)) this.memo.set(key, fn()); return this.memo.get(key); }

  // ---- Index levels ----
  index(symbol) {
    return this.once(`i|${symbol}`, () => {
      if (!this.live) return this.rows('SELECT date, open, high, low, close FROM indices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 2', symbol, this.date);
      const prev = this.rows('SELECT date, open, high, low, close FROM indices WHERE symbol = ? AND date < ? ORDER BY date DESC LIMIT 1', symbol, this.date);
      const today = this.todayBar(symbol);
      return today ? [today, ...prev] : prev;
    });
  }
  // Today's OHLC so far, from the finished minute bars.
  todayBar(symbol) {
    const b = this.indexMinutes(symbol); if (!b.length) return null;
    return { date: this.date, open: b[0].o, high: Math.max(...b.map((x) => x.h)), low: Math.min(...b.map((x) => x.l)), close: b[b.length - 1].c };
  }
  // Today's one-minute index bars up to the snapshot time, oldest first: { ts, o, h, l, c } with ts in epoch seconds.
  indexMinutes(symbol) {
    return this.once(`im|${symbol}`, () => this.rows('SELECT ts, o, h, l, c FROM minute_index WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts', symbol, this.dayFrom, this.barLimit));
  }
  // Today's OHLC plus the previous close; null if this index has no data on or before asOf.
  quote(symbol) {
    const [today, prev] = this.index(symbol);
    return today ? { ...today, prevClose: prev?.close ?? today.open, stale: today.date !== this.date } : null;
  }
  spot(symbol) { return this.quote(symbol)?.close ?? null; }
  // Daily rows for roughly the last `days` calendar days, oldest first.
  indexHistory(symbol, days = 365) {
    const from = new Date(this.now - days * 864e5).toISOString().slice(0, 10);
    if (!this.live) return this.rows('SELECT date, open, high, low, close FROM indices WHERE symbol = ? AND date >= ? AND date <= ? ORDER BY date', symbol, from, this.date);
    const today = this.todayBar(symbol);
    return [...this.rows('SELECT date, open, high, low, close FROM indices WHERE symbol = ? AND date >= ? AND date < ? ORDER BY date', symbol, from, this.date), ...(today ? [today] : [])];
  }

  // ---- Options ----
  previousDay() {
    return this.once('prev', () => this.rows('SELECT date FROM options WHERE date < ? ORDER BY date DESC LIMIT 1', this.date)[0]?.date || null);
  }
  // Contracts listed on asOf that expire after it (contracts expiring today have settled by the close).
  // While the day runs: the expiries with minute prices today, including one expiring today (it trades until 15:30).
  expiries(symbol) {
    if (this.live) return this.once(`e|${symbol}`, () => this.rows('SELECT k.expiry, max(o.ts) ts FROM minute_contracts k JOIN minute_options o ON o.cid = k.id WHERE k.symbol = ? AND k.expiry >= ? AND o.ts >= ? AND o.ts <= ? GROUP BY k.expiry ORDER BY k.expiry', symbol, this.date, this.dayFrom, this.barLimit).map((r) => r.expiry));
    return this.once(`e|${symbol}`, () => this.rows('SELECT expiry, max(date) date FROM options WHERE symbol = ? AND date = ? AND expiry > ? GROUP BY expiry ORDER BY expiry', symbol, this.date, this.date).map((r) => r.expiry));
  }
  // Every strike of one expiry on asOf, with implied volatility and Greeks backed out of each option's price.
  // Every expiry listed for trading (for labels such as weekly / monthly): while the day runs, the previous day's
  // listings still open today plus today's minute-priced ones; at the close, the same as expiries().
  listedExpiries(symbol) {
    if (!this.live) return this.expiries(symbol);
    return this.once(`le|${symbol}`, () => {
      const prevDay = this.previousDay();
      const prev = prevDay ? this.rows('SELECT expiry, max(date) date FROM options WHERE symbol = ? AND date = ? AND expiry >= ? GROUP BY expiry', symbol, prevDay, this.date).map((r) => r.expiry) : [];
      return [...new Set([...prev, ...this.expiries(symbol)])].sort();
    });
  }
  chain(symbol, expiry) {
    if (this.live) return this.once(`c|${symbol}|${expiry}`, () => this.minuteChain(symbol, expiry));
    return this.once(`c|${symbol}|${expiry}`, () => {
      const today = this.rows('SELECT date, strike, type, open, high, low, close, settle, volume, oi, chg_oi, lot FROM options WHERE symbol = ? AND expiry = ? AND date = ? ORDER BY strike', symbol, expiry, this.date);
      const prevDay = this.previousDay();
      const prev = new Map(prevDay ? this.rows('SELECT date, strike, type, close, settle, volume FROM options WHERE symbol = ? AND expiry = ? AND date = ?', symbol, expiry, prevDay).map((r) => [`${r.strike}|${r.type}`, priceOf(r)]) : []);
      const spot = this.spot(symbol);
      return today.map((r) => this.enrich(symbol, expiry, r, spot, prev.get(`${r.strike}|${r.type}`)));
    });
  }
  // The chain at the snapshot minute: each contract's last trade at or before it, the day's volume so far, and
  // yesterday's open interest (minute bars carry no OI). Only strikes that have traded today are listed.
  minuteChain(symbol, expiry) {
    const bars = this.rows('SELECT k.strike, k.type, max(o.ts) ts, o.c, sum(o.v) v FROM minute_contracts k JOIN minute_options o ON o.cid = k.id WHERE k.symbol = ? AND k.expiry = ? AND o.ts >= ? AND o.ts <= ? GROUP BY k.id ORDER BY k.strike', symbol, expiry, this.dayFrom, this.barLimit);
    const prev = this.prevRows(symbol, expiry), lotOf = this.minuteLot(symbol, expiry, prev);
    const spot = this.spot(symbol);
    return bars.map((b) => {
      const p = prev.get(`${b.strike}|${b.type}`), lot = lotOf(b.strike, b.type), price = b.c / 100;
      const r = { date: this.date, strike: b.strike, type: b.type, open: null, high: null, low: null, close: price, settle: price, volume: Math.ceil(b.v / lot), oi: p?.oi ?? 0, chg_oi: 0, lot };
      return { ...this.enrich(symbol, expiry, r, spot, p ? priceOf(p) : null), at: b.ts };
    });
  }
  // The previous trading day's bhavcopy rows of an expiry, by strike|type.
  prevRows(symbol, expiry) {
    return this.once(`p|${symbol}|${expiry}`, () => {
      const prevDay = this.previousDay();
      return new Map(prevDay ? this.rows('SELECT date, strike, type, close, settle, volume, oi, lot FROM options WHERE symbol = ? AND expiry = ? AND date = ?', symbol, expiry, prevDay).map((r) => [`${r.strike}|${r.type}`, r]) : []);
    });
  }
  // A contract's lot: from the bhavcopy (lots differ by expiry while a revision phases in), else the lot table.
  // INDstocks' lot_size for expired contracts is not reliable, so it is not used.
  minuteLot(symbol, expiry, prev = this.prevRows(symbol, expiry)) {
    const any = [...prev.values()].find((r) => r.lot)?.lot || lotOn(symbol, this.date);
    return (strike, type) => prev.get(`${strike}|${type}`)?.lot || any;
  }
  // One contract's minute bars today up to the snapshot time: { ts, price, volume } (volume in contracts).
  contractMinutes(symbol, expiry, strike, type) {
    const lot = this.minuteLot(symbol, expiry)(Number(strike), type);
    return this.rows('SELECT o.ts, o.c, o.v FROM minute_contracts k JOIN minute_options o ON o.cid = k.id WHERE k.symbol = ? AND k.expiry = ? AND k.strike = ? AND k.type = ? AND o.ts >= ? AND o.ts <= ? ORDER BY o.ts', symbol, expiry, Number(strike), type, this.dayFrom, this.barLimit)
      .map((r) => ({ ts: r.ts, price: r.c / 100, volume: Math.ceil(r.v / lot) }));
  }
  contract(symbol, expiry, strike, type) {
    return this.chain(symbol, expiry).find((r) => r.strike === Number(strike) && r.type === type) || null;
  }
  // One contract's daily prices up to asOf, oldest first.
  contractHistory(symbol, expiry, strike, type, days = 120) {
    const from = new Date(this.now - days * 864e5).toISOString().slice(0, 10);
    const out = this.rows(`SELECT date, close, settle, volume, oi FROM options WHERE symbol = ? AND expiry = ? AND strike = ? AND type = ? AND date >= ? AND date ${this.live ? '<' : '<='} ? ORDER BY date`, symbol, expiry, Number(strike), type, from, this.date)
      .map((r) => ({ date: r.date, price: priceOf(r), volume: r.volume, oi: r.oi }));
    const now = this.live && this.contract(symbol, expiry, strike, type);
    if (now) out.push({ date: this.date, price: now.price, volume: now.volume, oi: now.oi });
    return out;
  }
  // Per trading day up to asOf: ATM implied vol of the nearest expiry at least 7 days out (shorter ones swing too
  // much to compare day to day), and the put–call OI ratio of the nearest expiry. Oldest first; iv as a fraction.
  optionHistory(symbol, days = 365) {
    return this.once(`oh|${symbol}|${days}`, () => {
      const from = new Date(this.now - days * 864e5).toISOString().slice(0, 10);
      const upto = this.live ? this.previousDay() || '0000-00-00' : this.date; // today's point comes at the close
      const spot = new Map(this.indexHistory(symbol, days).map((r) => [r.date, r.close]));
      const pcr = new Map(this.rows(`SELECT o.date, sum(CASE WHEN o.type = 'PE' THEN o.oi ELSE 0 END) pe, sum(CASE WHEN o.type = 'CE' THEN o.oi ELSE 0 END) ce
        FROM options o JOIN (SELECT date d, min(expiry) e FROM options WHERE symbol = ? AND date >= ? AND date <= ? AND expiry > date GROUP BY date) n ON n.d = o.date AND n.e = o.expiry
        WHERE o.symbol = ? AND o.date >= ? AND o.date <= ? GROUP BY o.date`, symbol, from, upto, symbol, from, upto).map((r) => [r.date, r.ce ? r.pe / r.ce : null]));
      const exps = this.rows('SELECT date, min(expiry) expiry FROM options WHERE symbol = ? AND date >= ? AND date <= ? AND julianday(expiry) - julianday(date) >= 7 GROUP BY date ORDER BY date', symbol, from, upto);
      return exps.map(({ date, expiry }) => {
        const S = spot.get(date); let iv = null;
        if (S) {
          const near = this.rows('SELECT date, strike, type, close, settle, volume FROM options WHERE symbol = ? AND expiry = ? AND date = ? ORDER BY abs(strike - ?) LIMIT 2', symbol, expiry, date, S);
          const T = yearsTo(expiry, closeTime(date));
          const ivs = near.filter((r) => r.strike === near[0].strike).map((r) => { const p = priceOf(r); return p > 0 ? impliedVol(r.type, S, r.strike, T, this.riskFree, p) : 0; }).filter((x) => x > 0);
          if (ivs.length) iv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
        }
        return { date, spot: S ?? null, expiry, iv, pcr: pcr.get(date) ?? null };
      });
    });
  }

  // Lot size for new trades in a contract on asOf.
  lot(symbol, expiry) {
    const rows = expiry ? this.chain(symbol, expiry) : [];
    return rows.find((r) => r.lot)?.lot || lotOn(symbol, this.date);
  }

  enrich(symbol, expiry, r, spot, prevPrice) {
    const price = priceOf(r);
    const T = yearsTo(expiry, this.now);
    const iv = spot && price > 0 ? impliedVol(r.type, spot, r.strike, T, this.riskFree, price) : 0;
    const g = iv > 0 ? bs(r.type, spot, r.strike, T, this.riskFree, iv) : null;
    return {
      date: r.date, symbol, expiry, strike: r.strike, type: r.type, price, close: r.close, settle: r.settle, traded: r.volume > 0,
      open: r.open, high: r.high, low: r.low, volume: r.volume, oi: r.oi, chgOi: r.chg_oi, lot: r.lot || lotOn(symbol, this.date),
      prevPrice: prevPrice ?? null, iv: iv > 0 ? iv : null,
      delta: g?.delta ?? null, gamma: g?.gamma ?? null, theta: g?.theta ?? null, vega: g?.vega ?? null,
    };
  }
}

// The day's price for an option: its close when it traded, otherwise NSE's settlement (theoretical) price,
// because the close of an untraded contract is just an old trade carried forward.
export const priceOf = (r) => (r.volume > 0 ? r.close : r.settle || r.close);
