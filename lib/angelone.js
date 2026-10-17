// Read-only Angel One SmartAPI adapter. No order or portfolio API is called.
import os from 'node:os';
import { INDICES, VIX_NAME } from './config.js';
import { NseProvider } from './nse.js';
import { wallClock, tidy, lastSession, isoDay } from './bars.js';

const BASE = 'https://apiconnect.angelone.in/rest';
const MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const ROOTS = { NIFTY: 'NIFTY', BANKNIFTY: 'BANKNIFTY', FINNIFTY: 'FINNIFTY', MIDCPNIFTY: 'MIDCPNIFTY', NIFTYNXT50: 'NIFTYNXT50' };
// Index rows in the scrip master: the name is the F&O root (NIFTY) and the symbol the index (Nifty 50); either may match.
const INDEX_NAMES = { NIFTY: ['NIFTY 50', 'NIFTY'], BANKNIFTY: ['NIFTY BANK', 'BANKNIFTY'], FINNIFTY: ['NIFTY FIN SERVICE', 'NIFTY FINANCIAL SERVICES', 'FINNIFTY'], MIDCPNIFTY: ['NIFTY MID SELECT', 'NIFTY MIDCAP SELECT', 'MIDCPNIFTY'], NIFTYNXT50: ['NIFTY NEXT 50', 'NIFTYNXT50'], INDIAVIX: ['INDIA VIX'] };
const isIndex = (x, names) => x.exch_seg === 'NSE' && /^(AMXIDX|INDEX)$/i.test(x.instrumenttype || '') && (names.includes(String(x.name).toUpperCase()) || names.includes(String(x.symbol).toUpperCase()));
// FULL quotes carry the order book as depth.buy/sell; older payloads had bestBuyRate-style fields.
const best = (q, side) => (side === 'buy' ? { price: q?.depth?.buy?.[0]?.price ?? q?.bestBuyRate, qty: q?.depth?.buy?.[0]?.quantity ?? q?.bestBuyQty } : { price: q?.depth?.sell?.[0]?.price ?? q?.bestSellRate, qty: q?.depth?.sell?.[0]?.quantity ?? q?.bestSellQty });
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const compactDate = (iso) => { const d = new Date(`${iso}T00:00:00Z`), mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']; return `${String(d.getUTCDate()).padStart(2, '0')}${mon[d.getUTCMonth()]}${d.getUTCFullYear()}`; };
const isoDate = (v) => { const s = String(v || '').toUpperCase(), m = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/.exec(s); if (!m) return ''; const months = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }; return `${m[3]}-${months[m[2]]}-${m[1]}`; };
const localAddress = () => { for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address; return '127.0.0.1'; };
const deviceMac = () => { for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (!n.internal && n.mac && n.mac !== '00:00:00:00:00:00') return n.mac; return '00:00:00:00:00:00'; };

export class AngelOneProvider {
  constructor(fallback = new NseProvider(), secret = null) {
    this.nse = fallback; this.secret = secret; this.config = null; this.problem = null; this.cache = new Map(); this.master = null; this.masterAt = 0; this.lastQuoteAt = 0; this.quoteQueue = Promise.resolve();
    this.capabilities = { indexOptions: true, bseIndexOptions: false, stockOptions: false, expiredOptions: false, optionCandles: true, stream: false };
    try { this.config = JSON.parse(secret?.load() || 'null'); } catch {}
  }
  get name() { return this.config ? 'Angel One' : 'NSE'; }
  get token() { return this.config?.jwtToken || null; }
  usable() { return Boolean(this.config?.apiKey && this.config?.jwtToken); }
  status() { return { connected: this.usable() && !this.problem, hasToken: this.usable(), source: this.usable() ? 'saved' : null, user: null, problem: this.problem?.message || null, expired: Boolean(this.problem?.auth), tokenPage: 'https://smartapi.angelone.in/', answering: this.usable() && !this.problem ? 'Angel One' : 'NSE', stream: 'off', provider: 'angelone' }; }
  headers() { return { Authorization: `Bearer ${this.config?.jwtToken || ''}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': localAddress(), 'X-ClientPublicIP': this.config?.publicIP || '127.0.0.1', 'X-MACAddress': deviceMac(), 'X-PrivateKey': this.config?.apiKey || '' }; }
  async call(route, body, { auth = true, ttl = 0 } = {}) {
    const key = `${route}:${JSON.stringify(body || {})}`, hit = this.cache.get(key); if (hit && Date.now() - hit.at < ttl) return hit.data;
    const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: auth ? this.headers() : { 'Content-Type': 'application/json', Accept: 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': localAddress(), 'X-ClientPublicIP': this.config?.publicIP || '127.0.0.1', 'X-MACAddress': deviceMac(), 'X-PrivateKey': this.config?.apiKey || '' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000) });
    let j; try { j = await res.json(); } catch { throw new Error(`Angel One returned an unreadable response (${res.status}).`); }
    if (!res.ok || j.status === false) { const message = String(j.message || ''); const isAuth = res.status === 401 || res.status === 403 || ['AB1010','AB1007','AB1011'].includes(j.errorcode) || /token|auth|session/i.test(message); const e = Object.assign(new Error(message || `Angel One answered ${res.status}`), { auth: isAuth }); if (isAuth) this.problem = e; throw e; }
    this.cache.set(key, { at: Date.now(), data: j }); return j;
  }
  async setCredentials({ apiKey, clientCode, pin, totp } = {}) {
    apiKey = String(apiKey || '').trim(); clientCode = String(clientCode || '').trim(); pin = String(pin || '').trim(); totp = String(totp || '').trim();
    if (!apiKey || apiKey.length > 128 || !/^[A-Za-z0-9_-]{4,32}$/.test(clientCode) || !/^\d{4,6}$/.test(pin) || !/^\d{6}$/.test(totp)) throw new Error('Enter your SmartAPI key, client code, trading PIN, and current six-digit TOTP.');
    const previous = this.config, previousProblem = this.problem;
    try {
      let publicIP = '127.0.0.1'; try { const ip = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) }); publicIP = (await ip.json()).ip || publicIP; } catch {}
      this.config = { apiKey, publicIP }; this.problem = null;
      const j = await this.call('/auth/angelbroking/user/v1/loginByPassword', { clientcode: clientCode, password: pin, totp }, { auth: false });
      const d = j.data || {}; if (!d.jwtToken || !d.refreshToken) throw new Error(j.message || 'Angel One did not return a trading session.');
      this.config = { apiKey, clientCode, jwtToken: d.jwtToken, refreshToken: d.refreshToken, feedToken: d.feedToken || '', publicIP };
      this.cache.clear(); await this.call('/secure/angelbroking/user/v1/getProfile', {});
    } catch (e) { this.config = previous; this.problem = previousProblem; this.cache.clear(); throw new Error(`Angel One did not accept these credentials: ${e.message}`); }
    this.secret?.save(JSON.stringify(this.config)); return this.status();
  }
  forget() { this.secret?.clear(); this.config = null; this.problem = null; this.cache.clear(); this.master = null; return this.status(); }
  async either(fn, fallback) { if (this.usable() && !this.problem) { try { const r = await fn(); this.problem = null; return r; } catch (e) { if (e.auth) this.problem = e; else console.log(`  ${e.message}. Using NSE for this request.`); } } return fallback(); }
  async instruments() {
    if (this.master && Date.now() - this.masterAt < 24 * 3600e3) return this.master;
    const res = await fetch(MASTER_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Angel One instrument master answered ${res.status}.`);
    const data = await res.json(); if (!Array.isArray(data)) throw new Error('Angel One returned an invalid instrument master.');
    this.master = data; this.masterAt = Date.now(); return data;
  }
  async marketStatus() { return this.nse.marketStatus(); }
  async marketQuotes(exchangeTokens) {
    const run = async () => {
      const now = Date.now(), delay = Math.max(0, 1000 - (now - this.lastQuoteAt)); if (delay) await new Promise((r) => setTimeout(r, delay));
      const j = await this.call('/secure/angelbroking/market/v1/quote', { mode: 'FULL', exchangeTokens }); this.lastQuoteAt = Date.now();
      return j.data?.fetched || [];
    };
    const pending = this.quoteQueue.then(run, run); this.quoteQueue = pending.catch(() => {}); return pending;
  }
  async indices() {
    return this.either(async () => {
      const all = await this.instruments(), found = {};
      for (const [sym, aliases] of Object.entries(INDEX_NAMES)) found[sym] = all.find((x) => isIndex(x, aliases));
      const symbols = Object.entries(found).filter(([, x]) => x).map(([, x]) => String(x.token)), quotes = symbols.length ? await this.marketQuotes({ NSE: symbols }) : [];
      const byToken = new Map(quotes.map((q) => [String(q.symbolToken), q]));
      const fields = (q) => q ? { last: num(q.ltp), change: num(q.netChange), pct: q.close ? num(q.netChange) / num(q.close) * 100 : 0, open: num(q.open), high: num(q.high), low: num(q.low), prevClose: num(q.close) } : null;
      const list = Object.entries(INDICES).filter(([s]) => found[s] && s !== 'INDIAVIX').map(([symbol, cfg]) => ({ symbol, ...cfg, ...fields(byToken.get(String(found[symbol].token))) })).filter((x) => x.last > 0);
      const vix = fields(byToken.get(String(found.INDIAVIX?.token)));
      return { indices: list, vix: vix?.last ? { symbol: 'INDIAVIX', name: VIX_NAME, short: 'INDIA VIX', ...vix } : null, asOf: new Date().toISOString() };
    }, () => this.nse.indices());
  }
  async expiries(symbol) { return this.either(async () => {
    if (!ROOTS[symbol]) throw new Error(`Angel One does not provide ${symbol} options.`);
    const all = await this.instruments(), dates = new Set(all.filter((x) => x.exch_seg === 'NFO' && x.name === ROOTS[symbol] && x.instrumenttype === 'OPTIDX').map((x) => isoDate(x.expiry)).filter(Boolean));
    if (!dates.size) throw new Error(`Angel One has no active ${symbol} expiries.`); return [...dates].sort();
  }, () => this.nse.expiries(symbol)); }
  async chain(symbol, expiry) {
    return this.either(async () => {
      const root = ROOTS[symbol]; if (!root) throw new Error(`Angel One does not provide ${symbol} options.`);
      const all = await this.instruments(), expiryCode = compactDate(expiry), contracts = all.filter((x) => x.exch_seg === 'NFO' && x.name === root && String(x.expiry).toUpperCase() === expiryCode && x.instrumenttype === 'OPTIDX' && /(?:CE|PE)$/.test(String(x.symbol || '')));
      if (!contracts.length) throw new Error(`Angel One has no ${symbol} contracts for ${expiry}.`);
      let greekRows = [];
      try { greekRows = (await this.call('/secure/angelbroking/marketData/v1/optionGreek', { name: root, expirydate: expiryCode })).data || []; } catch (e) { console.log(`  Angel One option Greeks: ${e.message}`); }
      const greeks = new Map(greekRows.map((g) => [`${num(g.strikePrice)}:${g.optionType}`, g]));
      // Without the spot the nearest-100 pick would be the lowest strikes, so a missing index quote fails over to NSE's.
      let spot = 0; try { const q = (await this.marketQuotes({ NSE: [String(await this.indexToken(symbol))] }))[0]; spot = num(q?.ltp); } catch {}
      if (!spot) try { spot = num((await this.nse.indices()).indices.find((i) => i.symbol === symbol)?.last); } catch {}
      if (!spot) throw new Error(`Angel One: no ${symbol} spot price to centre the chain on.`);
      const scaleStrike = (x) => num(x.strike) / 100, nearest = contracts.map((x) => ({ x, strike: scaleStrike(x) })).filter((x) => x.strike > 0).sort((a, b) => (spot ? Math.abs(a.strike - spot) - Math.abs(b.strike - spot) : a.strike - b.strike)).slice(0, 100);
      const quoted = new Map();
      for (let i = 0; i < nearest.length; i += 50) {
        const batch = nearest.slice(i, i + 50), q = await this.marketQuotes({ NFO: batch.map(({ x }) => String(x.token)) });
        for (const item of q) quoted.set(String(item.symbolToken), item);
      }
      const rows = new Map(), lot = num(contracts[0]?.lotsize) || INDICES[symbol]?.lot || 1;
      for (const { x, strike } of nearest) {
        const type = String(x.symbol).endsWith('CE') ? 'CE' : 'PE', g = greeks.get(`${strike}:${type}`) || {}, q = quoted.get(String(x.token));
        const row = rows.get(strike) || { strike, ce: null, pe: null }, ltp = num(q?.ltp), prev = num(q?.close), volume = num(q?.tradeVolume ?? g.tradeVolume), oi = num(q?.opnInterest);
        row[type === 'CE' ? 'ce' : 'pe'] = { oi: Math.round(oi / lot), chgOi: 0, vol: Math.round(volume / lot), iv: num(g.impliedVolatility), ltp, chg: ltp - prev, pchg: prev ? (ltp / prev - 1) * 100 : 0,
          bid: num(best(q, 'buy').price), ask: num(best(q, 'sell').price), bidQty: num(best(q, 'buy').qty), askQty: num(best(q, 'sell').qty), id: `ANGEL|NFO|${x.token}`, prevClose: prev, lot,
          delta: num(g.delta), gamma: num(g.gamma), theta: num(g.theta), vega: num(g.vega) };
        rows.set(strike, row);
      }
      const result = [...rows.values()].sort((a, b) => a.strike - b.strike);
      if (!result.length) throw new Error(`Angel One returned an empty chain for ${symbol} ${expiry}.`);
      return { symbol, expiry, spot: spot || null, timestamp: new Date().toISOString(), rows: result, lot };
    }, () => this.nse.chain(symbol, expiry));
  }
  async candleRows(exchange, token, interval, from, to) {
    const ranges = { ONE_MINUTE: 30, FIVE_MINUTE: 100, ONE_HOUR: 400, ONE_DAY: 2000 }, max = ranges[interval] || 30, out = new Map();
    for (let end = to; end > from;) {
      const start = Math.max(from, end - max * 864e5), local = (ms) => new Date(ms + 19800e3).toISOString().slice(0, 16).replace('T', ' ');
      const j = await this.call('/secure/angelbroking/historical/v1/getCandleData', { exchange, symboltoken: String(token), interval, fromdate: local(start), todate: local(end) });
      for (const c of j.data || []) { const t = wallClock(c[0]); out.set(t, { t, o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: num(c[5]), oi: null }); }
      end = start;
    }
    return tidy([...out.values()], interval === 'ONE_DAY');
  }
  async indexToken(symbol) { const all = await this.instruments(), names = INDEX_NAMES[symbol] || []; const x = all.find((i) => isIndex(i, names)); if (!x) throw new Error(`Angel One has no index token for ${symbol}.`); return x.token; }
  async intraday(symbol) { return this.either(async () => { const token = await this.indexToken(symbol), candles = lastSession(await this.candleRows('NSE', token, 'ONE_MINUTE', Date.now() - 4 * 864e5, Date.now())); const q = (await this.marketQuotes({ NSE: [String(token)] }))[0]; return { prevClose: num(q?.close) || null, points: candles.map((x) => ({ t: x.t, v: x.c })) }; }, () => this.nse.intraday(symbol)); }
  async daily(symbol, days = 365) { return this.either(async () => { const token = await this.indexToken(symbol), candles = await this.candleRows('NSE', token, 'ONE_DAY', Date.now() - days * 864e5, Date.now()); return candles.map((x) => ({ date: isoDay(x.t), o: x.o, h: x.h, l: x.l, c: x.c })); }, () => this.nse.daily(symbol, days)); }
  async optionIntraday(id) { if (!String(id || '').startsWith('ANGEL|')) return this.nse.optionIntraday(id); const candles = await this.optionCandles(id, '1D'); return { prevClose: null, points: candles.candles.map((x) => ({ t: x.t, v: x.c })) }; }
  async optionCandles(id, range = '1D') {
    const [, exchange, token] = String(id || '').split('|'); if (!['NFO','BFO'].includes(exchange) || !/^\d+$/.test(token || '')) throw new Error('Pick an active Angel One option contract.');
    const sets = { '1D': ['ONE_MINUTE', 4], '5D': ['FIVE_MINUTE', 10], '1M': ['ONE_HOUR', 30], life: ['ONE_DAY', 365] }, [interval, days] = sets[range] || sets['1D'];
    let candles = await this.candleRows(exchange, token, interval, Date.now() - days * 864e5, Date.now()); if (range === '1D') candles = lastSession(candles);
    return { candles, interval: { ONE_MINUTE: '1minute', FIVE_MINUTE: '5minute', ONE_HOUR: '60minute', ONE_DAY: '1day' }[interval] };
  }
}
