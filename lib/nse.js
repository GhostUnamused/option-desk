// NSE data provider. Talks to the same JSON endpoints nseindia.com uses in the browser.
// These endpoints are unofficial: NSE can rate-limit them or change them without notice.
import { INDICES, VIX_NAME } from './config.js';

const BASE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

// "13-Oct-2026" or "12-OCT-2026" -> "2026-10-13"
export function nseDateToISO(s) {
  const [d, m, y] = s.split('-');
  return `${y}-${MON[m.toUpperCase()]}-${d.padStart(2, '0')}`;
}
// "2026-10-13" -> "13-Oct-2026"
export function isoToNse(iso) {
  const [y, m, d] = iso.split('-');
  const name = Object.keys(MON).find((k) => MON[k] === m);
  return `${d}-${name[0]}${name.slice(1).toLowerCase()}-${y}`;
}
const ddmmyyyy = (dt) => `${String(dt.getUTCDate()).padStart(2, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${dt.getUTCFullYear()}`;

// NSE's website is only used when the person has chosen it (the server closes this gate until then). Open by default so
// tests and other callers behave as before.
export const nseGate = { open: true };
const checkGate = () => { if (!nseGate.open) throw new Error('NSE website data is switched off. Connect a broker, or choose "Use NSE website data" in the Data menu.'); };

export class NseProvider {
  constructor() {
    this.cookies = new Map();
    this.warmedAt = 0;
    this.warming = null;
    this.cache = new Map();
    this.inflight = new Map();
    this.lastCall = 0;
    this.name = 'NSE';
  }

  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/);
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async warm(force = false) {
    checkGate();
    if (!force && Date.now() - this.warmedAt < 4 * 60 * 1000 && this.cookies.size) return;
    if (this.warming) return this.warming;
    this.warming = (async () => {
      if (force) this.cookies.clear();
      for (const path of ['/', '/option-chain']) {
        const res = await fetch(BASE + path, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Cookie: this.cookieHeader() },
          redirect: 'follow',
        });
        this.absorb(res);
        await res.arrayBuffer();
      }
      this.warmedAt = Date.now();
    })().finally(() => { this.warming = null; });
    return this.warming;
  }

  async raw(path, retry = true) {
    checkGate();
    await this.warm();
    const wait = Math.max(0, this.lastCall + 120 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
    const res = await fetch(BASE + path, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', Referer: BASE + '/option-chain', Cookie: this.cookieHeader() },
    });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok || json === null) {
      if (retry) { await this.warm(true); return this.raw(path, false); }
      throw new Error(`NSE answered ${res.status} for ${path.split('?')[0]}`);
    }
    return json;
  }

  // Cached, de-duplicated JSON fetch.
  async get(path, ttlMs) {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    if (this.inflight.has(path)) return this.inflight.get(path);
    const p = this.raw(path).then((data) => { this.cache.set(path, { at: Date.now(), data }); return data; })
      .catch((e) => { if (hit) return hit.data; throw e; })
      .finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  async indices() {
    const j = await this.get('/api/allIndices', 4000);
    const byName = new Map(j.data.map((d) => [d.index, d]));
    const pick = (d) => d && { last: d.last, change: d.variation, pct: d.percentChange, open: d.open, high: d.high, low: d.low, prevClose: d.previousClose, yearHigh: d.yearHigh, yearLow: d.yearLow };
    const out = Object.entries(INDICES).map(([symbol, cfg]) => ({ symbol, ...cfg, ...pick(byName.get(cfg.name)) })).filter((x) => x.last != null);
    const v = byName.get(VIX_NAME);
    return { indices: out, vix: v ? { symbol: 'INDIAVIX', name: VIX_NAME, short: 'INDIA VIX', ...pick(v) } : null, asOf: j.timestamp || null };
  }

  async marketStatus() {
    const j = await this.get('/api/marketStatus', 30000);
    const cm = (j.marketState || []).find((m) => m.market === 'Capital Market') || {};
    return { open: /open/i.test(cm.marketStatus || ''), status: cm.marketStatus || 'Unknown', message: cm.marketStatusMessage || '', tradeDate: cm.tradeDate || '' };
  }

  async expiries(symbol) {
    const j = await this.get(`/api/option-chain-contract-info?symbol=${encodeURIComponent(symbol)}`, 3600e3);
    return (j.expiryDates || []).map(nseDateToISO);
  }

  async chain(symbol, expiryISO) {
    const j = await this.get(`/api/option-chain-v3?type=Indices&symbol=${encodeURIComponent(symbol)}&expiry=${isoToNse(expiryISO)}`, 4000);
    const side = (o) => o && ({
      oi: o.openInterest || 0, chgOi: o.changeinOpenInterest || 0, vol: o.totalTradedVolume || 0, iv: o.impliedVolatility || 0,
      ltp: o.lastPrice || 0, chg: o.change || 0, pchg: o.pChange || 0, bid: o.buyPrice1 || 0, ask: o.sellPrice1 || 0,
      bidQty: o.buyQuantity1 || 0, askQty: o.sellQuantity1 || 0, id: o.identifier || '',
    });
    const rows = (j.records?.data || []).map((d) => ({ strike: d.strikePrice, ce: side(d.CE), pe: side(d.PE) })).sort((a, b) => a.strike - b.strike);
    return { symbol, expiry: expiryISO, spot: j.records?.underlyingValue ?? null, timestamp: j.records?.timestamp || null, rows };
  }

  // Intraday index line. NSE encodes IST wall-clock time as if it were UTC.
  async intraday(symbol) {
    const name = symbol === 'INDIAVIX' ? VIX_NAME : INDICES[symbol].name;
    const j = await this.get(`/api/NextApi/apiClient/indexTrackerApi?functionName=getIndexChart&&index=${encodeURIComponent(name)}&flag=1D`, 10000);
    const g = j.data?.grapthData || [];
    const seen = new Set(); const pts = [];
    for (const p of g) { if (p[2] === 'PO') continue; const t = Math.floor(p[0] / 1000); if (seen.has(t)) continue; seen.add(t); pts.push({ t, v: p[1] }); }
    return { prevClose: j.data?.closePrice ?? null, points: pts };
  }

  async optionIntraday(identifier) {
    const j = await this.get(`/api/chart-databyindex?index=${encodeURIComponent(identifier)}`, 10000);
    const seen = new Set(); const pts = [];
    for (const p of j.grapthData || []) { const t = Math.floor(p[0] / 1000); if (seen.has(t)) continue; seen.add(t); pts.push({ t, v: p[1] }); }
    return { prevClose: j.closePrice ?? null, points: pts };
  }

  // Daily OHLC, fetched in 90-day windows (NSE caps each request).
  async daily(symbol, days = 365) {
    const isVix = symbol === 'INDIAVIX';
    const name = isVix ? null : INDICES[symbol].name;
    const end = new Date(); const out = new Map();
    for (let back = 0; back < days; back += 90) {
      const to = new Date(end.getTime() - back * 864e5), from = new Date(end.getTime() - Math.min(days, back + 89) * 864e5);
      const path = isVix
        ? `/api/historicalOR/vixhistory?from=${ddmmyyyy(from)}&to=${ddmmyyyy(to)}`
        : `/api/historicalOR/indicesHistory?indexType=${encodeURIComponent(name)}&from=${ddmmyyyy(from)}&to=${ddmmyyyy(to)}`;
      const j = await this.get(path, back === 0 ? 15 * 60e3 : 12 * 3600e3);
      for (const d of j.data || []) {
        const date = nseDateToISO(d.EOD_TIMESTAMP);
        out.set(date, { date, o: +d.EOD_OPEN_INDEX_VAL, h: +d.EOD_HIGH_INDEX_VAL, l: +d.EOD_LOW_INDEX_VAL, c: +d.EOD_CLOSE_INDEX_VAL });
      }
    }
    return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
