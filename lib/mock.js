// Simulated market for trying the app when NSE is unreachable (start with MOCK=1).
// Prices move on a random walk; option prices come from Black–Scholes with a volatility skew.
import { INDICES } from './config.js';
import { bs, yearsTo } from '../public/js/bs.js';

const BASE_LEVEL = { NIFTY: 22650, BANKNIFTY: 55400, FINNIFTY: 25200, MIDCPNIFTY: 13700, NIFTYNXT50: 68600 };
const istNow = () => new Date(Date.now() + 5.5 * 3600e3); // IST wall clock in UTC fields
const isoDay = (d) => d.toISOString().slice(0, 10);

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export class MockProvider {
  constructor() {
    this.name = 'Simulated';
    this.state = {};
    const r = rng(42);
    for (const s of Object.keys(INDICES)) {
      const prev = BASE_LEVEL[s];
      this.state[s] = { prev, open: prev * (1 + gauss(r) * 0.002), path: [] };
    }
    this.vix = { prev: 14.6, last: 14.2 };
    this.started = Date.now();
    this.r = rng(7);
  }

  level(symbol) {
    const st = this.state[symbol];
    const now = istNow();
    const open = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 15));
    let t = Math.floor(open.getTime() / 1000);
    const end = Math.floor(now.getTime() / 1000);
    if (!st.path.length) st.path.push({ t, v: st.open });
    let last = st.path[st.path.length - 1];
    while (last.t + 60 <= end) {
      const v = last.v * (1 + gauss(this.r) * 0.0007);
      last = { t: last.t + 60, v };
      st.path.push(last);
    }
    const jitter = last.v * (1 + gauss(this.r) * 0.00015);
    return jitter;
  }

  async indices() {
    const indices = Object.entries(INDICES).map(([symbol, cfg]) => {
      const st = this.state[symbol]; const last = this.level(symbol);
      const vs = st.path.map((p) => p.v);
      return { symbol, ...cfg, last: +last.toFixed(2), change: +(last - st.prev).toFixed(2), pct: +((last / st.prev - 1) * 100).toFixed(2), open: +st.open.toFixed(2), high: +Math.max(...vs, last).toFixed(2), low: +Math.min(...vs, last).toFixed(2), prevClose: st.prev, yearHigh: st.prev * 1.16, yearLow: st.prev * 0.98 };
    });
    this.vix.last = Math.max(9, this.vix.last + gauss(this.r) * 0.02);
    return { indices, vix: { symbol: 'INDIAVIX', name: 'INDIA VIX', short: 'INDIA VIX', last: +this.vix.last.toFixed(2), change: +(this.vix.last - this.vix.prev).toFixed(2), pct: +((this.vix.last / this.vix.prev - 1) * 100).toFixed(2), prevClose: this.vix.prev }, asOf: null };
  }

  async marketStatus() {
    const n = istNow(); const mins = n.getUTCHours() * 60 + n.getUTCMinutes(); const wd = n.getUTCDay();
    const open = wd >= 1 && wd <= 5 && mins >= 555 && mins < 930;
    return { open: true, status: open ? 'Open' : 'Simulated', message: 'Simulated market (MOCK mode)', tradeDate: '' };
  }

  async expiries(symbol) {
    const n = istNow(); const out = [];
    const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
    while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
    const weekly = symbol === 'NIFTY';
    for (let i = 0; out.length < (weekly ? 4 : 3) && i < 120; i++) {
      const next = new Date(d); next.setUTCDate(d.getUTCDate() + 7);
      const lastOfMonth = next.getUTCMonth() !== d.getUTCMonth();
      if (weekly || lastOfMonth) out.push(isoDay(d));
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return out;
  }

  async chain(symbol, expiry) {
    const spot = this.level(symbol); const cfg = INDICES[symbol];
    const T = Math.max(yearsTo(expiry), 0.5 / 365); const atm = Math.round(spot / cfg.step) * cfg.step;
    const rows = [];
    const r = rng(symbol.length * 97 + expiry.length);
    for (let i = -40; i <= 40; i++) {
      const K = atm + i * cfg.step; const m = Math.log(K / spot);
      const iv = Math.max(0.08, 0.135 - 0.9 * m + 4 * m * m);
      const mk = (type) => {
        const p = bs(type, spot, K, T, 0.06, iv).price; const ltp = Math.max(0.05, Math.round(p * 20) / 20);
        const spr = Math.max(0.05, Math.round(ltp * 0.004 * 20) / 20);
        const otm = type === 'CE' ? K > spot : K < spot;
        const oi = Math.round((otm ? 1 : 0.15) * 400000 * Math.exp(-Math.abs(i) / 9) * (K % (cfg.step * 4) === 0 ? 2.2 : 1) * (0.6 + r()));
        const chg = +(ltp * (r() - 0.5) * 0.4).toFixed(2);
        return { oi, chgOi: Math.round(oi * (r() - 0.35) * 0.6), vol: Math.round(oi * (4 + r() * 8)), iv: +(iv * 100).toFixed(2), ltp, chg, pchg: ltp - chg > 0 ? +(chg / (ltp - chg) * 100).toFixed(2) : 0, bid: +(ltp - spr).toFixed(2) > 0 ? +(ltp - spr).toFixed(2) : 0.05, ask: +(ltp + spr).toFixed(2), bidQty: 1000, askQty: 1000, id: `OPTIDX${symbol}${expiry.split('-').reverse().join('-')}${type}${K.toFixed(2)}` };
      };
      rows.push({ strike: K, ce: mk('CE'), pe: mk('PE') });
    }
    return { symbol, expiry, spot: +spot.toFixed(2), timestamp: istNow().toISOString().slice(11, 19), rows };
  }

  async intraday(symbol) {
    if (symbol === 'INDIAVIX') { const r = rng(3); let v = this.vix.prev; const pts = []; const s = this.state.NIFTY.path; for (const p of s) { v += gauss(r) * 0.03; pts.push({ t: p.t, v: +v.toFixed(2) }); } return { prevClose: this.vix.prev, points: pts }; }
    this.level(symbol);
    return { prevClose: this.state[symbol].prev, points: this.state[symbol].path.map((p) => ({ t: p.t, v: +p.v.toFixed(2) })) };
  }

  async optionIntraday(identifier) {
    const m = identifier.match(/^OPTIDX([A-Z0-9]+?)(\d{2})-(\d{2})-(\d{4})(CE|PE)([\d.]+)$/);
    if (!m) return { prevClose: null, points: [] };
    const [, symbol, dd, mm, yyyy, type, k] = m; const expiry = `${yyyy}-${mm}-${dd}`;
    this.level(symbol);
    const pts = this.state[symbol].path.map((p) => { const T = Math.max(yearsTo(expiry, (p.t - 5.5 * 3600) * 1000), 0.5 / 365); return { t: p.t, v: +bs(type, p.v, +k, T, 0.06, 0.135).price.toFixed(2) }; });
    return { prevClose: pts[0]?.v ?? null, points: pts };
  }

  async daily(symbol, days = 365) {
    const isVix = symbol === 'INDIAVIX'; const r = rng(isVix ? 11 : symbol.length * 13);
    const end = new Date(); const out = [];
    let v = isVix ? 13 : (BASE_LEVEL[symbol] || 20000) * 1.08;
    for (let i = days; i >= 1; i--) {
      const d = new Date(end.getTime() - i * 864e5); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const o = v; v = isVix ? Math.max(9, v + gauss(r) * 0.5 + (13 - v) * 0.05) : v * (1 + gauss(r) * 0.009 - 0.0003);
      const h = Math.max(o, v) * (1 + r() * 0.004), l = Math.min(o, v) * (1 - r() * 0.004);
      out.push({ date: isoDay(d), o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +v.toFixed(2) });
    }
    if (!isVix && out.length) out[out.length - 1].c = this.state[symbol].prev;
    return out;
  }
}
