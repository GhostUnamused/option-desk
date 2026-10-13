// The as-of gate. In replay mode every read of market data goes through getSnapshot(asOf): the snapshot only
// queries rows dated on or before asOf, and checks every row it returns, so a replay can never see the future.
// A backtester uses the same function: for each day, take getSnapshot(day) and decide from that alone.
import { bs, impliedVol, yearsTo } from '../../public/js/bs.js';
import { lotOn } from '../config.js';

// Market close on a date, as epoch ms. Replay "now" is always a close: that is when bhavcopy prices are struck.
export const closeTime = (date) => Date.parse(date + 'T15:30:00+05:30');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export class AsOfViolation extends Error {}

export function getSnapshot(store, asOf, opts = {}) {
  if (!isDate(asOf)) throw new Error(`getSnapshot needs a YYYY-MM-DD date, got ${asOf}`);
  return new Snapshot(store, asOf, opts);
}

class Snapshot {
  constructor(store, asOf, { riskFree = 0.06 } = {}) {
    this.store = store; this.date = asOf; this.riskFree = riskFree; this.now = closeTime(asOf);
    this.memo = new Map();
  }

  // Every query passes through here. Each SQL statement filters on date <= asOf itself, and each returned row
  // carries its date so the gate can check it. A row from after asOf is a bug, so it throws instead of filtering.
  rows(sql, ...params) {
    if (!/\bdate\s*(<=|=|<)\s*\?/.test(sql)) throw new AsOfViolation('Snapshot query without a date bound');
    const out = this.store.all(sql, ...params);
    for (const r of out) if (!isDate(r.date) || r.date > this.date) throw new AsOfViolation(`Row dated ${r.date} leaked into the ${this.date} snapshot`);
    return out;
  }
  once(key, fn) { if (!this.memo.has(key)) this.memo.set(key, fn()); return this.memo.get(key); }

  // ---- Index levels ----
  index(symbol) {
    return this.once(`i|${symbol}`, () => this.rows('SELECT date, open, high, low, close FROM indices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 2', symbol, this.date));
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
    return this.rows('SELECT date, open, high, low, close FROM indices WHERE symbol = ? AND date >= ? AND date <= ? ORDER BY date', symbol, from, this.date);
  }

  // ---- Options ----
  previousDay() {
    return this.once('prev', () => this.rows('SELECT date FROM options WHERE date < ? ORDER BY date DESC LIMIT 1', this.date)[0]?.date || null);
  }
  // Contracts listed on asOf that expire after it (contracts expiring today have settled by the close).
  expiries(symbol) {
    return this.once(`e|${symbol}`, () => this.rows('SELECT expiry, max(date) date FROM options WHERE symbol = ? AND date = ? AND expiry > ? GROUP BY expiry ORDER BY expiry', symbol, this.date, this.date).map((r) => r.expiry));
  }
  // Every strike of one expiry on asOf, with implied volatility and Greeks backed out of each option's price.
  chain(symbol, expiry) {
    return this.once(`c|${symbol}|${expiry}`, () => {
      const today = this.rows('SELECT date, strike, type, open, high, low, close, settle, volume, oi, chg_oi, lot FROM options WHERE symbol = ? AND expiry = ? AND date = ? ORDER BY strike', symbol, expiry, this.date);
      const prevDay = this.previousDay();
      const prev = new Map(prevDay ? this.rows('SELECT date, strike, type, close, settle, volume FROM options WHERE symbol = ? AND expiry = ? AND date = ?', symbol, expiry, prevDay).map((r) => [`${r.strike}|${r.type}`, priceOf(r)]) : []);
      const spot = this.spot(symbol);
      return today.map((r) => this.enrich(symbol, expiry, r, spot, prev.get(`${r.strike}|${r.type}`)));
    });
  }
  contract(symbol, expiry, strike, type) {
    return this.chain(symbol, expiry).find((r) => r.strike === Number(strike) && r.type === type) || null;
  }
  // One contract's daily prices up to asOf, oldest first.
  contractHistory(symbol, expiry, strike, type, days = 120) {
    const from = new Date(this.now - days * 864e5).toISOString().slice(0, 10);
    return this.rows('SELECT date, close, settle, volume, oi FROM options WHERE symbol = ? AND expiry = ? AND strike = ? AND type = ? AND date >= ? AND date <= ? ORDER BY date', symbol, expiry, Number(strike), type, from, this.date)
      .map((r) => ({ date: r.date, price: priceOf(r), volume: r.volume, oi: r.oi }));
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
