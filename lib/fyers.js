// Read-only FYERS market-data adapter. It implements the live market-provider contract used by server.js.
// FYERS individual-app access tokens expire daily; users paste their own client ID and token in the local app.
import { INDICES, VIX_NAME } from './config.js';
import { NseProvider } from './nse.js';
import { fromEpoch, tidy, lastSession } from './bars.js';

// Market-data routes live under /data on the API host (/data/quotes, /data/history, /data/options-chain-v3).
const BASE = 'https://api-t1.fyers.in';
const DATA_BASE = 'https://api-t1.fyers.in/data';
const SYMBOLS = {
  NIFTY: 'NSE:NIFTY50-INDEX', BANKNIFTY: 'NSE:NIFTYBANK-INDEX', FINNIFTY: 'NSE:FINNIFTY-INDEX',
  MIDCPNIFTY: 'NSE:MIDCPNIFTY-INDEX', NIFTYNXT50: 'NSE:NIFTYNXT50-INDEX', INDIAVIX: 'NSE:INDIAVIX-INDEX',
  SENSEX: 'BSE:SENSEX-INDEX', BANKEX: 'BSE:BANKEX-INDEX',
};
const dateFromDmy = (v) => { const [d, m, y] = String(v).split('-'); return `${y}-${m?.padStart(2, '0')}-${d?.padStart(2, '0')}`; };
const epoch = (date) => Math.floor(Date.parse(`${date}T00:00:00+05:30`) / 1000);

export class FyersProvider {
  constructor(fallback = new NseProvider(), secret = null) {
    this.nse = fallback; this.secret = secret; this.config = null; this.problem = null; this.cache = new Map();
    this.capabilities = { indexOptions: true, bseIndexOptions: true, stockOptions: false, expiredOptions: true, optionCandles: true, stream: false };
    try { this.config = JSON.parse(secret?.load() || 'null'); } catch {}
  }
  get name() { return this.config ? 'FYERS' : 'NSE'; }
  get token() { return this.config?.accessToken || null; }
  usable() { return Boolean(this.config?.clientId && this.config?.accessToken); }
  status() { return { connected: this.usable() && !this.problem, hasToken: this.usable(), source: this.usable() ? 'saved' : null, user: null, problem: this.problem?.message || null, expired: Boolean(this.problem?.auth), tokenPage: 'https://myapi.fyers.in/dashboard', answering: this.usable() && !this.problem ? 'FYERS' : 'NSE', stream: 'off', provider: 'fyers' }; }
  async setCredentials({ clientId, accessToken } = {}) {
    clientId = String(clientId || '').trim(); accessToken = String(accessToken || '').trim();
    if (!/^[\w-]{4,80}$/.test(clientId) || !/^[\w.\-=+/]{16,4096}$/.test(accessToken)) throw new Error('Enter your FYERS Client ID and current access token.');
    const previous = this.config, previousProblem = this.problem;
    this.config = { clientId, accessToken }; this.problem = null; this.cache.clear();
    try { await this.get('/data/quotes', { symbols: SYMBOLS.NIFTY }); }
    catch (e) { this.config = previous; this.problem = previousProblem; this.cache.clear(); throw new Error(`FYERS did not accept these credentials: ${e.message}`); }
    this.secret?.save(JSON.stringify(this.config)); return this.status();
  }
  forget() { this.secret?.clear(); this.config = null; this.problem = null; this.cache.clear(); return this.status(); }
  async get(route, params = {}, ttl = 0, base = BASE) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    const key = `${route}?${query}`; const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    if (!this.usable()) throw new Error('Connect your FYERS account first.');
    const res = await fetch(`${base}${key}`, { headers: { Authorization: `${this.config.clientId}:${this.config.accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    let j; try { j = await res.json(); } catch { throw new Error(`FYERS returned an unreadable response (${res.status}).`); }
    if (!res.ok || j.s === 'error' || (j.code && j.code < 0)) {
      const auth = [-8, -15, -16, -17].includes(Number(j.code)) || res.status === 401;
      const e = Object.assign(new Error(j.message || j.error || `FYERS answered ${res.status}`), { auth });
      if (auth) this.problem = e;
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
    const out = new Map();
    for (let i = 0; i < symbols.length; i += 50) {
      const j = await this.get('/data/quotes', { symbols: symbols.slice(i, i + 50).join(',') }, 2500);
      for (const x of j.d || []) if (x.s === 'ok') out.set(x.n, x.v || {});
    }
    return out;
  }
  async indices() {
    return this.either(async () => {
      const names = Object.values(SYMBOLS); const q = await this.quotes(names);
      const quote = (symbol, v) => v ? { last: v.lp, change: v.ch, pct: v.chp, open: v.open_price, high: v.high_price, low: v.low_price, prevClose: v.prev_close_price } : null;
      const indices = Object.entries(INDICES).filter(([s]) => SYMBOLS[s]).map(([symbol, cfg]) => ({ symbol, ...cfg, ...quote(symbol, q.get(SYMBOLS[symbol])) })).filter((x) => Number.isFinite(x.last));
      const vix = quote('INDIAVIX', q.get(SYMBOLS.INDIAVIX));
      return { indices, vix: vix ? { symbol: 'INDIAVIX', name: VIX_NAME, short: 'INDIA VIX', ...vix } : null, asOf: new Date().toISOString() };
    }, () => this.nse.indices());
  }
  async chainData(symbol, expiry = null, ttl = 1500) {
    const underlying = SYMBOLS[symbol];
    if (!underlying) throw new Error(`FYERS does not provide ${symbol} through this adapter.`);
    const j = await this.get('/data/options-chain-v3', { symbol: underlying, strikecount: 50, timestamp: expiry, greeks: 1 }, ttl);
    return j.data;
  }
  async expiries(symbol) {
    return this.either(async () => {
      const d = await this.chainData(symbol, null, 5 * 60e3); const dates = (d?.expiryData || []).map((x) => dateFromDmy(x.date)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
      if (!dates.length) throw new Error(`FYERS returned no expiries for ${symbol}.`); return dates.sort();
    }, () => this.nse.expiries(symbol));
  }
  async chain(symbol, expiryISO) {
    return this.either(async () => {
      const listing = await this.chainData(symbol, null, 5 * 60e3); const expiry = (listing?.expiryData || []).find((x) => dateFromDmy(x.date) === expiryISO);
      if (!expiry) throw new Error(`FYERS has no ${expiryISO} expiry for ${symbol}.`);
      const d = await this.chainData(symbol, expiry.expiry);
      const strikes = new Map(); let spot = null;
      for (const x of d.optionsChain || []) {
        if (Number(x.strike_price) < 0) {
          if (Number(x.strike_price) < 0 && x.option_type === '') spot = x.ltp ?? x.fp ?? null;
          continue;
        }
        const strike = Number(x.strike_price); if (!Number.isFinite(strike)) continue;
        const row = strikes.get(strike) || { strike, ce: null, pe: null };
        const side = x.option_type === 'CE' ? 'ce' : x.option_type === 'PE' ? 'pe' : null; if (!side) continue;
        const ltp = x.ltp || 0, lot = INDICES[symbol]?.lot || 1;
        row[side] = { oi: Math.round((x.oi || 0) / lot), chgOi: Math.round((x.oich || 0) / lot), vol: Math.round((x.volume || 0) / lot), iv: x.greeks?.iv || 0, ltp, chg: x.ltpch || 0, pchg: x.ltpchp || 0, bid: x.bid || 0, ask: x.ask || 0, bidQty: 0, askQty: 0, id: x.symbol, prevClose: ltp - (x.ltpch || 0), lot };
        strikes.set(strike, row);
      }
      const rows = [...strikes.values()].sort((a, b) => a.strike - b.strike);
      if (!rows.length) throw new Error(`FYERS returned an empty chain for ${symbol} ${expiryISO}.`);
      return { symbol, expiry: expiryISO, spot, timestamp: new Date().toISOString(), rows, lot: INDICES[symbol]?.lot || 1 };
    }, () => this.nse.chain(symbol, expiryISO));
  }
  async candles(symbol, resolution, from, to) {
    // range_to runs to the end of that IST day, so today's bars are included. Daily bars are stamped at IST midnight.
    const j = await this.get('/data/history', { symbol, resolution, date_format: 0, range_from: epoch(from), range_to: epoch(to) + 86399, cont_flag: 1, oi_flag: 1 }, 10000);
    return tidy((j.candles || []).map(([t, o, h, l, c, v]) => ({ t: fromEpoch(t), o, h, l, c, v })), resolution === '1D');
  }
  async intraday(symbol) {
    return this.either(async () => {
      const points = lastSession(await this.candles(SYMBOLS[symbol], '1', new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)));
      const q = (await this.quotes([SYMBOLS[symbol]])).get(SYMBOLS[symbol]); return { prevClose: q?.prev_close_price ?? null, points: points.map((p) => ({ t: p.t, v: p.c })) };
    }, () => this.nse.intraday(symbol));
  }
  async daily(symbol, days = 365) {
    return this.either(async () => {
      const rows = new Map(), now = Date.now();
      for (let back = 0; back < days; back += 365) {
        const to = new Date(now - back * 864e5), from = new Date(now - Math.min(days, back + 365) * 864e5);
        const chunk = await this.candles(SYMBOLS[symbol], '1D', from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
        for (const x of chunk) { const date = new Date(x.t * 1000).toISOString().slice(0, 10); rows.set(date, { date, o: x.o, h: x.h, l: x.l, c: x.c }); }
      }
      return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
    }, () => this.nse.daily(symbol, days));
  }
  async optionIntraday(id) {
    if (!/^(NSE|BSE):/.test(String(id || ''))) return this.nse.optionIntraday(id);
    if (!this.usable() || this.problem) throw new Error('Connect FYERS with a current access token to view option candles.');
    const from = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
    const [bars, q] = await Promise.all([this.candles(id, '1', from, to), this.quotes([id])]), points = lastSession(bars);
    return { prevClose: q.get(id)?.prev_close_price ?? null, points: points.map((p) => ({ t: p.t, v: p.c })) };
  }
  async optionCandles(id, range = '1D') {
    const sets = { '1D': ['1', 4], '5D': ['5', 8], '1M': ['60', 32], life: ['1D', 365] };
    const [resolution, days] = sets[range] || sets['1D']; const to = new Date(), from = new Date(Date.now() - days * 864e5);
    if (!/^(NSE|BSE):/.test(String(id || ''))) throw new Error('Pick an active FYERS option contract.');
    let candles = await this.candles(id, resolution, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    if (range === '1D') candles = lastSession(candles);
    return { candles, interval: resolution === '1D' ? '1day' : `${resolution}minute` };
  }
  async expiredExpiries(symbol) {
    return this.either(async () => {
      const underlying = SYMBOLS[symbol];
      if (!underlying || symbol === 'INDIAVIX') throw new Error(`FYERS has no expired options for ${symbol}.`);
      const end = new Date(), start = new Date(Date.now() - 2 * 365 * 864e5), out = new Set();
      for (let from = start; from <= end;) {
        const to = new Date(Math.min(end.getTime(), from.getTime() + 365 * 864e5));
        const j = await this.get('/history/fno/expired/expiry-dates', {
          symbol: underlying, range_from: from.toISOString().slice(0, 10), range_to: to.toISOString().slice(0, 10), date_format: 1,
        }, 6 * 3600e3, DATA_BASE);
        for (const d of j.data?.expiry_dates?.options || []) if (d < end.toISOString().slice(0, 10)) out.add(d);
        from = new Date(to.getTime() + 864e5);
      }
      return [...out].sort().reverse();
    }, async () => { throw new Error(`Could not load expired ${symbol} options from FYERS or NSE.`); });
  }
  async expiredContracts(symbol, expiry) {
    const underlying = SYMBOLS[symbol];
    if (!underlying || !/^\d{4}-\d{2}-\d{2}$/.test(expiry || '')) throw new Error('Pick a valid expired index expiry.');
    const j = await this.get('/history/fno/expired/underlying-symbols', { symbol: underlying, expiry_date: expiry }, 24 * 3600e3, DATA_BASE);
    const options = j.data?.contracts?.options || [];
    return options.flatMap((contract) => {
      const m = String(contract).match(/(\d+(?:\.\d+)?)(CE|PE)$/);
      return m ? [{ symbol: String(contract), strike: Number(m[1]), type: m[2] }] : [];
    });
  }
  async expiredCandles(contract, expiry, range = 'week') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry || '') || !/^(NSE|BSE):[A-Z0-9_-]+$/.test(String(contract || ''))) throw new Error('Pick an expired FYERS contract.');
    const sets = { day: ['1', 1], week: ['5', 7], life: ['60', 45] };
    const [resolution, days] = sets[range] || sets.week;
    const end = new Date(`${expiry}T23:59:00+05:30`), from = new Date(end.getTime() - days * 864e5);
    const j = await this.get('/history/fno/expired/historical-data', {
      symbol: contract, resolution, date_format: 1, range_from: from.toISOString().slice(0, 10), range_to: expiry,
      include_oi: 1, include_greeks: 1,
    }, 24 * 3600e3, DATA_BASE);
    const columns = j.columns || [], oi = columns.indexOf('open_interest');
    const candles = tidy((j.candles || []).map((c) => ({ t: fromEpoch(c[0]), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5], oi: oi >= 0 ? c[oi] : null })));
    return { candles, interval: `${resolution}minute` };
  }
  // This adapter intentionally exposes market data only; the app never sends broker orders.
}
