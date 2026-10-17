// Replay market: the same provider interface as lib/nse.js, answered from stored NSE history as of the replay date
// (and, in a minute-by-minute session, the replay minute).
// Everything is read through the engine's current snapshot (getSnapshot), never from the store directly.
import { INDICES, VIX_NAME, REPLAY } from '../config.js';
import { quoteSides } from './fills.js';

const round2 = (x) => Math.round(x * 100) / 100;
const epochSec = (date) => Math.floor(Date.parse(date + 'T15:30:00+05:30') / 1000) + 19800; // IST wall clock as UTC, like NSE's charts

export class ReplayProvider {
  constructor(engine) { this.engine = engine; this.name = 'Replay'; }

  snap() { return this.engine.snapshot(); }

  async indices() {
    const s = this.snap();
    const pick = (sym) => {
      const q = s.quote(sym); if (!q) return null;
      const year = s.indexHistory(sym, 365);
      return { last: q.close, change: round2(q.close - q.prevClose), pct: round2((q.close / q.prevClose - 1) * 100), open: q.open, high: q.high, low: q.low, prevClose: q.prevClose,
        yearHigh: Math.max(...year.map((r) => r.high)), yearLow: Math.min(...year.map((r) => r.low)) };
    };
    const indices = REPLAY.symbols.map((symbol) => ({ symbol, ...INDICES[symbol], lot: s.lot(symbol, s.expiries(symbol)[0]), ...pick(symbol) })).filter((x) => x.last != null);
    const v = pick('INDIAVIX');
    return { indices, vix: v ? { symbol: 'INDIAVIX', name: VIX_NAME, short: 'INDIA VIX', ...v } : null, asOf: s.date };
  }

  async marketStatus() {
    const s = this.snap();
    return { open: true, replay: true, status: 'Replay', message: s.live ? `Prices are the last trades before ${s.time} on this day in history.` : 'Prices are the closing prices of this day in history.', tradeDate: s.date, time: s.live ? s.time : null };
  }

  async expiries(symbol) { return this.snap().expiries(symbol); }
  async unpricedExpiries(symbol) { return this.snap().unpricedExpiries(symbol); }

  async chain(symbol, expiry) {
    const s = this.snap(); const spot = s.spot(symbol);
    const side = (r) => {
      if (!r) return null;
      const { bid, ask } = quoteSides(r, spot);
      const chg = r.prevPrice != null ? round2(r.price - r.prevPrice) : 0;
      return { oi: r.oi, chgOi: r.chgOi, vol: r.volume, iv: r.iv ? round2(r.iv * 100) : 0, ltp: r.price, chg, pchg: r.prevPrice ? round2(chg / r.prevPrice * 100) : 0,
        bid, ask, bidQty: 0, askQty: 0, id: optionId(symbol, expiry, r.type, r.strike), lot: r.lot, traded: r.traded,
        delta: r.delta, gamma: r.gamma, theta: r.theta, vega: r.vega };
    };
    const byStrike = new Map();
    for (const r of s.chain(symbol, expiry)) { if (!byStrike.has(r.strike)) byStrike.set(r.strike, { strike: r.strike, ce: null, pe: null }); byStrike.get(r.strike)[r.type === 'CE' ? 'ce' : 'pe'] = r; }
    const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike).map((x) => ({ strike: x.strike, ce: side(x.ce), pe: side(x.pe) }));
    return { symbol, expiry, spot, timestamp: null, rows, ...(s.live && !rows.length ? { note: `No minute prices are stored for ${symbol} options of this expiry on this day.` } : {}) };
  }

  // The replay day's one-minute index bars up to the replay minute (all of them at the close), when downloaded.
  // t is IST wall clock as UTC seconds, like NSE's charts.
  async intraday(symbol) {
    const s = this.snap();
    const [today, prev] = s.index(symbol);
    const prevClose = today?.date === s.date ? prev?.close ?? null : today?.close ?? null;
    return { prevClose, points: s.indexMinutes(symbol).map((b) => ({ t: b.ts + 19800, v: b.c })), replay: true };
  }

  // An option's trades today minute by minute while a day is running; otherwise its daily prices up to the replay date.
  async optionIntraday(identifier) {
    const p = parseOptionId(identifier); if (!p) return { prevClose: null, points: [] };
    const s = this.snap();
    const days = s.contractHistory(p.symbol, p.expiry, p.strike, p.type);
    if (s.live) {
      const prev = days.filter((r) => r.date < s.date).pop();
      return { prevClose: prev?.price ?? null, points: s.contractMinutes(p.symbol, p.expiry, p.strike, p.type).map((r) => ({ t: r.ts + 19800, v: r.price })) };
    }
    const pts = days.map((r) => ({ t: epochSec(r.date), v: r.price }));
    return { prevClose: pts.length > 1 ? pts[pts.length - 2].v : null, points: pts, daily: true };
  }

  async daily(symbol, days = 365) {
    return this.snap().indexHistory(symbol, days).map((r) => ({ date: r.date, o: r.open, h: r.high, l: r.low, c: r.close }));
  }
}

// NSE-style identifier, e.g. OPTIDXNIFTY19-10-2026CE22500.00
export function optionId(symbol, expiry, type, strike) { const [y, m, d] = expiry.split('-'); return `OPTIDX${symbol}${d}-${m}-${y}${type}${Number(strike).toFixed(2)}`; }
export function parseOptionId(id) {
  const m = /^OPTIDX([A-Z0-9]+?)(\d{2})-(\d{2})-(\d{4})(CE|PE)([\d.]+)$/.exec(id || '');
  return m && { symbol: m[1], expiry: `${m[4]}-${m[3]}-${m[2]}`, type: m[5], strike: Number(m[6]) };
}
