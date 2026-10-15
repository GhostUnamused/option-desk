// INDstocks (INDmoney) market data: the official broker API, used for live quotes and the option chain when the owner has
// given the app an access token. Anything INDstocks cannot answer (market status, no token, an expired token, an outage)
// falls through to the NSE website provider, so the page never needs to know which one answered.
// Docs: https://api-docs.indstocks.com  · Tokens last 24 hours (indstocks.com/app/api-trading/access-tokens).
import { INDICES, VIX_NAME } from './config.js';
import { isoToNse } from './nse.js';

const BASE = 'https://api.indstocks.com';
const SPACING = 210; // INDstocks allows 5 data/quote calls a second
export const TOKEN_PAGE = 'https://www.indstocks.com/app/api-trading/access-tokens';
// How INDstocks' instruments file spells each index (checked Oct 2026), by the app's symbol.
const INDEX_NAMES = { NIFTY: 'NIFTY 50', BANKNIFTY: 'BANK NIFTY', FINNIFTY: 'NIFTY FINANCIAL', MIDCPNIFTY: 'NIFTY MIDCAP SEL', NIFTYNXT50: 'NIFTY NEXT 50', INDIAVIX: 'INDIA VIX' };

const istNow = () => new Date(Date.now() + 19800e3); // IST wall clock in the UTC fields
// "14-Oct-2026 15:30:00", the way NSE stamps its chain, so the rest of the app reads it unchanged.
function nseStamp() {
  const d = istNow(); const p = (n) => String(n).padStart(2, '0');
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
  if (wd >= 1 && wd <= 5 && mins >= 555 && mins <= 930) return `${isoToNse(d.toISOString().slice(0, 10))} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  // Market closed: name the last weekday session (holidays are not known here).
  const s = new Date(d); if (mins < 555 || wd === 0 || wd === 6) s.setUTCDate(s.getUTCDate() - 1);
  while (s.getUTCDay() === 0 || s.getUTCDay() === 6) s.setUTCDate(s.getUTCDate() - 1);
  return `${isoToNse(s.toISOString().slice(0, 10))} 15:30:00`;
}

export class TokenError extends Error {}

export class IndstocksProvider {
  // fallback: an NseProvider. secret: a SecretFile holding the token the owner pasted in the app.
  constructor(fallback, secret) {
    this.nse = fallback; this.secret = secret;
    this.token = process.env.INDSTOCKS_TOKEN || secret?.load() || null;
    this.source = process.env.INDSTOCKS_TOKEN ? 'env' : this.token ? 'saved' : null;
    this.problem = null; // why INDstocks is not being used right now (expired token, outage)
    this.user = null;
    this.cache = new Map(); this.inflight = new Map(); this.lastCall = 0; this.refused = new Map();
    this.indexIds = null; this.indexPrefix = undefined; this.probedAt = 0; this.lastAnswer = null;
  }

  get name() { return this.lastAnswer === 'INDstocks' ? 'INDstocks' : 'NSE'; }
  usable() { return Boolean(this.token) && !(this.problem instanceof TokenError); }

  status() {
    return { connected: this.usable() && !this.problem, hasToken: Boolean(this.token), source: this.source, user: this.user,
      problem: this.problem ? this.problem.message : null, expired: this.problem instanceof TokenError, tokenPage: TOKEN_PAGE, answering: this.name };
  }

  // Check a token against /user/profile before keeping it. Returns the account holder's first name.
  async setToken(token) {
    token = String(token || '').trim().replace(/^Bearer\s+/i, '');
    if (!/^[\w.\-=+/]{16,4096}$/.test(token)) throw new Error('That does not look like an INDstocks access token. Copy the whole token from the INDstocks website.');
    const j = await this.raw('/user/profile', token).catch((e) => {
      throw e instanceof TokenError ? new Error('INDstocks did not accept this token. Copy the whole token again, or generate a new one.') : e;
    });
    this.token = token; this.problem = null; this.cache.clear(); this.indexIds = null; this.indexPrefix = undefined;
    this.user = j.data?.first_name || null;
    if (this.source !== 'env') { this.secret?.save(token); this.source = 'saved'; }
    return this.status();
  }
  forget() { this.secret?.clear(); this.token = process.env.INDSTOCKS_TOKEN || null; this.source = this.token ? 'env' : null; this.problem = null; this.user = null; this.lastAnswer = null; return this.status(); }

  async raw(path, token = this.token) {
    const wait = Math.max(0, this.lastCall + SPACING - Date.now());
    this.lastCall = Date.now() + wait;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(BASE + path, { headers: { Authorization: token, Accept: 'application/json, text/csv' }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (res.status === 401 || res.status === 403) throw new TokenError('Your INDstocks access token has expired or was replaced. Tokens last 24 hours: paste a fresh one.');
    if (!res.ok || (j && (j.status === 'error' || j.success === false))) {
      const why = j?.message || j?.error || j?.debug_info || `answered ${res.status}`;
      throw new Error(`INDstocks: ${why}${j?.debug_info && j.debug_info !== why ? ` (${j.debug_info})` : ''}`);
    }
    return j ?? text;
  }

  // Cached, de-duplicated call (same pattern as the NSE provider).
  async get(path, ttlMs) {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    if (this.inflight.has(path)) return this.inflight.get(path);
    const p = this.raw(path).then((data) => { this.cache.set(path, { at: Date.now(), data }); return data; })
      .finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  // Full quotes for many contracts. One code INDstocks does not quote (some never-traded strikes) fails the whole call,
  // so a refused batch is split in halves, down to pieces of 8 that are given up on. Returns { code: quote }.
  async quotes(codes, ttl) {
    if (!codes.length) return {};
    const key = codes.join(','), refused = this.refused.get(key);
    try {
      if (refused && Date.now() - refused < 30 * 60e3) throw new Error('refused before'); // split straight away for half an hour
      return (await this.get(`/market/quotes/full?scrip-codes=${key}`, ttl)).data || {};
    } catch (e) {
      if (e instanceof TokenError) throw e;
      if (!refused || Date.now() - refused >= 30 * 60e3) this.refused.set(key, Date.now());
      if (codes.length <= 8) return {};
      const h = Math.ceil(codes.length / 2);
      return { ...(await this.quotes(codes.slice(0, h), ttl)), ...(await this.quotes(codes.slice(h), ttl)) };
    }
  }

  // Try INDstocks, else NSE. A token error parks INDstocks until a new token arrives; other errors only skip this call.
  async either(fn, fallback) {
    if (this.usable()) {
      try { const out = await fn(); this.problem = null; this.lastAnswer = 'INDstocks'; return out; }
      catch (e) { this.problem = e; if (!(e instanceof TokenError)) console.log(`  ${e.message}. Using NSE for this request.`); }
    }
    const out = await fallback(); this.lastAnswer = 'NSE'; return out;
  }

  // Index ids from the instruments file ("NSE,NIFTY 50,40000001"), by INDEX_NAMES (else the name in config).
  async indexId(symbol) {
    if (!this.indexIds) {
      const csv = String(await this.get('/market/instruments?source=index', 24 * 3600e3));
      const byName = new Map();
      for (const line of csv.split(/\r?\n/).slice(1)) { const [ex, name, id] = line.split(','); if (ex === 'NSE' && id) byName.set(name.trim().toUpperCase(), id.trim()); }
      this.indexIds = Object.fromEntries([...Object.keys(INDICES), 'INDIAVIX'].map((s) => [s, byName.get(INDEX_NAMES[s]) || byName.get((INDICES[s]?.name || VIX_NAME).toUpperCase())]).filter(([, v]) => v));
    }
    const id = this.indexIds[symbol];
    if (!id) throw new Error(`INDstocks: no index id for ${symbol}`);
    return id;
  }

  // The docs do not say how an index is named in quote and candle calls (NIDX_ worked in Oct 2026), so try the likely prefixes once and remember.
  async indexCode(symbol) {
    const id = await this.indexId(symbol);
    if (this.indexPrefix === undefined || (this.indexPrefix === null && Date.now() - this.probedAt > 10 * 60e3)) {
      this.indexPrefix = null; this.probedAt = Date.now();
      for (const p of ['NIDX_', 'NSE_', 'IDX_']) {
        try { const j = await this.raw(`/market/quotes/ltp?scrip-codes=${p}${id}`); if (j.data?.[p + id]?.live_price) { this.indexPrefix = p; break; } }
        catch (e) { if (e instanceof TokenError) throw e; }
      }
    }
    if (!this.indexPrefix) throw new Error('INDstocks: index quotes are not available');
    return this.indexPrefix + id;
  }

  async indices() {
    return this.either(async () => {
      const syms = [...Object.keys(INDICES), 'INDIAVIX'];
      const codes = {}; for (const s of syms) { try { codes[s] = await this.indexCode(s); } catch (e) { if (e instanceof TokenError || s === 'NIFTY') throw e; } }
      const j = await this.get(`/market/quotes/full?scrip-codes=${Object.values(codes).join(',')}`, 3000);
      const pick = (d) => d && d.live_price != null && { last: d.live_price, change: d.day_change, pct: d.day_change_percentage, open: d.day_open, high: d.day_high, low: d.day_low, prevClose: d.prev_close, yearHigh: d['52week_high'], yearLow: d['52week_low'] };
      const out = Object.entries(INDICES).map(([symbol, cfg]) => ({ symbol, ...cfg, ...pick(j.data?.[codes[symbol]]) })).filter((x) => x.last != null);
      const v = pick(j.data?.[codes.INDIAVIX]);
      return { indices: out, vix: v ? { symbol: 'INDIAVIX', name: VIX_NAME, short: 'INDIA VIX', ...v } : null, asOf: nseStamp() };
    }, () => this.nse.indices());
  }

  // INDstocks has no market-status call: ask NSE, else go by the clock (9:15 to 15:30 IST, Monday to Friday).
  async marketStatus() {
    try { return await this.nse.marketStatus(); } catch (e) {
      const d = istNow(), mins = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
      const open = wd >= 1 && wd <= 5 && mins >= 555 && mins < 930;
      return { open, status: open ? 'Open' : 'Closed', message: 'Going by the clock (NSE holidays not known).', tradeDate: '' };
    }
  }

  async expiries(symbol) {
    return this.either(async () => {
      const j = await this.get(`/market/instruments/expiries?underlying=${encodeURIComponent(symbol)}&segment=DERIVATIVE`, 3600e3);
      const list = (j.data || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if (!list.length) throw new Error(`INDstocks: no expiries for ${symbol}`);
      return list;
    }, () => this.nse.expiries(symbol));
  }

  async chain(symbol, expiryISO) {
    return this.either(async () => {
      const id = await this.indexId(symbol);
      const j = await this.get(`/market/option-chain?exchange=NSE&segment=INDEX&underlying-scrip=${id}&expiry=${expiryISO}&strike_count=60`, 3000);
      const lot = INDICES[symbol].lot;
      // The chain's previous_oi is not yesterday's, but the full quote has the day's OI change in percent.
      const codes = Object.values(j.data?.strikes || {}).flatMap((d) => [d.ce, d.pe]).filter((o) => o?.security_id && o.oi > 0).map((o) => `NFO_${o.security_id}`);
      const q = await this.quotes(codes, 15000);
      // OI and volume come in units here; the app (like NSE's chain) counts contracts.
      const chgOi = (o) => { const pc = q[`NFO_${o.security_id}`]?.open_interest_change; return pc > -100 ? Math.round((o.oi - o.oi / (1 + pc / 100)) / lot) : 0; };
      const side = (o) => o && ({
        oi: Math.round((o.oi || 0) / lot), chgOi: chgOi(o), vol: Math.round((o.volume || 0) / lot), iv: o.iv || 0,
        ltp: o.last_price || 0, chg: o.previous_close_price ? +(o.last_price - o.previous_close_price).toFixed(2) : 0,
        pchg: o.previous_close_price ? +((o.last_price / o.previous_close_price - 1) * 100).toFixed(2) : 0,
        bid: o.top_bid_price || 0, ask: o.top_ask_price || 0, bidQty: o.top_bid_quantity || 0, askQty: o.top_ask_quantity || 0,
        id: o.security_id ? `NFO_${o.security_id}` : '',
      });
      const rows = Object.entries(j.data?.strikes || {}).map(([k, d]) => ({ strike: Number(k), ce: side(d.ce), pe: side(d.pe) })).sort((a, b) => a.strike - b.strike);
      if (!rows.length) throw new Error(`INDstocks: empty chain for ${symbol} ${expiryISO}`);
      return { symbol, expiry: expiryISO, spot: j.data?.underlying_ltp ?? null, timestamp: nseStamp(), rows };
    }, () => this.nse.chain(symbol, expiryISO));
  }

  // One-minute candles of the latest session, as { t, v } with IST wall clock in t (like NSE). INDstocks' ts is true epoch seconds.
  async candles1m(code, ttl) {
    const end = Date.now(), start = end - 4 * 864e5; // covers a long weekend; only the latest session is kept
    const j = await this.get(`/market/historical/1minute?scrip-codes=${code}&start_time=${Math.floor(start / 60e3) * 60e3}&end_time=${Math.ceil(end / 60e3) * 60e3}`, ttl);
    const c = j.data?.[code]?.candles || [];
    if (!c.length) throw new Error(`INDstocks: no candles for ${code}`);
    const day = (ts) => new Date(ts * 1000 + 19800e3).toISOString().slice(0, 10);
    const last = day(c[c.length - 1].ts);
    return c.filter((x) => day(x.ts) === last).map((x) => ({ t: x.ts + 19800, v: x.c }));
  }

  async intraday(symbol) {
    return this.either(async () => {
      const code = await this.indexCode(symbol);
      const [points, q] = await Promise.all([this.candles1m(code, 10000), this.get(`/market/quotes/full?scrip-codes=${code}`, 3000)]);
      return { prevClose: q.data?.[code]?.prev_close ?? null, points };
    }, () => this.nse.intraday(symbol));
  }

  async optionIntraday(id) {
    if (!/^NFO_\d+$/.test(id || '')) return this.nse.optionIntraday(id);
    // The contract only exists at INDstocks, so there is no NSE fallback for it.
    if (!this.usable()) throw new Error('Option charts need the INDstocks connection. Paste a fresh access token.');
    try {
      const [points, q] = await Promise.all([this.candles1m(id, 10000), this.get(`/market/quotes/full?scrip-codes=${id}`, 3000)]);
      this.lastAnswer = 'INDstocks';
      return { prevClose: q.data?.[id]?.prev_close ?? null, points };
    } catch (e) { this.problem = e; throw e; }
  }

  // Daily candles, a year per call (the API's limit). Their ts is midnight UTC of the trading day.
  async daily(symbol, days = 365) {
    return this.either(async () => {
      const code = await this.indexCode(symbol);
      const out = new Map(), end = Date.now();
      for (let back = 0; back < days; back += 365) {
        const to = end - back * 864e5, from = end - Math.min(days, back + 365) * 864e5;
        const j = await this.get(`/market/historical/1day?scrip-codes=${code}&start_time=${Math.floor(from / 864e5) * 864e5}&end_time=${Math.ceil(to / 864e5) * 864e5}`, back === 0 ? 15 * 60e3 : 12 * 3600e3);
        for (const x of j.data?.[code]?.candles || []) {
          const date = new Date(x.ts * 1000 + 19800e3).toISOString().slice(0, 10);
          out.set(date, { date, o: x.o, h: x.h, l: x.l, c: x.c });
        }
      }
      if (!out.size) throw new Error(`INDstocks: no daily history for ${symbol}`);
      return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
    }, () => this.nse.daily(symbol, days));
  }
}
