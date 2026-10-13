// Replay engine: owns the replay clock (the session's as-of date), the store, the replay market and account,
// and the downloader. The clock only moves forward, one NSE trading day at a time, so every day in between
// gets its expiry settlements and its equity point.
import path from 'node:path';
import crypto from 'node:crypto';
import { REPLAY, expiryKind } from '../config.js';
import { ReplayStore } from './store.js';
import { getSnapshot, closeTime } from './snapshot.js';
import { ReplayProvider } from './provider.js';
import { ReplayAccount } from './account.js';
import { Downloader } from './download.js';
import { pickOffset } from './blind.js';

const addDays = (date, n) => new Date(Date.parse(date) + n * 864e5).toISOString().slice(0, 10);

export class ReplayEngine {
  constructor(dataDir, { dbFile, accountFile } = {}) {
    this.store = new ReplayStore(dbFile ?? path.join(dataDir, 'replay.db'));
    this.provider = new ReplayProvider(this);
    this.account = new ReplayAccount(accountFile === undefined ? path.join(dataDir, 'replay.json') : accountFile, this.provider, () => this.now());
    this.downloader = new Downloader(this.store);
    this.cache = null;
    this.lock = Promise.resolve();
  }

  get session() { return this.account?.state?.session || null; }
  active() { const s = this.session; return Boolean(s && !s.ended); }
  now() { const s = this.session; return s?.asOf ? closeTime(s.asOf) : Date.now(); }
  riskFree() { return this.store.setting('riskFree', REPLAY.riskFree); }
  // Days to shift dates by while a blind session runs; 0 otherwise.
  blindDays() { const s = this.session; return s && s.blind && !s.ended ? s.offsetDays : 0; }

  // The only way the replay reads market data: a snapshot as of the session date.
  snapshot() {
    const s = this.session;
    if (!s?.asOf) throw new Error('No replay session yet. Open the Replay tab to download some history and start one.');
    const r = this.riskFree(); const key = `${s.asOf}|${r}`;
    if (this.cache?.key !== key) this.cache = { key, snap: getSnapshot(this.store, s.asOf, { riskFree: r }) };
    return this.cache.snap;
  }

  // Run state-changing work one call at a time (auto-play steps and orders must not interleave).
  serial(fn) { const p = this.lock.then(fn, fn); this.lock = p.catch(() => {}); return p; }

  // ---- Session ----
  start({ date, balance, blind = false, random = false }) {
    return this.serial(async () => {
      if (this.downloader.job?.running) throw new Error('Wait for the download to finish before starting a session.');
      const first = this.store.firstTradingDay(), last = this.store.lastTradingDay();
      if (!first) throw new Error('Download some history first.');
      let start;
      if (random) {
        // Somewhere with at least ~3 months of history before it and ~1 month after it, when the data allows.
        const days = this.store.tradingDaysBetween(first, last);
        const lo = Math.min(60, Math.floor(days.length / 3)), hi = Math.max(lo + 1, days.length - 20);
        start = days[lo + crypto.randomInt(hi - lo)];
      } else {
        start = this.store.tradingDayOnOrAfter(date || first);
        if (!start || start > last) throw new Error('That date is after the last downloaded day. Download more history or pick an earlier date.');
      }
      const bal = Number(balance) > 0 ? Math.round(Number(balance)) : REPLAY.startBalance;
      const st = this.account.fresh(bal);
      st.createdAt = new Date(closeTime(start)).toISOString();
      st.equity = [{ t: closeTime(start), v: bal }];
      st.session = { id: crypto.randomUUID(), startDate: start, asOf: start, blind: Boolean(blind), offsetDays: blind ? pickOffset(start) : 0, startedAt: Date.now(), ended: false, endedAt: null, random: Boolean(random) };
      this.account.state = st; this.cache = null;
      this.account.write();
      return this.publicState();
    });
  }

  // Move the clock forward. by: 'day' | 'week' | 'expiry' (the next expiry of `symbol`).
  step({ by = 'day', symbol = 'NIFTY' } = {}) {
    return this.serial(async () => {
      const s = this.session;
      if (!s) throw new Error('Start a replay session first.');
      if (s.ended) throw new Error('This session has ended. Start a new one in the Replay tab.');
      const from = s.asOf; let target;
      if (by === 'day') target = this.store.nextTradingDay(from);
      else if (by === 'week') {
        // Near the end of the downloaded history, go as far as it reaches.
        target = this.store.tradingDayOnOrAfter(addDays(from, 7)) || this.store.lastTradingDay();
        if (target <= from) target = null;
      }
      else if (by === 'expiry') {
        const exp = this.snapshot().expiries(REPLAY.symbols.includes(symbol) ? symbol : 'NIFTY')[0];
        if (!exp) throw new Error('No upcoming expiry found for this index.');
        target = this.store.isTradingDay(exp) ? exp : this.store.tradingDayOnOrAfter(exp);
        if (exp > (this.store.lastTradingDay() || '')) target = null;
      } else throw new Error(`Unknown step ${by}`);
      if (!target) throw new Error(`You have reached the last downloaded day (${from}). Download more history in the Replay tab, or end the session to see your summary.`);
      const days = this.store.tradingDaysBetween(this.store.nextTradingDay(from), target);
      const settledBefore = this.account.state.orders.filter((o) => o.id.startsWith('S')).length;
      for (const d of days) {
        s.asOf = d;
        await this.account.summary(); // settles anything that expired today and records the day's equity
      }
      this.account.write();
      const settled = this.account.state.orders.filter((o) => o.id.startsWith('S')).slice(settledBefore);
      return { from, to: s.asOf, days: days.length, settled: settled.length, state: this.publicState() };
    });
  }

  end() {
    return this.serial(async () => {
      const s = this.session;
      if (!s || s.ended) throw new Error('No replay session is running.');
      await this.account.summary();
      s.ended = true; s.endedAt = Date.now();
      this.account.write();
      return this.account.journal();
    });
  }

  setRiskFree(pct) {
    const r = Number(pct) / 100;
    if (!(r >= 0 && r <= 0.2)) throw new Error('Enter a rate between 0% and 20%.');
    this.store.setSetting('riskFree', r); this.cache = null;
    return { riskFree: r };
  }

  // ---- What the page needs ----
  publicState() {
    const s = this.session;
    const base = { available: true, active: this.active(), riskFree: this.riskFree() };
    if (!s) return base;
    const played = this.store.tradingDaysBetween(s.startDate, s.asOf).length;
    let next = null;
    if (!s.ended) {
      try {
        const snap = this.snapshot();
        next = Object.fromEntries(REPLAY.symbols.map((sym) => { const all = snap.expiries(sym); return [sym, all[0] ? { date: all[0], kind: expiryKind(all[0], all) } : null]; }));
      } catch {}
    }
    return { ...base, ended: s.ended, blind: s.blind, startDate: s.startDate, date: s.asOf, now: closeTime(s.asOf), day: played, hasNext: Boolean(this.store.nextTradingDay(s.asOf)), nextExpiry: next };
  }

  status() {
    const blind = this.blindDays() !== 0;
    return { ...this.publicState(), coverage: blind ? null : this.store.coverage(), download: this.downloader.status(), symbols: REPLAY.symbols, earliest: REPLAY.earliest, startBalance: REPLAY.startBalance };
  }
}
