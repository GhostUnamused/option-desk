// Paper trading account: realistic fills (buy at ask, sell at bid), charges, margin estimate,
// netting, realized/unrealized P&L, expiry settlement and an equity curve. Stored in data/paper.json.
// The clock is injectable (opts.now) so the replay account can run on historical days; file null keeps it in memory.
import fs from 'node:fs';
import path from 'node:path';
import { INDICES, PAPER } from './config.js';
import { intrinsic } from '../public/js/bs.js';

const keyOf = (l) => `${l.symbol}|${l.expiry}|${l.strike}|${l.type}`;
const round2 = (x) => Math.round(x * 100) / 100;

export function legCharges(side, premium) {
  const brokerage = PAPER.brokeragePerOrder;
  const stt = side === 'SELL' ? premium * PAPER.sttSellPct : 0;
  const exch = premium * PAPER.exchangePct;
  const sebi = premium * PAPER.sebiPerCrore / 1e7;
  const gst = (brokerage + exch + sebi) * PAPER.gstPct;
  const stamp = side === 'BUY' ? premium * PAPER.stampBuyPct : 0;
  return round2(brokerage + stt + exch + sebi + gst + stamp);
}

// Margin estimate per underlying+expiry: worst expiry loss within a ±scan move, plus exposure on net short units.
export function marginFor(positions, spots) {
  const groups = new Map();
  for (const p of positions) { const g = `${p.symbol}|${p.expiry}`; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  let total = 0;
  for (const [g, ps] of groups) {
    const S = spots[g.split('|')[0]]; if (!S) continue;
    let worst = 0;
    for (let i = 0; i <= 120; i++) {
      const x = S * (1 - PAPER.marginScanPct + (2 * PAPER.marginScanPct * i) / 120);
      const value = ps.reduce((s, p) => s + p.qty * intrinsic(p.type, x, p.strike), 0);
      worst = Math.max(worst, -value);
    }
    let exposureUnits = 0;
    for (const t of ['CE', 'PE']) {
      const short = ps.filter((p) => p.type === t && p.qty < 0).reduce((s, p) => s - p.qty, 0);
      const long = ps.filter((p) => p.type === t && p.qty > 0).reduce((s, p) => s + p.qty, 0);
      exposureUnits += Math.max(0, short - long);
    }
    total += worst + exposureUnits * S * PAPER.exposurePct;
  }
  return round2(total);
}

export class PaperAccount {
  constructor(file, provider, opts = {}) {
    this.file = file; this.provider = provider; this.now = opts.now || Date.now;
    this.state = this.load();
  }

  istToday() { return new Date(this.now() + 5.5 * 3600e3).toISOString().slice(0, 10); }
  expired(expiry) { return this.now() >= Date.parse(expiry + 'T15:30:00+05:30'); }

  fresh(balance = PAPER.startBalance) {
    return { version: 1, createdAt: new Date(this.now()).toISOString(), startBalance: balance, cash: balance, realized: 0, charges: 0, positions: [], orders: [], equity: [{ t: this.now(), v: balance }] };
  }

  load() {
    if (!this.file) return this.fresh();
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { const s = this.fresh(); this.write(s); return s; }
  }

  write(s = this.state) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, this.file);
  }

  reset(balance) {
    const b = Number(balance) > 0 ? Math.round(Number(balance)) : PAPER.startBalance;
    this.state = this.fresh(b); this.write(); return this.state;
  }

  async quote(l) {
    const ch = await this.provider.chain(l.symbol, l.expiry);
    const row = ch.rows.find((r) => r.strike === Number(l.strike));
    const o = row && (l.type === 'CE' ? row.ce : row.pe);
    if (!o) throw new Error(`No quote for ${l.symbol} ${l.expiry} ${l.strike} ${l.type}`);
    const mid = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.ltp;
    return { ...o, mid, spot: ch.spot };
  }

  async spots() {
    const { indices } = await this.provider.indices();
    return Object.fromEntries(indices.map((i) => [i.symbol, i.last]));
  }

  // Apply a fill to a positions array (mutates). Returns realized P&L from this fill. l.lot, when given, is the contract's lot size.
  static applyFill(positions, l, dq, price, t = Date.now()) {
    const k = keyOf(l); let p = positions.find((x) => x.key === k); let realized = 0;
    if (!p) { p = { key: k, symbol: l.symbol, expiry: l.expiry, strike: Number(l.strike), type: l.type, qty: 0, avg: 0, lot: l.lot || INDICES[l.symbol].lot, openedAt: t }; positions.push(p); }
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(dq)) {
      p.avg = (p.avg * Math.abs(p.qty) + price * Math.abs(dq)) / (Math.abs(p.qty) + Math.abs(dq));
      p.qty += dq;
    } else {
      const closing = Math.min(Math.abs(dq), Math.abs(p.qty));
      realized = (price - p.avg) * closing * Math.sign(p.qty);
      const before = p.qty; p.qty += dq;
      if (p.qty !== 0 && Math.sign(p.qty) !== Math.sign(before)) p.avg = price;
    }
    if (p.qty === 0) positions.splice(positions.indexOf(p), 1);
    return realized;
  }

  // Simulate a basket of legs without saving it.
  async preview(legs) {
    if (!Array.isArray(legs) || !legs.length) throw new Error('Add at least one leg.');
    const fills = [];
    for (const l of legs) {
      if (!INDICES[l.symbol]) throw new Error(`Unknown index ${l.symbol}`);
      if (!['CE', 'PE'].includes(l.type) || !['BUY', 'SELL'].includes(l.side)) throw new Error('Each leg needs a type (CE/PE) and a side (BUY/SELL).');
      const lots = Math.round(Number(l.lots)); if (!(lots >= 1)) throw new Error('Lots must be a whole number of at least 1.');
      if (this.expired(l.expiry)) throw new Error(`The ${l.expiry} expiry has already settled.`);
      const q = await this.quote(l);
      this.checkQuote(l, q);
      const price = l.side === 'BUY' ? (q.ask > 0 ? q.ask : q.ltp) : (q.bid > 0 ? q.bid : q.ltp);
      if (!(price > 0)) throw new Error(`No ${l.side === 'BUY' ? 'sellers' : 'buyers'} quoted for ${l.strike} ${l.type} right now.`);
      const lot = q.lot || INDICES[l.symbol].lot;
      const qty = lots * lot;
      const premium = price * qty;
      fills.push({ ...l, strike: Number(l.strike), lots, lot, qty, price, premium: round2(premium), charges: legCharges(l.side, premium), id: q.id });
    }
    const spots = await this.spots();
    const positions = this.state.positions.map((p) => ({ ...p }));
    const marginBefore = marginFor(positions, spots);
    let cash = this.state.cash; let realized = 0;
    for (const f of fills) {
      const dq = f.side === 'BUY' ? f.qty : -f.qty;
      realized += PaperAccount.applyFill(positions, f, dq, f.price);
      cash -= dq * f.price + f.charges;
    }
    const marginAfter = marginFor(positions, spots);
    const shortsValue = async (ps) => { let v = 0; for (const p of ps.filter((x) => x.qty < 0)) v += p.qty * (await this.quote(p)).mid; return v; };
    const availBefore = this.state.cash + (await shortsValue(this.state.positions)) - marginBefore;
    const availAfter = cash + (await shortsValue(positions)) - marginAfter;
    const net = fills.reduce((s, f) => s + (f.side === 'BUY' ? -f.premium : f.premium), 0);
    return { fills, netPremium: round2(net), charges: round2(fills.reduce((s, f) => s + f.charges, 0)), marginBefore, marginAfter, availableBefore: round2(availBefore), availableAfter: round2(availAfter), realized: round2(realized), ok: availAfter >= 0 || availAfter >= availBefore };
  }

  // Hook for accounts with extra fill rules (the replay account rejects strikes that did not trade).
  checkQuote() {}

  async place(legs, tag = '', note = '') {
    await this.settle();
    const pv = await this.preview(legs);
    if (!pv.ok) throw new Error(`Not enough funds: this needs about ₹${Math.round(-pv.availableAfter + pv.availableBefore).toLocaleString('en-IN')} but ₹${Math.round(pv.availableBefore).toLocaleString('en-IN')} is available.`);
    const st = this.state; const t = this.now(); const basket = `B${Date.now()}`;
    note = String(note || '').trim().slice(0, 1000);
    for (const f of pv.fills) {
      const dq = f.side === 'BUY' ? f.qty : -f.qty;
      const realized = PaperAccount.applyFill(st.positions, f, dq, f.price, t);
      st.cash = round2(st.cash - dq * f.price - f.charges);
      st.realized = round2(st.realized + realized);
      st.charges = round2(st.charges + f.charges);
      st.orders.push({ id: `${basket}-${st.orders.length}`, basket, t, symbol: f.symbol, expiry: f.expiry, strike: f.strike, type: f.type, side: f.side, lots: f.lots, qty: f.qty, price: f.price, charges: f.charges, realized: round2(realized), tag, ...(note ? { note } : {}) });
    }
    this.write();
    await this.snapshot(true);
    return pv;
  }

  async exit(key) {
    const p = this.state.positions.find((x) => x.key === key);
    if (!p) throw new Error('That position is already closed.');
    return this.place([{ symbol: p.symbol, expiry: p.expiry, strike: p.strike, type: p.type, side: p.qty > 0 ? 'SELL' : 'BUY', lots: Math.abs(p.qty) / p.lot }], 'Exit');
  }

  // Settle positions whose expiry has passed, at intrinsic value against the index close.
  async settle() {
    const due = this.state.positions.filter((p) => this.expired(p.expiry));
    if (!due.length) return;
    for (const p of due) {
      let close = null;
      if (p.expiry === this.istToday()) { close = (await this.spots())[p.symbol]; }
      else { const d = await this.provider.daily(p.symbol, 45); const row = d.filter((x) => x.date <= p.expiry).pop(); close = row?.c ?? null; }
      if (close == null) continue;
      const value = intrinsic(p.type, close, p.strike);
      const realized = (value - p.avg) * p.qty;
      this.state.cash = round2(this.state.cash + p.qty * value);
      this.state.realized = round2(this.state.realized + realized);
      this.state.orders.push({ id: `S${Date.now()}-${this.state.orders.length}`, t: this.now(), symbol: p.symbol, expiry: p.expiry, strike: p.strike, type: p.type, side: p.qty > 0 ? 'SELL' : 'BUY', lots: Math.abs(p.qty) / p.lot, qty: Math.abs(p.qty), price: round2(value), charges: 0, realized: round2(realized), tag: `Expiry settlement at ${close}` });
      this.state.positions.splice(this.state.positions.indexOf(p), 1);
    }
    this.write();
  }

  async summary() {
    await this.settle();
    const st = this.state; const spots = await this.spots();
    const positions = [];
    let longValue = 0, shortValue = 0, unrealized = 0;
    for (const p of st.positions) {
      let q = null; try { q = await this.quote(p); } catch {}
      const mark = q ? q.mid : p.avg;
      const pnl = (mark - p.avg) * p.qty;
      unrealized += pnl;
      if (p.qty > 0) longValue += p.qty * mark; else shortValue += p.qty * mark;
      positions.push({ ...p, lots: Math.abs(p.qty) / p.lot, ltp: q?.ltp ?? null, bid: q?.bid ?? null, ask: q?.ask ?? null, mark: round2(mark), iv: q?.iv ?? null, pnl: round2(pnl), id: q?.id || '' });
    }
    const margin = marginFor(st.positions, spots);
    const equity = st.cash + longValue + shortValue;
    await this.snapshot(false, equity);
    return {
      startBalance: st.startBalance, cash: round2(st.cash), equity: round2(equity), totalPnl: round2(equity - st.startBalance),
      realized: st.realized, unrealized: round2(unrealized), charges: st.charges, margin, available: round2(st.cash + shortValue - margin),
      positions, orders: st.orders.slice(-200).reverse(), equityCurve: st.equity, createdAt: st.createdAt, spots,
    };
  }

  async snapshot(force, equity) {
    const eq = this.state.equity; const last = eq[eq.length - 1];
    if (!force && last && this.now() - last.t < 120e3) return;
    if (equity == null) {
      let v = this.state.cash;
      for (const p of this.state.positions) { try { v += p.qty * (await this.quote(p)).mid; } catch { v += p.qty * p.avg; } }
      equity = v;
    }
    eq.push({ t: this.now(), v: round2(equity) });
    if (eq.length > 3000) eq.splice(0, eq.length - 3000);
    this.write();
  }
}
