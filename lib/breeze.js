// Read-only ICICI Direct Breeze data adapter. It never calls any order endpoint.
import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { INDICES, VIX_NAME } from './config.js';
import { NseProvider } from './nse.js';
import { wallClock, tidy, lastSession } from './bars.js';

const BASE = 'https://api.icicidirect.com/breezeapi/api/v1';
const STOCK_CODES = { NIFTY: 'NIFTY', BANKNIFTY: 'CNXBAN', FINNIFTY: 'FNXBAN', MIDCPNIFTY: 'NIFMID', NIFTYNXT50: 'NIFTYNXT50' };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const toExpiry = (d) => `${d}T06:00:00.000Z`;

// Node's fetch rejects a GET body, while Breeze's documented GET APIs require one.
async function request(url, method, body, headers = {}) {
  const u = new URL(url), payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const req = httpsRequest(u, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (x) => { text += x; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch { return reject(new Error(`Breeze returned an unreadable response (${res.statusCode}).`)); }
        if (res.statusCode < 200 || res.statusCode >= 300 || json.Error || json.Status >= 400) return reject(Object.assign(new Error(json.Error || json.error || json.Message || `Breeze answered ${res.statusCode}`), { auth: res.statusCode === 401 || res.statusCode === 403 || /session|token|checksum|auth/i.test(json.Error || '') }));
        resolve(json);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Breeze request timed out.'))); req.on('error', reject); req.write(payload); req.end();
  });
}
export class BreezeProvider {
  constructor(fallback = new NseProvider(), secret = null) {
    this.nse = fallback; this.secret = secret; this.config = null; this.problem = null; this.cache = new Map();
    this.capabilities = { indexOptions: true, bseIndexOptions: false, stockOptions: false, expiredOptions: false, optionCandles: true, stream: false };
    try { this.config = JSON.parse(secret?.load() || 'null'); } catch {}
  }
  get name() { return this.config ? 'ICICI Breeze' : 'NSE'; }
  get token() { return this.config?.sessionToken || null; }
  usable() { return Boolean(this.config?.appKey && this.config?.secretKey && this.config?.sessionToken); }
  status() { return { connected: this.usable() && !this.problem, hasToken: this.usable(), source: this.usable() ? 'saved' : null, user: null, problem: this.problem?.message || null, expired: Boolean(this.problem?.auth), tokenPage: 'https://api.icicidirect.com/', answering: this.usable() && !this.problem ? 'ICICI Breeze' : 'NSE', stream: 'off', provider: 'breeze' }; }
  async setCredentials({ appKey, secretKey, apiSession } = {}) {
    appKey = String(appKey || '').trim(); secretKey = String(secretKey || '').trim(); apiSession = String(apiSession || '').trim();
    if (!/^[\w-]{8,128}$/.test(appKey) || secretKey.length < 8 || secretKey.length > 256 || apiSession.length < 8 || apiSession.length > 512) throw new Error('Enter your Breeze App Key, Secret Key, and current API Session code.');
    const previous = this.config, previousProblem = this.problem; this.problem = null;
    try {
      const j = await request(`${BASE}/customerdetails`, 'GET', { SessionToken: apiSession, AppKey: appKey });
      const sessionToken = j.Success?.session_token;
      if (!sessionToken) throw new Error(j.Error || 'Breeze did not return a session token.');
      this.config = { appKey, secretKey, sessionToken }; this.cache.clear();
    } catch (e) { this.config = previous; this.problem = previousProblem; this.cache.clear(); throw new Error(`Breeze did not accept these credentials: ${e.message}`); }
    this.secret?.save(JSON.stringify(this.config)); return this.status();
  }
  forget() { this.secret?.clear(); this.config = null; this.problem = null; this.cache.clear(); return this.status(); }
  async api(route, body, ttl = 0) {
    if (!this.usable()) throw new Error('Connect your ICICI Breeze account first.');
    const cacheKey = `${route}:${JSON.stringify(body)}`, hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'), payload = JSON.stringify(body || {});
    const checksum = createHash('sha256').update(timestamp + payload + this.config.secretKey).digest('hex');
    try {
      const j = await request(`${BASE}${route}`, 'GET', body, { 'X-Checksum': `token ${checksum}`, 'X-Timestamp': timestamp, 'X-AppKey': this.config.appKey, 'X-SessionToken': this.config.sessionToken });
      this.cache.set(cacheKey, { at: Date.now(), data: j }); this.problem = null; return j;
    } catch (e) { if (e.auth) this.problem = e; throw e; }
  }
  async either(fn, fallback) { if (this.usable() && !this.problem) { try { return await fn(); } catch (e) { if (e.auth) this.problem = e; else console.log(`  ${e.message}. Using NSE for this request.`); } } return fallback(); }
  async marketStatus() { return this.nse.marketStatus(); }
  async indices() { return this.nse.indices(); }
  async expiries(symbol) { return this.either(async () => {
    if (!STOCK_CODES[symbol]) throw new Error(`Breeze does not provide ${symbol} options.`);
    // Breeze does not expose an expiry-list endpoint; NSE supplies the public contract calendar.
    return this.nse.expiries(symbol);
  }, () => this.nse.expiries(symbol)); }
  async chain(symbol, expiry) {
    return this.either(async () => {
      const stock = STOCK_CODES[symbol]; if (!stock) throw new Error(`Breeze does not provide ${symbol} options.`);
      const [calls, puts] = await Promise.all(['call', 'put'].map((right) => this.api('/optionchain', { stock_code: stock, exchange_code: 'NFO', expiry_date: toExpiry(expiry), product_type: 'options', right, strike_price: '' }, 1200)));
      const raw = [...(calls.Success || []), ...(puts.Success || [])], rows = new Map(); let spot = null;
      for (const x of raw) {
        const strike = num(x.strike_price); if (num(x.spot_price)) spot = num(x.spot_price);
        if (!strike) continue;
        const side = String(x.right || '').toLowerCase().startsWith('c') ? 'ce' : String(x.right || '').toLowerCase().startsWith('p') ? 'pe' : null;
        if (!side) continue;
        const r = rows.get(strike) || { strike, ce: null, pe: null }, ltp = num(x.ltp), prev = num(x.previous_close), lot = INDICES[symbol]?.lot || 1;
        r[side] = { oi: Math.round(num(x.open_interest) / lot), chgOi: Math.round(num(x.chnge_oi) / lot), vol: Math.round(num(x.total_quantity_traded) / lot), iv: 0,
          ltp, chg: ltp - prev, pchg: num(x.ltp_percent_change), bid: num(x.best_bid_price), ask: num(x.best_offer_price), bidQty: num(x.best_bid_quantity), askQty: num(x.best_offer_quantity),
          id: `BREEZE|${symbol}|${expiry}|${strike}|${side === 'ce' ? 'CE' : 'PE'}`, prevClose: prev, lot };
        rows.set(strike, r);
      }
      const result = [...rows.values()].sort((a, b) => a.strike - b.strike);
      if (!result.length) throw new Error(`Breeze returned an empty chain for ${symbol} ${expiry}.`);
      return { symbol, expiry, spot, timestamp: new Date().toISOString(), rows: result, lot: INDICES[symbol]?.lot || 1 };
    }, () => this.nse.chain(symbol, expiry));
  }
  // Breeze datetimes are bare IST ("2026-10-16 09:15:00"); one call returns at most 1,000 candles.
  async candleRows(body) {
    const j = await this.api('/historicalcharts', body, 15000);
    const oi = (x) => x.open_interest ?? x.oi;
    return tidy((j.Success || []).map((x) => ({ t: wallClock(x.datetime || x.date), o: num(x.open), h: num(x.high), l: num(x.low), c: num(x.close), v: num(x.volume), oi: oi(x) == null ? null : num(oi(x)) })), body.interval === '1day');
  }
  async intraday(symbol) { return this.nse.intraday(symbol); }
  async daily(symbol, days = 365) { return this.nse.daily(symbol, days); }
  async optionIntraday(id) { if (!String(id || '').startsWith('BREEZE|')) return this.nse.optionIntraday(id); const { candles } = await this.optionCandles(id, '1D'); return { prevClose: null, points: candles.map((x) => ({ t: x.t, v: x.c })) }; }
  async optionCandles(id, range = '1D') {
    const [, symbol, expiry, strikeText, rightText] = String(id || '').split('|'), stock = STOCK_CODES[symbol], strike = Number(strikeText);
    if (!stock || !/^\d{4}-\d{2}-\d{2}$/.test(expiry || '') || !Number.isFinite(strike) || !['CE', 'PE'].includes(rightText)) throw new Error('Pick an active Breeze option contract.');
    const sets = { '1D': ['1minute', 1], '5D': ['5minute', 5], '1M': ['30minute', 30], life: ['1day', 365] }, [interval, days] = sets[range] || sets['1D'];
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const fetchRange = (from, to) => this.candleRows({ interval, from_date: iso(from), to_date: iso(to), stock_code: stock, exchange_code: 'NFO', product_type: 'options', expiry_date: toExpiry(expiry), right: rightText === 'CE' ? 'call' : 'put', strike_price: String(strike) });
    let candles = [];
    // 1D: one day at a time (a day of minutes fits the 1,000-candle cap), stepping back over weekends and holidays.
    if (range === '1D') for (let back = 0; back < 5 && !candles.length; back++) candles = lastSession(await fetchRange(Date.now() - (back + 1) * 864e5, Date.now() - back * 864e5));
    else candles = await fetchRange(Date.now() - days * 864e5, Date.now());
    return { candles, interval };
  }
}
