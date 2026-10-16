// Paper trading account: realistic fills (buy at ask, sell at bid), charges, margin estimate,
// netting, realized/unrealized P&L, expiry settlement and an equity curve. Stored in data/paper.json.
// The clock is injectable (opts.now) so the replay account can run on historical days; file null keeps it in memory.
import fs from 'node:fs';
import path from 'node:path';
import { INDICES, PAPER, CHARGES, RISK_FREE, rateOn } from './config.js';
import { bs, intrinsic, yearsTo } from '../public/js/bs.js';

const keyOf = (l) => `${l.symbol}|${l.expiry}|${l.strike}|${l.type}`;
const round2 = (x) => Math.round(x * 100) / 100;

// Charges for one executed order (one leg), itemised, at the rates in force on `date` (ISO). See CHARGES in config.js.
export function legCharges(side, premium, date, exch = 'NSE') {
  const brokerage = CHARGES.brokeragePerOrder;
  const stt = side === 'SELL' ? premium * rateOn(CHARGES.sttSell, date) : 0;
  const exchange = premium * rateOn(exch === 'BSE' ? CHARGES.exchangeBse : CHARGES.exchange, date);
  const sebi = premium * rateOn(CHARGES.sebiPerCrore, date) / 1e7;
  const stamp = side === 'BUY' ? premium * rateOn(CHARGES.stampBuy, date) : 0;
  const gst = (brokerage + exchange + sebi) * rateOn(CHARGES.gst, date);
  return itemise({ brokerage, stt, exchange, sebi, stamp, gst });
}

// Charges when a position is settled at expiry. Out of the money it simply lapses: no trade, no charges. In the money the
// exchange closes it at its settlement value; brokers charge brokerage on that, and a bought option pays exercise STT.
export function settlementCharges(qty, value, date) {
  if (!(value > 0)) return itemise({});
  const brokerage = CHARGES.brokeragePerOrder;
  const stt = qty > 0 ? value * qty * rateOn(CHARGES.sttExercise, date) : 0;
  return itemise({ brokerage, stt, gst: brokerage * rateOn(CHARGES.gst, date) });
}

const PARTS = ['brokerage', 'stt', 'exchange', 'sebi', 'stamp', 'gst'];
function itemise(c) {
  const parts = Object.fromEntries(PARTS.map((k) => [k, round2(c[k] || 0)]));
  return { total: round2(PARTS.reduce((s, k) => s + (c[k] || 0), 0)), parts };
}

// Margin estimate per underlying+expiry: worst expiry loss within a ±scan move, plus exposure on net short units.
export function marginFor(positions, spots) {
  const groups = new Map();
  for (const p of positions) { const g = `${p.symbol}|${p.expiry}`; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  let total = 0;
  for (const [g, ps] of groups) {
    const S = spots[g.split('|')[0]]; if (!S) continue;
    const scan = INDICES[g.split('|')[0]]?.kind === 'stock' ? PAPER.marginScanPctStock : PAPER.marginScanPct;
    let worst = 0;
    for (let i = 0; i <= 120; i++) {
      const x = S * (1 - scan + (2 * scan * i) / 120);
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

// Add up itemised charges (orders placed before itemising have none and are skipped).
export function sumParts(list) {
  const out = Object.fromEntries(PARTS.map((k) => [k, 0]));
  for (const p of list) if (p) for (const k of PARTS) out[k] += p[k] || 0;
  for (const k of PARTS) out[k] = round2(out[k]);
  return out;
}

export class PaperAccount {
  constructor(file, provider, opts = {}) {
    this.file = file; this.provider = provider; this.now = opts.now || Date.now;
    this.state = this.load(); this.exitCheck = null; this.exiting = new Set();
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
    return { ...o, mid, spot: ch.spot, lot: o.lot || ch.lot };
  }

  async spots() {
    const { indices } = await this.provider.indices();
    return Object.fromEntries(indices.map((i) => [i.symbol, i.last]));
  }

  riskFreeRate() { return this.provider.engine?.riskFree?.() ?? RISK_FREE; }

  explainClose(p, f, units, gross, entryCharges, exitCharges, t) {
    const e = p.learnEntry;
    if (!e || !(e.iv > 0) || !(e.spot > 0) || !(f.spot > 0)) return null;
    const r = this.riskFreeRate(), T0 = yearsTo(p.expiry, e.t), T1 = yearsTo(p.expiry, t);
    if (!(f.iv > 0) && T1 > 1e-8) return null;
    const value = (spot, time, iv) => bs(p.type, spot, p.strike, time, r, iv).price;
    const start = value(e.spot, T0, e.iv), moved = value(f.spot, T0, e.iv);
    const aged = value(f.spot, T1, e.iv), volChanged = value(f.spot, T1, f.iv > 0 ? f.iv / 100 : e.iv);
    const direction = Math.sign(p.qty), scale = units * direction;
    const spot = round2((moved - start) * scale), time = round2((aged - moved) * scale);
    const volatility = round2((volChanged - aged) * scale);
    const residual = round2(gross - spot - time - volatility);
    const net = round2(gross - entryCharges - exitCharges);
    return { gross: round2(gross), spot, time, volatility, residual, entryCharges: round2(entryCharges), exitCharges: round2(exitCharges), netAfterCharges: net,
      note: 'Model estimate: price, time and volatility effects are separated in that order. The remainder includes bid–ask, fills and model differences.' };
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
      if (!INDICES[l.symbol]) throw new Error(`Unknown underlying ${l.symbol}`);
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
      const c = legCharges(l.side, premium, this.istToday(), INDICES[l.symbol].exchange);
      fills.push({ ...l, strike: Number(l.strike), lots, lot, qty, price, premium: round2(premium), charges: c.total, chargeParts: c.parts, id: q.id,
        spot: q.spot, iv: q.iv || 0 });
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
    const chargeParts = sumParts(fills.map((f) => f.chargeParts));
    return { fills, netPremium: round2(net), charges: round2(fills.reduce((s, f) => s + f.charges, 0)), chargeParts, marginBefore, marginAfter, availableBefore: round2(availBefore), availableAfter: round2(availAfter), realized: round2(realized), ok: availAfter >= 0 || availAfter >= availBefore };
  }

  // Hook for accounts with extra fill rules (the replay account rejects strikes that did not trade).
  checkQuote() {}

  async place(legs, tag = '', note = '', plan = '') {
    await this.settle();
    const pv = await this.preview(legs);
    if (!pv.ok) throw new Error(`Not enough funds: this needs about ₹${Math.round(-pv.availableAfter + pv.availableBefore).toLocaleString('en-IN')} but ₹${Math.round(pv.availableBefore).toLocaleString('en-IN')} is available.`);
    const st = this.state; const t = this.now(); const basket = `B${Date.now()}`;
    note = String(note || '').trim().slice(0, 1000);
    plan = String(plan || '').trim().slice(0, 1000);
    for (const f of pv.fills) {
      const dq = f.side === 'BUY' ? f.qty : -f.qty;
      const key = keyOf(f), before = st.positions.find((x) => x.key === key) || null;
      const beforeQty = before?.qty || 0;
      const closeUnits = before && beforeQty && Math.sign(beforeQty) !== Math.sign(dq) ? Math.min(Math.abs(beforeQty), Math.abs(dq)) : 0;
      const closeGross = closeUnits ? (f.price - before.avg) * closeUnits * Math.sign(beforeQty) : 0;
      const entryCharges = closeUnits && before.learnEntry ? before.learnEntry.charges * closeUnits / Math.abs(beforeQty) : 0;
      const explanation = closeUnits ? this.explainClose(before, f, closeUnits, closeGross, entryCharges, f.charges, t) : null;
      const realized = PaperAccount.applyFill(st.positions, f, dq, f.price, t);
      const after = st.positions.find((x) => x.key === key) || null;
      if (after && before && beforeQty && Math.sign(after.qty) !== Math.sign(beforeQty)) delete after.exitRules;
      const modelEntry = { spot: Number(f.spot) || 0, iv: (Number(f.iv) || 0) / 100, t, charges: f.charges };
      if (after && (!before || beforeQty === 0 || (Math.sign(beforeQty) !== Math.sign(dq) && Math.abs(dq) > Math.abs(beforeQty)))) {
        const openedUnits = !before || beforeQty === 0 ? Math.abs(dq) : Math.abs(dq) - closeUnits;
        after.learnEntry = { ...modelEntry, charges: round2(f.charges * openedUnits / Math.abs(dq)) };
      } else if (after && before && Math.sign(beforeQty) === Math.sign(dq)) {
        const oldUnits = Math.abs(beforeQty), newUnits = Math.abs(dq), total = oldUnits + newUnits, old = before.learnEntry;
        if (old && modelEntry.iv > 0 && modelEntry.spot > 0) after.learnEntry = {
          spot: (old.spot * oldUnits + modelEntry.spot * newUnits) / total,
          iv: (old.iv * oldUnits + modelEntry.iv * newUnits) / total,
          t: Math.round((old.t * oldUnits + t * newUnits) / total),
          charges: round2(old.charges + f.charges),
        };
      } else if (after && before && closeUnits && after.learnEntry) {
        after.learnEntry.charges = round2(Math.max(0, after.learnEntry.charges - entryCharges));
      }
      st.cash = round2(st.cash - dq * f.price - f.charges);
      st.realized = round2(st.realized + realized);
      st.charges = round2(st.charges + f.charges);
      st.orders.push({ id: `${basket}-${st.orders.length}`, basket, t, symbol: f.symbol, expiry: f.expiry, strike: f.strike, type: f.type, side: f.side, lots: f.lots, qty: f.qty, price: f.price, charges: f.charges, chargeParts: f.chargeParts, realized: round2(realized), tag,
        ...(note ? { note } : {}), ...(plan ? { plan } : {}), ...(explanation ? { explanation } : {}) });
    }
    this.write();
    await this.snapshot(true);
    return pv;
  }

  async exit(key) {
    const p = this.state.positions.find((x) => x.key === key);
    if (!p) throw new Error('That position is already closed.');
    if (this.exiting.has(key)) throw new Error('An automatic exit is already in progress for this position.');
    this.exiting.add(key);
    try {
      return await this.place([{ symbol: p.symbol, expiry: p.expiry, strike: p.strike, type: p.type, side: p.qty > 0 ? 'SELL' : 'BUY', lots: Math.abs(p.qty) / p.lot }], 'Exit');
    } finally { this.exiting.delete(key); }
  }

  setExitRules(key, { stop = '', target = '' } = {}) {
    const p = this.state.positions.find((x) => x.key === key);
    if (!p) throw new Error('That position is already closed.');
    const level = (value, label) => {
      if (value == null || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a price greater than ₹0.`);
      return round2(n);
    };
    const stopPrice = level(stop, 'Stop-loss price'), targetPrice = level(target, 'Take-profit price');
    if (stopPrice == null && targetPrice == null) delete p.exitRules;
    else p.exitRules = { ...(stopPrice == null ? {} : { stop: stopPrice }), ...(targetPrice == null ? {} : { target: targetPrice }) };
    this.write();
    return p.exitRules || null;
  }

  async checkExitRules() {
    if (this.exitCheck) return this.exitCheck;
    this.exitCheck = (async () => {
      // A live paper exit must not trigger on stale after-hours quotes. Replay is driven by its own as-of clock.
      if (this.provider.engine) {
        if (!this.provider.engine.active()) return;
      } else {
        const market = await this.provider.marketStatus().catch(() => null);
        if (!market?.open) return;
      }
      for (const item of [...this.state.positions]) {
        const p = this.state.positions.find((x) => x.key === item.key);
        if (!p?.exitRules || this.exiting.has(p.key)) continue;
        this.exiting.add(p.key);
        try {
          let q;
          try { q = await this.quote(p); } catch { continue; }
          // A manual order may have changed this position while its quote was loading.
          const current = this.state.positions.find((x) => x.key === p.key);
          if (!current || current.qty !== p.qty || !current.exitRules) continue;
          const price = Number(q.ltp);
          if (!(price > 0)) continue;
          const rules = current.exitRules;
          const reason = current.qty > 0
            ? rules.stop != null && price <= rules.stop ? 'Stop loss' : rules.target != null && price >= rules.target ? 'Take profit' : null
            : rules.stop != null && price >= rules.stop ? 'Stop loss' : rules.target != null && price <= rules.target ? 'Take profit' : null;
          if (!reason) continue;
          const side = current.qty > 0 ? 'SELL' : 'BUY';
          const level = reason === 'Stop loss' ? rules.stop : rules.target;
          try {
            await this.place([{ symbol: current.symbol, expiry: current.expiry, strike: current.strike, type: current.type, side, lots: Math.abs(current.qty) / current.lot }],
              `Automatic ${reason.toLowerCase()}`, `Automatic exit: option price reached ₹${level}.`);
          } catch (e) { console.log(`Automatic ${reason.toLowerCase()} exit failed for ${p.key}: ${e.message}`); }
        } finally { this.exiting.delete(p.key); }
      }
    })().finally(() => { this.exitCheck = null; });
    return this.exitCheck;
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
      const c = settlementCharges(p.qty, value, p.expiry);
      const settleFill = { spot: close, iv: 0 };
      const entryCharges = p.learnEntry?.charges || 0;
      const explanation = this.explainClose(p, settleFill, Math.abs(p.qty), realized, entryCharges, c.total, this.now());
      this.state.cash = round2(this.state.cash + p.qty * value - c.total);
      this.state.realized = round2(this.state.realized + realized);
      this.state.charges = round2(this.state.charges + c.total);
      this.state.orders.push({ id: `S${Date.now()}-${this.state.orders.length}`, t: this.now(), symbol: p.symbol, expiry: p.expiry, strike: p.strike, type: p.type, side: p.qty > 0 ? 'SELL' : 'BUY', lots: Math.abs(p.qty) / p.lot, qty: Math.abs(p.qty), price: round2(value), charges: c.total, chargeParts: c.parts, realized: round2(realized), tag: `Expiry settlement at ${close}`, ...(explanation ? { explanation } : {}) });
      this.state.positions.splice(this.state.positions.indexOf(p), 1);
    }
    this.write();
  }

  async summary() {
    await this.settle();
    await this.checkExitRules();
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
      realized: st.realized, unrealized: round2(unrealized), charges: st.charges, chargeParts: sumParts(st.orders.map((o) => o.chargeParts)), margin, available: round2(st.cash + shortValue - margin),
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
