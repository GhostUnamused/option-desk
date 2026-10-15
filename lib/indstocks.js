// INDstocks (INDmoney) market data: the official broker API, used for live quotes and the option chain when the owner has
// given the app an access token. Anything INDstocks cannot answer (market status, no token, an expired token, an outage)
// falls through to the NSE website provider, so the page never needs to know which one answered.
// Docs: https://api-docs.indstocks.com  · Tokens last 24 hours (indstocks.com/app/api-trading/access-tokens).
import fs from 'node:fs';
import { INDICES, VIX_NAME } from './config.js';
import { isoToNse } from './nse.js';
import { PriceStream } from './stream.js';

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

// Candle interval per chart range, with how many days back, and how much one call may cover (the API's limits).
const OPTION_RANGES = { '1D': ['1minute', 4], '5D': ['5minute', 7], '1M': ['60minute', 31], life: ['1day', 365] };
const EXPIRED_RANGES = { day: ['1minute', 1], week: ['5minute', 7], life: ['60minute', 45] };
const RANGE_STEP = { '1minute': [60e3, 7 * 864e5], '5minute': [60e3, 7 * 864e5], '60minute': [60e3, 15 * 864e5], '1day': [864e5, 365 * 864e5] };

export class TokenError extends Error {}

export class IndstocksProvider {
  // fallback: an NseProvider. secret: a SecretFile holding the token the owner pasted in the app.
  // opts.stream: also open the live price WebSocket (the server does; tests don't).
  constructor(fallback, secret, opts = {}) {
    this.nse = fallback; this.secret = secret;
    this.token = process.env.INDSTOCKS_TOKEN || secret?.load() || null;
    this.source = process.env.INDSTOCKS_TOKEN ? 'env' : this.token ? 'saved' : null;
    this.problem = null; // why INDstocks is not being used right now (expired token, outage)
    this.user = null;
    this.cache = new Map(); this.inflight = new Map(); this.lastCall = 0; this.refused = new Map();
    this.indexIds = null; this.lastAnswer = null;
    this.stream = opts.stream ? new PriceStream({ token: () => (this.usable() ? this.token : null), onTokenError: () => { this.problem = new TokenError('Your INDstocks access token has expired or was replaced. Tokens last 24 hours: paste a fresh one.'); } }) : null;
  }
  // Newest streamed price for an instrument id, when the stream is up.
  live(id) { return this.stream?.state === 'live' ? this.stream.tick(id) : null; }

  get name() { return this.lastAnswer === 'INDstocks' ? 'INDstocks' : 'NSE'; }
  usable() { return Boolean(this.token) && !(this.problem instanceof TokenError); }

  status() {
    return { connected: this.usable() && !this.problem, hasToken: Boolean(this.token), source: this.source, user: this.user,
      problem: this.problem ? this.problem.message : null, expired: this.problem instanceof TokenError, tokenPage: TOKEN_PAGE, answering: this.name,
      stream: this.stream && this.usable() ? this.stream.state : 'off' };
  }

  // Check a token against /user/profile before keeping it. Returns the account holder's first name.
  async setToken(token) {
    token = String(token || '').trim().replace(/^Bearer\s+/i, '');
    if (!/^[\w.\-=+/]{16,4096}$/.test(token)) throw new Error('That does not look like an INDstocks access token. Copy the whole token from the INDstocks website.');
    const j = await this.raw('/user/profile', token).catch((e) => {
      throw e instanceof TokenError ? new Error('INDstocks did not accept this token. Copy the whole token again, or generate a new one.') : e;
    });
    this.token = token; this.problem = null; this.cache.clear(); this.indexIds = null;
    this.user = j.data?.first_name || null;
    if (this.source !== 'env') { this.secret?.save(token); this.source = 'saved'; }
    this.stream?.restart();
    return this.status();
  }
  forget() { this.stream?.stop(); this.secret?.clear(); this.token = process.env.INDSTOCKS_TOKEN || null; this.source = this.token ? 'env' : null; this.problem = null; this.user = null; this.lastAnswer = null; return this.status(); }

  async raw(path, token = this.token, tries = 0) {
    const wait = Math.max(0, this.lastCall + SPACING - Date.now());
    this.lastCall = Date.now() + wait;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(BASE + path, { headers: { Authorization: token, Accept: 'application/json, text/csv' }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    // Over the 5-a-second limit (another app or window on the same token, say): wait a little and try again, twice.
    if (res.status === 429 && tries < 2) { await new Promise((r) => setTimeout(r, 700 * (tries + 1))); return this.raw(path, token, tries + 1); }
    if (res.status === 401 || res.status === 403) throw new TokenError('Your INDstocks access token has expired or was replaced. Tokens last 24 hours: paste a fresh one.');
    if (!res.ok || (j && (j.status === 'error' || j.success === false))) {
      const why = j?.message || j?.error || j?.debug_info || `answered ${res.status}`;
      throw Object.assign(new Error(`INDstocks: ${why}${j?.debug_info && j.debug_info !== why ? ` (${j.debug_info})` : ''}`), { status: res.status });
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
      if (!refused && e.status !== 400) return {}; // busy or down, not a bad code: no OI change this time, try whole next time
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
      catch (e) { this.problem = e; if (e instanceof TokenError) this.stream?.stop(); else console.log(`  ${e.message}. Using NSE for this request.`); }
    }
    const out = await fallback(); this.lastAnswer = 'NSE'; return out;
  }

  // Where a symbol lives at INDstocks: its id, the code for quotes and candles, how its option chain is asked for, and the
  // segment its contracts trade in. NSE indices are NIDX_<id>, BSE indices BIDX_<id> (both from the index instruments
  // file), stocks NSE_<equity id>; contracts are NFO_<id> (NSE) or BFO_<id> (BSE).
  async underlying(symbol) {
    const u = symbol === 'INDIAVIX' ? { exchange: 'NSE', kind: 'index', name: VIX_NAME } : INDICES[symbol];
    if (!u) throw new Error(`Unknown underlying ${symbol}`);
    let id = u.id;
    if (u.kind !== 'stock') {
      if (!this.indexIds) {
        const csv = String(await this.get('/market/instruments?source=index', 24 * 3600e3));
        const byName = new Map();
        for (const line of csv.split(/\r?\n/).slice(1)) { const [ex, name, x] = line.split(','); if (x && (ex === 'NSE' || ex === 'BSE')) byName.set(`${ex}|${name.trim().toUpperCase()}`, x.trim()); }
        this.indexIds = byName;
      }
      id = this.indexIds.get(`${u.exchange}|${INDEX_NAMES[symbol] || u.name.toUpperCase()}`) || this.indexIds.get(`${u.exchange}|${u.name.toUpperCase()}`);
    }
    if (!id) throw new Error(`INDstocks: no id for ${symbol}`);
    const bse = u.exchange === 'BSE';
    return { id, code: (u.kind === 'stock' ? 'NSE_' : bse ? 'BIDX_' : 'NIDX_') + id, exchange: u.exchange, segment: u.kind === 'stock' ? 'EQUITY' : 'INDEX', fo: bse ? 'BFO' : 'NFO' };
  }
  async indexCode(symbol) { return (await this.underlying(symbol)).code; }

  // Symbols only INDstocks has (BSE indices, stocks) have no NSE-website fallback: say so instead of asking NSE.
  fallback(symbol, fn) {
    return () => {
      if (INDICES[symbol]?.broker) throw new Error(`${INDICES[symbol].short} options come from INDstocks. ${this.problem instanceof TokenError ? 'Paste a fresh access token' : this.token ? 'INDstocks did not answer; try again in a moment' : 'Connect INDstocks with the Data button in the tab bar'}.`);
      return fn();
    };
  }

  async indices() {
    return this.either(async () => {
      const syms = [...Object.keys(INDICES), 'INDIAVIX'];
      const codes = {}; for (const s of syms) { try { codes[s] = await this.indexCode(s); } catch (e) { if (e instanceof TokenError || s === 'NIFTY') throw e; } }
      const j = await this.get(`/market/quotes/full?scrip-codes=${Object.values(codes).join(',')}`, 3000);
      // Streamed ticks are newer than the 3-second quote cache, so they set the last price (and its change) when there is one.
      for (const [s, c] of Object.entries(codes)) this.stream?.want(c.replace('_', ':'), s);
      const pick = (d, code) => {
        if (!d || d.live_price == null) return null;
        const t = this.live(code.split('_')[1]), last = t ? t.ltp : d.live_price, pc = d.prev_close;
        return { last, change: pc ? +(last - pc).toFixed(2) : d.day_change, pct: pc ? +((last / pc - 1) * 100).toFixed(2) : d.day_change_percentage, open: d.day_open, high: Math.max(d.day_high, last), low: Math.min(d.day_low || last, last), prevClose: pc, yearHigh: d['52week_high'], yearLow: d['52week_low'] };
      };
      const out = Object.entries(INDICES).map(([symbol, cfg]) => ({ symbol, ...cfg, ...(codes[symbol] ? pick(j.data?.[codes[symbol]], codes[symbol]) : null) })).filter((x) => x.last != null);
      const v = codes.INDIAVIX ? pick(j.data?.[codes.INDIAVIX], codes.INDIAVIX) : null;
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
    }, this.fallback(symbol, () => this.nse.expiries(symbol)));
  }

  // Every NSE stock with listed options: { symbol, name, lot, step, id }. Built from the F&O instruments file (~15 MB:
  // lots and strikes of the nearest monthly) and the equity file (the stock's own id), at most once a day, kept in `file`.
  async stockList(file) {
    const today = new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
    if (this.stocks?.date === today) return this.stocks.list;
    try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.date === today && c.list?.length) { this.stocks = c; return c.list; } } catch {}
    if (!this.usable()) throw new Error('The list of stocks with options comes from INDstocks. Connect it first.');
    const [fno, eq] = await Promise.all([this.raw('/market/instruments?source=fno'), this.raw('/market/instruments?source=equity')]);
    const by = new Map(); // symbol -> { name, exp, lot, strikes }
    for (const line of String(fno).split(/\r?\n/)) {
      const f = line.split(',');
      if (f[0] !== 'NSE' || f[3] !== 'OPTSTK') continue;
      const sym = f[5].split('-')[0], exp = f[8].split(' ')[0], d = by.get(sym);
      const [m, dd, y] = exp.split('/'); const iso = `${y}-${m}-${dd}`;
      if (!d || iso < d.exp) by.set(sym, { name: f[16] || sym, exp: iso, lot: Number(f[6]), strikes: new Set([Number(f[9])]) });
      else if (iso === d.exp) d.strikes.add(Number(f[9]));
    }
    const ids = new Map();
    for (const line of String(eq).split(/\r?\n/)) { const f = line.split(','); if (f[0] === 'NSE' && f[14] === 'EQ' && by.has(f[5])) ids.set(f[5], f[2]); }
    const list = [...by].filter(([s]) => ids.has(s)).map(([symbol, d]) => {
      const k = [...d.strikes].sort((a, b) => a - b); let step = Infinity;
      for (let i = 1; i < k.length; i++) step = Math.min(step, k[i] - k[i - 1]);
      return { symbol, name: d.name.replace(/\s+/g, ' ').trim(), lot: d.lot, step: Number.isFinite(step) ? step : 10, id: ids.get(symbol) };
    }).sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (!list.length) throw new Error('INDstocks returned no stocks with options.');
    this.stocks = { date: today, list };
    try { fs.writeFileSync(file, JSON.stringify(this.stocks)); } catch {}
    return list;
  }

  // BSE chains come without contract ids, so look them up once per expiry (instrument search, 100 a page).
  async contractIds(symbol, expiry, type) {
    const k = `ids|${symbol}|${expiry}`, hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
    const map = new Map();
    for (let page = 1; page <= 20; page++) {
      const j = await this.get(`/market/instruments/search?underlying=${encodeURIComponent(symbol)}&segment=DERIVATIVE&instrument_type=${type}&expiry=${expiry}&page=${page}&page_size=100`, 6 * 3600e3);
      for (const x of j.data?.instruments || []) map.set(`${Number(x.strike_price)}|${x.option_type}`, { id: x.security_id, lot: x.lot_size });
      if (page * 100 >= (j.data?.count || 0)) break;
    }
    this.cache.set(k, { at: Date.now(), data: map });
    return map;
  }

  async chain(symbol, expiryISO) {
    return this.either(async () => {
      const u = await this.underlying(symbol), cfg = INDICES[symbol];
      const j = await this.get(`/market/option-chain?exchange=${u.exchange}&segment=${u.segment}&underlying-scrip=${u.id}&expiry=${expiryISO}&strike_count=60`, 3000);
      const strikes = Object.entries(j.data?.strikes || {});
      // Fill in missing contract ids (BSE) and the contract's own lot (stocks' lots differ by expiry during a revision).
      const ids = u.exchange === 'BSE' || cfg.kind === 'stock' ? await this.contractIds(symbol, expiryISO, cfg.kind === 'stock' ? 'OPTSTK' : 'OPTIDX').catch(() => new Map()) : null;
      for (const [k, d] of strikes) for (const [t, o] of [['CE', d.ce], ['PE', d.pe]]) if (o && ids) { const m = ids.get(`${Number(k)}|${t}`); if (m) { o.security_id ||= m.id; o.lot = m.lot; } }
      const lot = [...(ids?.values() || [])][0]?.lot || cfg.lot;
      const sides = strikes.flatMap(([, d]) => [d.ce, d.pe]).filter((o) => o?.security_id);
      // The chain's previous_oi is not yesterday's, but the full quote has the day's OI change in percent.
      const q = await this.quotes(sides.filter((o) => o.oi > 0).map((o) => `${u.fo}_${o.security_id}`), 15000);
      // OI and volume come in units here; the app (like NSE's chain) counts contracts.
      const chgOi = (o, l) => { const pc = q[`${u.fo}_${o.security_id}`]?.open_interest_change; return pc > -100 ? Math.round((o.oi - o.oi / (1 + pc / 100)) / l) : 0; };
      // Every contract in view streams its last price while the page keeps asking for this chain.
      this.stream?.wantGroup(`${symbol}|${expiryISO}`, sides.map((o) => [`${u.fo}:${o.security_id}`, `${u.fo}_${o.security_id}`]));
      const side = (o) => {
        if (!o) return null;
        const l = o.lot || lot, ltp = (o.security_id && this.live(o.security_id)?.ltp) || o.last_price || 0;
        return {
          oi: Math.round((o.oi || 0) / l), chgOi: chgOi(o, l), vol: Math.round((o.volume || 0) / l), iv: o.iv || 0,
          ltp, chg: o.previous_close_price ? +(ltp - o.previous_close_price).toFixed(2) : 0,
          pchg: o.previous_close_price ? +((ltp / o.previous_close_price - 1) * 100).toFixed(2) : 0,
          bid: o.top_bid_price || 0, ask: o.top_ask_price || 0, bidQty: o.top_bid_quantity || 0, askQty: o.top_ask_quantity || 0,
          id: o.security_id ? `${u.fo}_${o.security_id}` : '', prevClose: o.previous_close_price || 0, lot: l,
        };
      };
      const rows = strikes.map(([k, d]) => ({ strike: Number(k), ce: side(d.ce), pe: side(d.pe) })).sort((a, b) => a.strike - b.strike);
      if (!rows.length) throw new Error(`INDstocks: empty chain for ${symbol} ${expiryISO}`);
      return { symbol, expiry: expiryISO, spot: j.data?.underlying_ltp ?? null, timestamp: nseStamp(), rows, lot };
    }, this.fallback(symbol, () => this.nse.chain(symbol, expiryISO)));
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
    }, this.fallback(symbol, () => this.nse.intraday(symbol)));
  }

  async optionIntraday(id) {
    if (!/^[NB]FO_\d+$/.test(id || '')) return this.nse.optionIntraday(id);
    // The contract only exists at INDstocks, so there is no NSE fallback for it.
    if (!this.usable()) throw new Error('Option charts need the INDstocks connection. Paste a fresh access token.');
    try {
      const [points, q] = await Promise.all([this.candles1m(id, 10000), this.get(`/market/quotes/full?scrip-codes=${id}`, 3000)]);
      this.lastAnswer = 'INDstocks';
      return { prevClose: q.data?.[id]?.prev_close ?? null, points };
    } catch (e) { this.problem = e; throw e; }
  }

  // ---- Option price history (live contracts by id, expired ones by trading symbol) ----
  // Candles as { t, o, h, l, c, v } with IST wall clock in t (the app's chart convention). Intraday ts is true epoch
  // seconds; daily ts is midnight UTC of the trading day, which already reads as the right date.
  async candles(path, key, interval, from, to, ttl) {
    const [step, max] = RANGE_STEP[interval];
    const out = new Map();
    for (let end = to; end > from; end -= max) {
      const start = Math.max(from, end - max);
      const j = await this.get(`${path}&start_time=${Math.floor(start / step) * step}&end_time=${Math.ceil(end / step) * step}`, end === to ? ttl : 12 * 3600e3);
      for (const x of j.data?.[key]?.candles || []) out.set(x.ts, { t: interval === '1day' ? x.ts : x.ts + 19800, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
    }
    return [...out.values()].sort((a, b) => a.t - b.t);
  }
  // range: 1D (minutes, latest session), 5D (5-minute), 1M (hourly), life (daily since listing, up to a year).
  async optionCandles(id, range = '1D') {
    if (!/^[NB]FO_\d+$/.test(id || '')) throw new Error('Price history needs the INDstocks connection.');
    if (!this.usable()) throw new Error('Option charts need the INDstocks connection. Paste a fresh access token.');
    const [interval, days] = OPTION_RANGES[range] || OPTION_RANGES['1D'];
    const now = Date.now();
    let c = await this.candles(`/market/historical/${interval}?scrip-codes=${id}`, id, interval, now - days * 864e5, now, range === '1D' ? 10000 : 60000);
    if (range === '1D' && c.length) { const day = (t) => Math.floor(t / 86400); const last = day(c[c.length - 1].t); c = c.filter((x) => day(x.t) === last); }
    this.lastAnswer = 'INDstocks';
    return { candles: c, interval };
  }
  // Expired contracts: expiries in the last two years (INDstocks keeps them from about April 2025), newest first.
  async expiredExpiries(symbol) {
    if (INDICES[symbol]?.kind === 'stock') throw new Error('Expired options are available for indices only.');
    if (!this.usable()) throw new Error('Expired options need the INDstocks connection.');
    const out = new Set(), day = (ms) => new Date(ms + 19800e3).toISOString().slice(0, 10);
    for (let k = 0; k < 2; k++) {
      const to = Date.now() - k * 365 * 864e5, from = to - 364 * 864e5;
      const j = await this.get(`/market/instruments/expired/expiries?underlying=${encodeURIComponent(symbol)}&segment=DERIVATIVE&expiry_from=${day(from)}&expiry_to=${day(to)}`, 6 * 3600e3);
      (j.data || []).forEach((d) => out.add(d));
    }
    return [...out].filter((d) => d < day(Date.now() + 864e5)).sort().reverse();
  }
  async expiredContracts(symbol, expiry) {
    const j = await this.get(`/market/instruments/expired/contracts?underlying=${encodeURIComponent(symbol)}&segment=DERIVATIVE&expiry=${expiry}`, 24 * 3600e3);
    return (j.data || []).filter((x) => x.option_type === 'CE' || x.option_type === 'PE').map((x) => ({ symbol: x.trading_symbol, strike: Number(x.strike_price), type: x.option_type }));
  }
  // range: day (minutes on expiry day), week (5-minute, last 7 days), life (hourly over the last month before expiry).
  async expiredCandles(tradingSymbol, expiry, range = 'week', segment = /^(SENSEX|BANKEX)/.test(tradingSymbol) ? 'BFO' : 'NFO') {
    if (!/^[A-Z0-9-]+$/.test(tradingSymbol || '') || !/^\d{4}-\d{2}-\d{2}$/.test(expiry || '')) throw new Error('Pick an expired contract.');
    const [interval, days] = EXPIRED_RANGES[range] || EXPIRED_RANGES.week;
    const end = Date.parse(expiry + 'T23:59:00+05:30');
    const candles = await this.candles(`/market/historical/expired/${interval}?trading-symbols=${tradingSymbol}&segment=${segment}`, tradingSymbol, interval, end - days * 864e5, end, 24 * 3600e3);
    return { candles, interval };
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
    }, this.fallback(symbol, () => this.nse.daily(symbol, days)));
  }
}
