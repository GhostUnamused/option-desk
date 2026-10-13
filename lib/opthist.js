// Live-mode history of ATM implied vol and the put–call ratio. NSE has no free IV history, so it comes from two places:
// the replay store's bhavcopies (if any history was downloaded in replay mode), and a log this app keeps while it runs
// (one point per day plus today's intraday samples, in option-history.json). Same definitions as Snapshot.optionHistory.
import fs from 'node:fs';
import path from 'node:path';
import { yearsTo } from '../public/js/bs.js';
import { nseDateToISO } from './nse.js';

const istDate = (ms = Date.now()) => new Date(ms + 19800e3).toISOString().slice(0, 10);
const chartSec = (ms = Date.now()) => Math.floor((ms + 19800e3) / 1000); // IST wall clock as UTC, like NSE's charts

export class LiveOptionHistory {
  constructor(dataDir, provider) {
    this.provider = provider; this.file = path.join(dataDir, 'option-history.json'); this.dbFile = path.join(dataDir, 'replay.db');
    this.state = { days: {}, intraday: {} };
    try { this.state = { days: {}, intraday: {}, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch {}
    this.storeTried = false; this.store = null; this.storeRows = new Map();
  }

  // Older days from replay.db, read through the same as-of snapshot replay uses (as of today). Cached for an hour.
  async fromStore(symbol, days) {
    const hit = this.storeRows.get(symbol);
    if (hit && Date.now() - hit.at < 3600e3 && hit.days >= days) return hit.rows;
    if (!this.storeTried) {
      this.storeTried = true;
      try {
        if (fs.existsSync(this.dbFile)) {
          const { ReplayStore, hasSqlite } = await import('./replay/store.js');
          if (hasSqlite()) this.store = new ReplayStore(this.dbFile);
        }
      } catch { this.store = null; }
    }
    if (!this.store) return [];
    const { getSnapshot } = await import('./replay/snapshot.js');
    const rows = getSnapshot(this.store, istDate()).optionHistory(symbol, days);
    this.storeRows.set(symbol, { at: Date.now(), days, rows });
    return rows;
  }

  // Today's point from the live chains: IV from the nearest expiry 7+ days out, PCR from the nearest expiry.
  async sample(symbol) {
    const exps = await this.provider.expiries(symbol);
    const today = istDate(), near = exps.find((e) => e >= today), far = exps.find((e) => yearsTo(e) * 365 >= 7);
    if (!near) return null;
    const [cn, cf] = await Promise.all([this.provider.chain(symbol, near), far && far !== near ? this.provider.chain(symbol, far) : null]);
    const tot = cn.rows.reduce((a, r) => ({ ce: a.ce + (r.ce?.oi || 0), pe: a.pe + (r.pe?.oi || 0) }), { ce: 0, pe: 0 });
    const c = cf || cn, spot = c.spot;
    let iv = null;
    if (spot && c.rows.length) {
      const atm = c.rows.reduce((a, r) => (Math.abs(r.strike - spot) < Math.abs(a.strike - spot) ? r : a));
      const ivs = [atm.ce?.iv, atm.pe?.iv].filter((x) => x > 0);
      if (ivs.length) iv = ivs.reduce((a, b) => a + b, 0) / ivs.length / 100;
    }
    // The chain's own timestamp names the trading day (after midnight, or on a holiday, it is still the last session).
    let date = today; try { if (c.timestamp) date = nseDateToISO(c.timestamp.split(' ')[0]); } catch {}
    return { date, spot, expiry: far || near, iv, pcr: tot.ce ? tot.pe / tot.ce : null };
  }

  record(symbol, p) {
    if (!p || (p.iv == null && p.pcr == null)) return;
    const s = this.state; (s.days[symbol] ||= {})[p.date] = p;
    if (p.date !== istDate()) return void this.save(); // a closed market's last session: keep the day point only
    const day = (s.intraday[symbol] ||= { date: p.date, points: [] });
    if (day.date !== p.date) { day.date = p.date; day.points = []; }
    const t = chartSec(), last = day.points[day.points.length - 1];
    if (!last || t - last.t >= 55) day.points.push({ t, iv: p.iv, pcr: p.pcr });
    this.save();
  }
  save() { try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.state)); fs.renameSync(tmp, this.file); } catch {} }

  async history(symbol, days = 365, marketOpen = false) {
    let now = null, error = null;
    try { now = await this.sample(symbol); if (marketOpen) this.record(symbol, now); else if (now && !this.state.days[symbol]?.[now.date]) this.record(symbol, now); } catch (e) { error = e.message; }
    // A logged day after the session the exchange reports can't be real (an older version dated by the clock): drop it.
    const log = this.state.days[symbol] || {};
    if (now) for (const d of Object.keys(log)) if (d > now.date) { delete log[d]; this.save(); }
    let older = []; try { older = await this.fromStore(symbol, days); } catch {}
    const byDate = new Map(older.map((r) => [r.date, r]));
    const cutoff = istDate(Date.now() - days * 864e5);
    for (const [d, r] of Object.entries(this.state.days[symbol] || {})) if (d >= cutoff) byDate.set(d, r);
    if (now) byDate.set(now.date, now);
    const rows = [...byDate.values()].filter((r) => r.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
    const day = this.state.intraday[symbol];
    return { rows, intraday: day && day.date === istDate() ? day.points : [], fromStore: older.length, logged: Object.keys(this.state.days[symbol] || {}).length, error };
  }
}
