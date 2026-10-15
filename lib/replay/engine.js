// Replay engine: owns the replay clock (the session's as-of date, and in a minute-by-minute session the minute of
// that day), the store, the replay market and account, and the downloaders. The clock only moves forward, one NSE
// trading day at a time, so every day in between gets its expiry settlements and its equity point.
// session.minute is minutes after midnight IST while a day is running, null at the close (15:30). It is kept as a
// small number rather than a timestamp so blind mode has nothing to disguise.
import path from 'node:path';
import crypto from 'node:crypto';
import { REPLAY, expiryKind } from '../config.js';
import { ReplayStore } from './store.js';
import { getSnapshot, closeTime, minuteTime } from './snapshot.js';
import { ReplayProvider } from './provider.js';
import { ReplayAccount } from './account.js';
import { Downloader } from './download.js';
import { MinuteDownloader } from './minutes.js';
import { pickOffset } from './blind.js';

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const addDays = (date, n) => new Date(Date.parse(date) + n * 864e5).toISOString().slice(0, 10);

export class ReplayEngine {
  // history: () => an IndstocksProvider for minute downloads (or null when there is no token).
  constructor(dataDir, { dbFile, accountFile, history = () => null } = {}) {
    this.store = new ReplayStore(dbFile ?? path.join(dataDir, 'replay.db'));
    this.provider = new ReplayProvider(this);
    this.account = new ReplayAccount(accountFile === undefined ? path.join(dataDir, 'replay.json') : accountFile, this.provider, () => this.now());
    this.downloader = new Downloader(this.store);
    this.minutes = new MinuteDownloader(this.store, history, this.downloader);
    this.cache = null;
    this.lock = Promise.resolve();
  }

  get session() { return this.account?.state?.session || null; }
  active() { const s = this.session; return Boolean(s && !s.ended); }
  now() { const s = this.session; return s?.asOf ? (s.minute != null ? minuteTime(s.asOf, s.minute) : closeTime(s.asOf)) : Date.now(); }
  // Is the clock inside a trading day (minute by minute), rather than at a close?
  running() { const s = this.session; return Boolean(s && !s.ended && s.minute != null); }
  riskFree() { return this.store.setting('riskFree', REPLAY.riskFree); }
  // Days to shift dates by while a blind session runs; 0 otherwise.
  blindDays() { const s = this.session; return s && s.blind && !s.ended ? s.offsetDays : 0; }

  // The only way the replay reads market data: a snapshot as of the session date.
  snapshot() {
    const s = this.session;
    if (!s?.asOf) throw new Error('No replay session yet. Open the Replay tab to download some history and start one.');
    const r = this.riskFree(); const key = `${s.asOf}|${s.minute}|${r}`;
    if (this.cache?.key !== key) this.cache = { key, snap: getSnapshot(this.store, s.asOf, { riskFree: r, at: this.now() }) };
    return this.cache.snap;
  }

  // Run state-changing work one call at a time (auto-play steps and orders must not interleave).
  serial(fn) { const p = this.lock.then(fn, fn); this.lock = p.catch(() => {}); return p; }

  // ---- Session ----
  // intraday: walk each day minute by minute where minute prices are stored (other days still step at the close).
  start({ date, balance, blind = false, random = false, intraday = false }) {
    return this.serial(async () => {
      if (this.downloader.job?.running || this.minutes.job?.running) throw new Error('Wait for the download to finish before starting a session.');
      const first = this.store.firstTradingDay(), last = this.store.lastTradingDay();
      if (!first) throw new Error('Download some history first.');
      let start;
      if (random && intraday) {
        const days = this.store.tradingDaysBetween(first, last).filter((d) => this.store.minuteReady(d));
        if (!days.length) throw new Error('No minute prices downloaded yet. Download some in the Replay tab first.');
        start = days[crypto.randomInt(Math.max(1, days.length - 3))];
      } else if (random) {
        // Somewhere with at least ~3 months of history before it and ~1 month after it, when the data allows.
        const days = this.store.tradingDaysBetween(first, last);
        const lo = Math.min(60, Math.floor(days.length / 3)), hi = Math.max(lo + 1, days.length - 20);
        start = days[lo + crypto.randomInt(hi - lo)];
      } else {
        start = this.store.tradingDayOnOrAfter(date || first);
        if (!start || start > last) throw new Error('That date is after the last downloaded day. Download more history or pick an earlier date.');
        if (intraday && !this.store.minuteReady(start)) throw new Error(`There are no minute prices for ${start}. Pick a day with minute prices (see Minute prices in the Replay tab), or untick Minute by minute.`);
      }
      const minute = intraday ? REPLAY.intraday.firstMinute : null;
      const bal = Number(balance) > 0 ? Math.round(Number(balance)) : REPLAY.startBalance;
      const st = this.account.fresh(bal);
      const t0 = minute != null ? minuteTime(start, minute) : closeTime(start);
      st.createdAt = new Date(t0).toISOString();
      st.equity = [{ t: t0, v: bal }];
      st.session = { id: crypto.randomUUID(), startDate: start, asOf: start, minute, intraday: Boolean(intraday), blind: Boolean(blind), offsetDays: blind ? pickOffset(start) : 0, startedAt: Date.now(), ended: false, endedAt: null, random: Boolean(random) };
      this.account.state = st; this.cache = null;
      this.account.write();
      return this.publicState();
    });
  }

  // Move the clock forward. by: 'minutes' (n of them, within the day; past 15:30 it stops at the close) | 'close' |
  // 'day' | 'week' | 'expiry' (the next expiry of `symbol`). In a minute-by-minute session a new day opens at 09:16
  // when it has minute prices, else it shows at its close.
  step({ by = 'day', symbol = 'NIFTY', n = 1 } = {}) {
    return this.serial(async () => {
      const s = this.session;
      if (!s) throw new Error('Start a replay session first.');
      if (s.ended) throw new Error('This session has ended. Start a new one in the Replay tab.');
      if (by === 'minutes' || by === 'close') {
        if (s.minute == null) throw new Error('The market has closed for this day. Step to the next day.');
        const settledBefore = this.settledCount(), was = s.minute;
        const to = by === 'close' ? null : s.minute + Math.max(1, Math.min(375, Math.round(Number(n) || 1)));
        s.minute = to == null || to >= 15 * 60 + 30 ? null : to;
        await this.account.summary(); // at the close this settles today's expiries and records the day's equity
        this.account.write();
        return { from: s.asOf, to: s.asOf, days: 0, minutes: (s.minute ?? 930) - was, settled: this.settledCount() - settledBefore, state: this.publicState() };
      }
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
      const settledBefore = this.settledCount();
      // Finish the running day first, so its expiries settle and its equity point is the close.
      if (s.minute != null) { s.minute = null; await this.account.summary(); }
      for (const d of days) {
        s.asOf = d;
        // Only the day the clock stops on opens in the morning; days passed over are seen at their close.
        s.minute = s.intraday && d === target && this.store.minuteReady(d) ? REPLAY.intraday.firstMinute : null;
        await this.account.summary(); // settles anything that expired and records the day's equity
      }
      this.account.write();
      return { from, to: s.asOf, days: days.length, settled: this.settledCount() - settledBefore, state: this.publicState() };
    });
  }

  settledCount() { return this.account.state.orders.filter((o) => o.id.startsWith('S')).length; }

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
        next = Object.fromEntries(REPLAY.symbols.map((sym) => { const all = snap.expiries(sym); return [sym, all[0] ? { date: all[0], kind: expiryKind(all[0], snap.listedExpiries(sym)) } : null]; }));
      } catch {}
    }
    const running = !s.ended && s.minute != null;
    return { ...base, ended: s.ended, blind: s.blind, startDate: s.startDate, date: s.asOf, now: this.now(), day: played, hasNext: Boolean(this.store.nextTradingDay(s.asOf)), nextExpiry: next,
      intraday: Boolean(s.intraday), running, time: running ? hhmm(s.minute) : '15:30', minutesLeft: running ? 930 - s.minute : 0 };
  }

  status() {
    const blind = this.blindDays() !== 0;
    return { ...this.publicState(), coverage: blind ? null : this.store.coverage(), download: this.downloader.status(), symbols: REPLAY.symbols, earliest: REPLAY.earliest, startBalance: REPLAY.startBalance,
      minutes: blind ? null : { coverage: this.store.minuteCoverage(), download: this.minutes.status(), source: this.minutes.source(), indexFrom: REPLAY.intraday.indexFrom, optionsFrom: REPLAY.intraday.optionsFrom } };
  }
}
