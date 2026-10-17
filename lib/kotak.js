// Read-only Kotak Neo market-data adapter. The app uses only the consumer key
// endpoints; it never authenticates for trading or sends orders.
import { INDICES } from './config.js';
import { NseProvider } from './nse.js';
import { wallClock, tidy, lastSession } from './bars.js';

const BASE = 'https://mis.kotaksecurities.com';
const UNDERLYINGS = {
  NIFTY: ['nse_fo', 'NIFTY'], BANKNIFTY: ['nse_fo', 'BANKNIFTY'], FINNIFTY: ['nse_fo', 'FINNIFTY'],
  MIDCPNIFTY: ['nse_fo', 'MIDCPNIFTY'], NIFTYNXT50: ['nse_fo', 'NIFTYNXT50'],
  SENSEX: ['bse_fo', 'SENSEX'], BANKEX: ['bse_fo', 'BANKEX'],
};
const INDEX_QUOTES = {
  NIFTY: 'nse_cm|Nifty 50', BANKNIFTY: 'nse_cm|Nifty Bank', FINNIFTY: 'nse_cm|Nifty Fin Service',
  MIDCPNIFTY: 'nse_cm|NIFTY MID SELECT', NIFTYNXT50: 'nse_cm|Nifty Next 50', INDIAVIX: 'nse_cm|INDIA VIX',
  SENSEX: 'bse_cm|SENSEX', BANKEX: 'bse_cm|BANKEX',
};
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isoDay = (v) => String(v).slice(0, 10);
const CONTRACT = /^[nb]se_fo\|\d+$/i;

export class KotakProvider {
  constructor(fallback = new NseProvider(), secret = null) {
    this.nse = fallback; this.secret = secret; this.token = secret?.load() || null; this.problem = null; this.cache = new Map();
    this.capabilities = { indexOptions: true, bseIndexOptions: true, stockOptions: false, expiredOptions: false, optionCandles: true, stream: false };
  }
  get name() { return this.token ? 'Kotak Neo' : 'NSE'; }
  usable() { return Boolean(this.token); }
  status() { return { connected: this.usable() && !this.problem, hasToken: this.usable(), source: this.usable() ? 'saved' : null, user: null, problem: this.problem?.message || null, expired: Boolean(this.problem?.auth), tokenPage: 'https://kotakneo.com/platform/trade-api', answering: this.usable() && !this.problem ? 'Kotak Neo' : 'NSE', stream: 'off', provider: 'kotak' }; }
  async setToken(token) {
    token = String(token || '').trim();
    if (!/^[\w.\-=+/]{20,512}$/.test(token)) throw new Error('Enter your Kotak Neo consumer key.');
    const previous = this.token, previousProblem = this.problem;
    this.token = token; this.problem = null; this.cache.clear();
    try { await this.get('/market-data/1.0/watchlist/expiries', { exchange: 'nse_fo', underlying: 'NIFTY', instrument_type: 'option' }); }
    catch (e) { this.token = previous; this.problem = previousProblem; this.cache.clear(); throw new Error(`Kotak Neo did not accept this consumer key: ${e.message}`); }
    this.secret?.save(token); return this.status();
  }
  forget() { this.secret?.clear(); this.token = null; this.problem = null; this.cache.clear(); return this.status(); }
  async get(route, params = {}, ttl = 0) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    const key = `${route}?${query}`, hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    if (!this.usable()) throw new Error('Connect your Kotak Neo account first.');
    const res = await fetch(`${BASE}${key}`, { headers: { Authorization: this.token, 'neo-fin-key': 'neotradeapi', Accept: 'application/json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
    let j; try { j = await res.json(); } catch { throw new Error(`Kotak Neo returned an unreadable response (${res.status}).`); }
    if (!res.ok || j.status === 'ERROR' || j.stat === 'Not_Ok' || j.data?.status === 'ERROR') {
      const details = j.fault?.message || j.emsg || j.message || `answered ${res.status}`;
      const auth = res.status === 401 || res.status === 403;
      const e = Object.assign(new Error(`Kotak Neo: ${details}`), { auth }); if (auth) this.problem = e;
      throw e;
    }
    this.cache.set(key, { at: Date.now(), data: j }); return j;
  }
  async either(fn, fallback) {
    if (this.usable() && !this.problem) { try { const r = await fn(); this.problem = null; return r; } catch (e) { if (e.auth) this.problem = e; else console.log(`  ${e.message}. Using NSE for this request.`); } }
    return fallback();
  }
  async marketStatus() { return this.nse.marketStatus(); }
  async quotes(symbols) {
    const path = `/script-details/1.0/quotes/neosymbol/${encodeURIComponent(symbols.join(','))}/all`;
    const j = await this.get(path, {}, 2500);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.data)) return j.data;
    throw new Error('Kotak Neo returned an unexpected quotes response.');
  }
  quoteFields(q) {
    if (!q) return null;
    const o = q.ohlc || {}, last = num(q.ltp);
    return { last, change: num(q.change), pct: num(q.per_change), open: num(o.open), high: num(o.high), low: num(o.low), prevClose: num(o.close) };
  }
  async indices() {
    return this.either(async () => {
      const requests = Object.entries(INDEX_QUOTES), quotes = await this.quotes(requests.map(([, key]) => key));
      const bySymbol = new Map(requests.map(([s, key]) => [s, quotes.find((q) => String(q.exchange_token || '').toUpperCase() === key.split('|')[1].toUpperCase())]));
      const indices = Object.entries(INDICES).filter(([s]) => s !== 'INDIAVIX' && INDEX_QUOTES[s]).map(([symbol, cfg]) => ({ symbol, ...cfg, ...(this.quoteFields(bySymbol.get(symbol)) || {}) })).filter((x) => Number.isFinite(x.last) && x.last > 0);
      const vix = this.quoteFields(bySymbol.get('INDIAVIX'));
      return { indices, vix: vix?.last ? { symbol: 'INDIAVIX', name: 'INDIA VIX', short: 'INDIA VIX', ...vix } : null, asOf: new Date().toISOString() };
    }, () => this.nse.indices());
  }
  async expiries(symbol) {
    return this.either(async () => {
      const [exchange, underlying] = UNDERLYINGS[symbol] || [];
      if (!exchange) throw new Error(`Kotak Neo does not provide ${symbol} options.`);
      const j = await this.get('/market-data/1.0/watchlist/expiries', { exchange, underlying, instrument_type: 'option' }, 5 * 60e3);
      const dates = (j.expiries || j.data?.expiries || []).map(isoDay).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
      if (!dates.length) throw new Error(`Kotak Neo returned no expiries for ${symbol}.`);
      return dates;
    }, () => this.nse.expiries(symbol));
  }
  async chain(symbol, expiry) {
    return this.either(async () => {
      const [exchange, underlying] = UNDERLYINGS[symbol] || [];
      if (!exchange) throw new Error(`Kotak Neo does not provide ${symbol} options.`);
      const j = await this.get('/market-data/1.0/watchlist/option-chain', { exchange, underlying, expiry, instrument_type: 'option', count: 40 }, 2000);
      const data = j.data || {}, common = data.common_data || {}, lot = num(common.mktLot) || INDICES[symbol]?.lot || 1;
      const rowsByStrike = new Map();
      for (const [items, side] of [[data.call || [], 'ce'], [data.put || [], 'pe']]) for (const item of items) {
        const inst = item.instrument || {}, q = item.quote || {}, oi = item.openInterest || {}, strike = num(inst.strikePrice);
        if (!strike) continue;
        const row = rowsByStrike.get(strike) || { strike, ce: null, pe: null };
        const ltp = num(q.ltp), prev = num(q.prevClose), currentOi = num(oi.current), priorOi = num(oi.previous);
        row[side] = { oi: Math.round(currentOi / lot), chgOi: Math.round((currentOi - priorOi) / lot), vol: Math.round(num(q.volume) / lot), iv: 0,
          ltp, chg: ltp - prev, pchg: prev ? ((ltp / prev) - 1) * 100 : 0, bid: num(q.bid), ask: num(q.ask), bidQty: num(q.bidQty), askQty: num(q.askQty),
          id: inst.neoSymbol, prevClose: prev, lot };
        rowsByStrike.set(strike, row);
      }
      const rows = [...rowsByStrike.values()].sort((a, b) => a.strike - b.strike);
      if (!rows.length) throw new Error(`Kotak Neo returned an empty chain for ${symbol} ${expiry}.`);
      let spot = null;
      try {
        const quote = (await this.quotes([INDEX_QUOTES[symbol]])).find((q) => String(q.exchange_token || '').toUpperCase() === INDEX_QUOTES[symbol].split('|')[1].toUpperCase());
        spot = this.quoteFields(quote)?.last ?? null;
      } catch {}
      if (!spot) try { spot = (await this.nse.chain(symbol, expiry)).spot; } catch {}
      return { symbol, expiry, spot, timestamp: new Date().toISOString(), rows, lot };
    }, () => this.nse.chain(symbol, expiry));
  }
  async intraday(symbol) { return this.nse.intraday(symbol); }
  async daily(symbol, days = 365) { return this.nse.daily(symbol, days); }
  async candles(key, interval, from, to) {
    const j = await this.get('/market-data/1.0/historical/details', { neosymbol: key, fromdate: from, todate: to, interval }, 15000);
    const raw = j.data?.candles || j.candles || [];
    return tidy(raw.map(([t, o, h, l, c, v, oi]) => ({ t: wallClock(t), o: num(o), h: num(h), l: num(l), c: num(c), v: num(v), oi: oi == null ? null : num(oi) })), interval === 'D');
  }
  async optionIntraday(key) {
    if (!CONTRACT.test(String(key || ''))) return this.nse.optionIntraday(key);
    const { candles } = await this.optionCandles(key, '1D');
    return { prevClose: null, points: candles.map((p) => ({ t: p.t, v: p.c })) };
  }
  async optionCandles(key, range = '1D') {
    if (!CONTRACT.test(String(key || ''))) throw new Error('Pick an active Kotak Neo option contract.');
    const sets = { '1D': ['1min', 4], '5D': ['5min', 29], '1M': ['60min', 89], life: ['D', 179] };
    const [interval, days] = sets[range] || sets['1D'], to = new Date(), from = new Date(Date.now() - days * 864e5);
    let candles = await this.candles(key, interval, isoDay(from.toISOString()), isoDay(to.toISOString()));
    if (range === '1D') candles = lastSession(candles);
    return { candles, interval: interval === 'D' ? '1day' : interval.replace('min', 'minute') };
  }
}
