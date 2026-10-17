// Records minute prices while the app runs in live mode, from whichever data source is answering (any broker, or the
// NSE website), into replay.db, so minute-by-minute replay works without a broker that sells expired-contract history.
// Each minute: the index bar (open/high/low/close from samples every few seconds) for the replay indices and India VIX,
// and for each expiry within REPLAY.intraday.daysBefore the contracts around where the index traded today, as one bar
// per contract that traded in that minute (last price near the minute's end, volume from the change in day volume).
// The rows are the same as the minute downloader's, so replay reads them the same way. A recorded day still needs its
// daily (bhavcopy) history before replay can use it; replay mode fetches that by itself (see ReplayEngine).
import { REPLAY } from '../config.js';
import { pickStrikes } from './minutes.js';

const OPEN = 9 * 60 + 15, CLOSE = 15 * 60 + 30;
const istDate = (ms) => new Date(ms + 19800e3).toISOString().slice(0, 10);
const istMinute = (ms) => Math.floor(((ms / 1000 + 19800) % 86400) / 60);
const addDays = (date, n) => new Date(Date.parse(date) + n * 864e5).toISOString().slice(0, 10);

export class MinuteRecorder {
  // store: () => the ReplayStore (opened on first use, so live mode only loads SQLite while recording).
  // provider: the live market provider (indices, marketStatus, expiries, chain).
  constructor(store, provider, { now = Date.now, symbols = REPLAY.symbols, every = 5000, chainAt = 45 } = {}) {
    this.store = store; this.provider = provider; this.now = now; this.symbols = symbols; this.every = every; this.chainAt = chainAt;
    this.timer = null; this.busy = false; this.day = null; this.bars = new Map(); this.seen = new Map(); this.sampled = null;
    this.stats = { date: null, minutes: 0, optionBars: 0, lastAt: null, error: null, source: null };
  }

  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), this.every); this.timer.unref?.(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  enabled() { try { return this.store().setting('recordMinutes', true); } catch { return false; } }
  setEnabled(on) { this.store().setSetting('recordMinutes', Boolean(on)); if (!on) this.flush(); return this.status(); }
  status() {
    let on = false, days = 0; try { on = this.enabled(); days = this.store().get("SELECT count(DISTINCT date) n FROM minute_days WHERE option_bars > 0")?.n || 0; } catch {}
    return { enabled: on, recording: Boolean(on && this.stats.lastAt && this.now() - this.stats.lastAt < 90e3), minuteDays: days, ...this.stats };
  }

  // One poll. Timers swallow errors: recording must never disturb the live app.
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const now = this.now(), minute = istMinute(now), date = istDate(now);
      if (date !== this.day) { this.flush(); this.day = date; this.seen.clear(); this.sampled = null; this.stats = { ...this.stats, date, minutes: 0, optionBars: 0 }; }
      if (minute < OPEN || minute >= CLOSE) { this.flush(); return; }
      if (!this.enabled()) return;
      const market = await this.provider.marketStatus().catch(() => null);
      if (!market?.open) { this.flush(); return; }
      await this.sampleIndices(now);
      const bucket = Math.floor(now / 60e3);
      if (this.sampled !== bucket && (now / 1000) % 60 >= this.chainAt) { this.sampled = bucket; await this.sampleChains(now); }
      this.stats.lastAt = now; this.stats.error = null; this.stats.source = this.provider.name || null;
    } catch (e) { this.stats.error = e.message; }
    finally { this.busy = false; }
  }

  // Fold the current index levels into this minute's bars; a bar from an earlier minute is finished, so it is saved.
  async sampleIndices(now) {
    const q = await this.provider.indices();
    const ts = Math.floor(now / 60e3) * 60;
    const levels = [...this.symbols.map((s) => [s, q.indices?.find((i) => i.symbol === s)?.last]), ['INDIAVIX', q.vix?.last]];
    for (const [sym, v] of levels) {
      if (!(v > 0)) continue;
      const b = this.bars.get(sym);
      if (b && b.ts !== ts) this.saveIndex(sym, b);
      if (!b || b.ts !== ts) this.bars.set(sym, { ts, o: v, h: v, l: v, c: v, date: istDate(now) });
      else { b.h = Math.max(b.h, v); b.l = Math.min(b.l, v); b.c = v; }
    }
  }
  saveIndex(sym, b) {
    this.store().saveIndexMinutes(sym, [b]); this.bars.delete(sym);
    if (sym === this.symbols[0]) this.stats.minutes++;
    this.store().countMinutes(sym, b.date, b.date);
  }
  flush() { for (const [sym, b] of [...this.bars]) { try { this.saveIndex(sym, b); } catch {} } }

  // The chains of each expiry in the replay window, one bar per contract that traded since the last sample.
  async sampleChains(now) {
    const ts = Math.floor(now / 60e3) * 60, date = istDate(now);
    for (const sym of this.symbols) {
      const days = REPLAY.intraday.daysBefore[sym] ?? 7;
      const expiries = (await this.provider.expiries(sym).catch(() => [])).filter((e) => e >= date && e <= addDays(date, days));
      // Strikes around today's range so far (the same rule as the minute download).
      const range = this.store().get('SELECT min(l) lo, max(h) hi FROM minute_index WHERE symbol = ? AND ts >= ?', sym, Date.parse(date + 'T00:00:00+05:30') / 1000);
      const live = this.bars.get(sym), lo = Math.min(range?.lo ?? Infinity, live?.l ?? Infinity), hi = Math.max(range?.hi ?? -Infinity, live?.h ?? -Infinity);
      let saved = 0;
      for (const expiry of expiries) {
        let chain; try { chain = await this.provider.chain(sym, expiry); } catch { continue; }
        const mid = Number.isFinite(lo) ? null : chain.spot;
        const keep = pickStrikes(chain.rows.map((r) => r.strike), mid ?? lo, mid ?? hi, REPLAY.intraday.strikesEachSide);
        const bars = [];
        for (const r of chain.rows) {
          if (!keep.has(r.strike)) continue;
          for (const [type, o] of [['CE', r.ce], ['PE', r.pe]]) {
            if (!(o?.ltp > 0)) continue;
            const key = `${sym}|${expiry}|${r.strike}|${type}`, lot = o.lot || chain.lot || 1, units = Math.round((o.vol || 0) * lot), was = this.seen.get(key);
            // Not traded today yet: the last price is yesterday's. Otherwise a bar when it traded or its price moved.
            if (!was && !(units > 0)) continue;
            if (was && units <= was.units && o.ltp === was.ltp) continue;
            this.seen.set(key, { units: Math.max(units, was?.units || 0), ltp: o.ltp });
            bars.push({ cid: this.store().contractId(sym, expiry, r.strike, type, lot, null), bar: { ts, c: o.ltp, v: Math.max(0, units - (was?.units || 0)) } });
          }
        }
        this.store().tx(() => { for (const { cid, bar } of bars) this.store().saveOptionMinutes(cid, [bar], false); });
        saved += bars.length;
      }
      if (saved) { this.stats.optionBars += saved; this.store().countMinutes(sym, date, date); }
    }
  }
}
