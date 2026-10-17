// Read-only Upstox market-data adapter for the shared live-provider interface.
// Users paste their own daily access token; this app never places broker orders.
import { INDICES, VIX_NAME } from './config.js';
import { NseProvider } from './nse.js';
import { wallClock, tidy, lastSession, isoDay } from './bars.js';

const BASE = 'https://api.upstox.com';
const SYMBOLS = {
  NIFTY: 'NSE_INDEX|Nifty 50', BANKNIFTY: 'NSE_INDEX|Nifty Bank', FINNIFTY: 'NSE_INDEX|Nifty Financial Services',
  MIDCPNIFTY: 'NSE_INDEX|Nifty Midcap Select', NIFTYNXT50: 'NSE_INDEX|Nifty Next 50', INDIAVIX: 'NSE_INDEX|India VIX',
  SENSEX: 'BSE_INDEX|SENSEX', BANKEX: 'BSE_INDEX|BANKEX',
};
const day = (date) => String(date).slice(0, 10);
const CONTRACT = /^[NB]SE_FO\|\d+$/;

export class UpstoxProvider {
  constructor(fallback = new NseProvider(), secret = null) {
    this.nse = fallback; this.secret = secret; this.token = secret?.load() || null; this.problem = null; this.cache = new Map();
    this.capabilities = { indexOptions: true, bseIndexOptions: true, stockOptions: false, expiredOptions: false, optionCandles: true, stream: false };
  }
  get name() { return this.token ? 'Upstox' : 'NSE'; }
  usable() { return Boolean(this.token); }
  status() { return { connected: this.usable() && !this.problem, hasToken: this.usable(), source: this.usable() ? 'saved' : null, user: null, problem: this.problem?.message || null, expired: Boolean(this.problem?.auth), tokenPage: 'https://account.upstox.com/developer/apps', answering: this.usable() && !this.problem ? 'Upstox' : 'NSE', stream: 'off', provider: 'upstox' }; }
  async setToken(token) {
    token = String(token || '').trim().replace(/^Bearer\s+/i, '');
    if (!/^[\w.\-=+/]{24,4096}$/.test(token)) throw new Error('Enter your current Upstox access token.');
    const previous = this.token, previousProblem = this.problem;
    this.token = token; this.problem = null; this.cache.clear();
    try { await this.get('/v2/market-quote/quotes', { instrument_key: SYMBOLS.NIFTY }); }
    catch (e) { this.token = previous; this.problem = previousProblem; this.cache.clear(); throw new Error(`Upstox did not accept this token: ${e.message}`); }
    this.secret?.save(token); return this.status();
  }
  forget() { this.secret?.clear(); this.token = null; this.problem = null; this.cache.clear(); return this.status(); }
  async get(route, params = {}, ttl = 0) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    const key = `${route}?${query}`, hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    if (!this.usable()) throw new Error('Connect your Upstox account first.');
    const res = await fetch(`${BASE}${key}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    let j; try { j = await res.json(); } catch { throw new Error(`Upstox returned an unreadable response (${res.status}).`); }
    if (!res.ok || j.status === 'error') {
      const auth = res.status === 401 || res.status === 403;
      const details = j.errors?.[0]?.message || j.message || j.error || `answered ${res.status}`;
      const e = Object.assign(new Error(`Upstox: ${details}`), { auth }); if (auth) this.problem = e; throw e;
    }
    this.cache.set(key, { at: Date.now(), data: j }); return j;
  }
  async either(fn, fallback) {
    if (this.usable() && !this.problem) { try { const r = await fn(); this.problem = null; return r; } catch (e) { if (e.auth) this.problem = e; else console.log(`  ${e.message}. Using NSE for this request.`); } }
    return fallback();
  }
  async marketStatus() { return this.nse.marketStatus(); }
  async quotes(keys) {
    const j = await this.get('/v2/market-quote/quotes', { instrument_key: keys.join(',') }, 2500);
    return j.data || {};
  }
  quote(data, key) {
    const q = data[key] || data[key.replace('|', ':')] || Object.values(data).find((x) => x.instrument_token === key);
    if (!q) return null;
    const o = q.ohlc || {};
    return { last: q.last_price, change: q.net_change, pct: o.close ? (q.net_change / o.close) * 100 : null, open: o.open, high: o.high, low: o.low, prevClose: o.close };
  }
  async indices() {
    return this.either(async () => {
      const data = await this.quotes(Object.values(SYMBOLS));
      const indices = Object.entries(INDICES).filter(([s]) => SYMBOLS[s] && s !== 'INDIAVIX').map(([symbol, cfg]) => ({ symbol, ...cfg, ...this.quote(data, SYMBOLS[symbol]) })).filter((x) => Number.isFinite(x.last));
      const v = this.quote(data, SYMBOLS.INDIAVIX);
      return { indices, vix: v ? { symbol: 'INDIAVIX', name: VIX_NAME, short: 'INDIA VIX', ...v } : null, asOf: new Date().toISOString() };
    }, () => this.nse.indices());
  }
  async contracts(symbol, expiry = null) {
    const key = SYMBOLS[symbol]; if (!key || symbol === 'INDIAVIX') throw new Error(`Upstox does not provide ${symbol} options.`);
    const j = await this.get('/v2/option/contract', { instrument_key: key, expiry_date: expiry }, 5 * 60e3);
    return j.data || [];
  }
  async expiries(symbol) {
    return this.either(async () => [...new Set((await this.contracts(symbol)).map((x) => x.expiry))].filter(Boolean).sort(), () => this.nse.expiries(symbol));
  }
  async chain(symbol, expiry) {
    return this.either(async () => {
      const [j, contracts] = await Promise.all([
        this.get('/v2/option/chain', { instrument_key: SYMBOLS[symbol], expiry_date: expiry }, 2500),
        this.contracts(symbol, expiry),
      ]);
      const lot = Number(contracts[0]?.lot_size || INDICES[symbol]?.lot || 1), rows = (j.data || []).map((x) => {
        const side = (o) => {
          if (!o) return null;
          const m = o.market_data || {}, g = o.option_greeks || {}, oi = Number(m.oi || 0), previousOi = Number(m.prev_oi || 0);
          return { oi: Math.round(oi / lot), chgOi: Math.round((oi - previousOi) / lot), vol: Math.round(Number(m.volume || 0) / lot), iv: Number(g.iv || 0), ltp: Number(m.ltp || 0),
            chg: Number(m.ltp || 0) - Number(m.close_price || 0), pchg: m.close_price ? ((Number(m.ltp || 0) / m.close_price) - 1) * 100 : 0,
            bid: Number(m.bid_price || 0), ask: Number(m.ask_price || 0), bidQty: Number(m.bid_qty || 0), askQty: Number(m.ask_qty || 0), id: o.instrument_key, prevClose: Number(m.close_price || 0), lot,
            delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega };
        };
        return { strike: Number(x.strike_price), ce: side(x.call_options), pe: side(x.put_options) };
      }).filter((x) => Number.isFinite(x.strike)).sort((a, b) => a.strike - b.strike);
      if (!rows.length) throw new Error(`Upstox returned an empty chain for ${symbol} ${expiry}.`);
      return { symbol, expiry, spot: j.data[0]?.underlying_spot_price ?? null, timestamp: new Date().toISOString(), rows, lot };
    }, () => this.nse.chain(symbol, expiry));
  }
  async candles(key, unit, interval, from, to, intraday = false) {
    const encoded = encodeURIComponent(key);
    const route = intraday ? `/v3/historical-candle/intraday/${encoded}/${unit}/${interval}` : `/v3/historical-candle/${encoded}/${unit}/${interval}/${to}/${from}`;
    // Upstox lists candles newest first, with +05:30 timestamps.
    const j = await this.get(route, {}, 10000), raw = j.data?.candles || [];
    return tidy(raw.map(([t, o, h, l, c, v]) => ({ t: wallClock(t), o, h, l, c, v })), unit === 'days');
  }
  async intraday(symbol) {
    return this.either(async () => {
      const [points, data] = await Promise.all([this.candles(SYMBOLS[symbol], 'minutes', 1, null, null, true), this.quotes([SYMBOLS[symbol]])]);
      return { prevClose: this.quote(data, SYMBOLS[symbol])?.prevClose ?? null, points: points.map((p) => ({ t: p.t, v: p.c })) };
    }, () => this.nse.intraday(symbol));
  }
  async daily(symbol, days = 365) {
    return this.either(async () => {
      const end = new Date(), rows = new Map();
      for (let back = 0; back < days; back += 3650) {
        const to = new Date(end.getTime() - back * 864e5), from = new Date(end.getTime() - Math.min(days, back + 3650) * 864e5);
        const candles = await this.candles(SYMBOLS[symbol], 'days', 1, day(from.toISOString()), day(to.toISOString()));
        for (const p of candles) rows.set(p.t, { date: isoDay(p.t), o: p.o, h: p.h, l: p.l, c: p.c });
      }
      return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
    }, () => this.nse.daily(symbol, days));
  }
  async optionIntraday(key) {
    if (!CONTRACT.test(String(key || ''))) return this.nse.optionIntraday(key);
    if (!this.usable() || this.problem) throw new Error('Connect Upstox with a current access token to view option charts.');
    const [points, data] = await Promise.all([this.candles(key, 'minutes', 1, null, null, true), this.quotes([key])]);
    return { prevClose: this.quote(data, key)?.prevClose ?? null, points: points.map((p) => ({ t: p.t, v: p.c })) };
  }
  async optionCandles(key, range = '1D') {
    const sets = { '1D': ['minutes', 1, 4], '5D': ['minutes', 5, 8], '1M': ['hours', 1, 32], life: ['days', 1, 365] };
    if (!CONTRACT.test(String(key || ''))) throw new Error('Pick an active Upstox option contract.');
    const [unit, interval, days] = sets[range] || sets['1D'], to = new Date(), from = new Date(Date.now() - days * 864e5);
    // Historical candles stop at yesterday, so 1D reads today's intraday bars and falls back to the last session.
    let candles = range === '1D' ? await this.candles(key, unit, interval, null, null, true) : [];
    if (!candles.length) candles = await this.candles(key, unit, interval, day(from.toISOString()), day(to.toISOString()));
    if (range === '1D') candles = lastSession(candles);
    return { candles, interval: unit === 'days' ? '1day' : unit === 'hours' ? `${interval * 60}minute` : `${interval}minute` };
  }
  // Upstox expired-contract history requires a Plus subscription, so it is intentionally not used.
  async expiredExpiries() { throw new Error('Upstox expired-option history requires its Plus subscription.'); }
  async expiredContracts() { throw new Error('Upstox expired-option history requires its Plus subscription.'); }
  async expiredCandles() { throw new Error('Upstox expired-option history requires its Plus subscription.'); }
}
