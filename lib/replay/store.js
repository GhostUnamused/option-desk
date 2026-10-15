// Local SQLite store for replay data (replay.db in the data folder). Uses Node's built-in node:sqlite, so no packages.
// Market rows are read only through getSnapshot() in snapshot.js; this file writes them and answers calendar questions.
const sqlite = process.getBuiltinModule?.('node:sqlite');

export function hasSqlite() { return Boolean(sqlite?.DatabaseSync); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,        -- YYYY-MM-DD
  status TEXT NOT NULL,         -- trading | holiday | error
  format TEXT,                  -- old | udiff
  rows INTEGER,
  note TEXT,
  fetched_at INTEGER
);
CREATE TABLE IF NOT EXISTS options (
  date TEXT NOT NULL, symbol TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL, type TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, settle REAL,
  volume INTEGER, oi INTEGER, chg_oi INTEGER, lot INTEGER,
  PRIMARY KEY (date, symbol, expiry, strike, type)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS options_contract ON options (symbol, expiry, strike, type, date);
CREATE TABLE IF NOT EXISTS indices (
  symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL,
  PRIMARY KEY (symbol, date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
-- Minute bars (INDstocks history). ts is the bar's start in true epoch seconds; a bar is known once ts + 60 has passed.
CREATE TABLE IF NOT EXISTS minute_index (
  symbol TEXT NOT NULL, ts INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL,
  PRIMARY KEY (symbol, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS minute_contracts (
  id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, expiry TEXT NOT NULL, strike REAL NOT NULL, type TEXT NOT NULL, lot INTEGER, tsym TEXT,
  UNIQUE (symbol, expiry, strike, type)
);
-- Option bars, kept small: close in paise and volume in units (shares), per contract id.
CREATE TABLE IF NOT EXISTS minute_options (
  cid INTEGER NOT NULL, ts INTEGER NOT NULL, c INTEGER NOT NULL, v INTEGER NOT NULL,
  PRIMARY KEY (cid, ts)
) WITHOUT ROWID;
-- Which days have minute bars, per symbol (counts), and which expiries were downloaded over which days.
CREATE TABLE IF NOT EXISTS minute_days (
  date TEXT NOT NULL, symbol TEXT NOT NULL, index_bars INTEGER NOT NULL DEFAULT 0, option_bars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, symbol)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS minute_expiries (
  symbol TEXT NOT NULL, expiry TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, contracts INTEGER, fetched_at INTEGER,
  PRIMARY KEY (symbol, expiry)
) WITHOUT ROWID;
`;

export class ReplayStore {
  constructor(file) {
    if (!hasSqlite()) throw new Error(`Replay needs Node.js 22.13 or newer (this is ${process.version}). Install a newer Node or use OptionDesk.exe.`);
    this.file = file;
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.stmts = new Map();
  }

  // Cached prepared statement.
  st(sql) { let s = this.stmts.get(sql); if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); } return s; }
  all(sql, ...params) { return this.st(sql).all(...params); }
  get(sql, ...params) { return this.st(sql).get(...params); }

  close() { this.db.close(); }

  // ---- Writing (downloader) ----
  // Replace everything stored for one trading day in a single transaction.
  saveDay(date, { format, options, indices, note = null }) {
    const ins = this.st('INSERT INTO options VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const idx = this.st('INSERT OR REPLACE INTO indices VALUES (?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      this.st('DELETE FROM options WHERE date = ?').run(date);
      for (const o of options) ins.run(date, o.symbol, o.expiry, o.strike, o.type, o.open, o.high, o.low, o.close, o.settle, o.volume, o.oi, o.chgOi, o.lot);
      for (const [sym, v] of Object.entries(indices)) idx.run(sym, date, v.open, v.high, v.low, v.close);
      this.st('INSERT OR REPLACE INTO days VALUES (?, ?, ?, ?, ?, ?)').run(date, 'trading', format, options.length, note, Date.now());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  markDay(date, status, note = null) {
    this.st('INSERT OR REPLACE INTO days VALUES (?, ?, NULL, 0, ?, ?)').run(date, status, note, Date.now());
  }

  dayStatus(date) { return this.get('SELECT status FROM days WHERE date = ?', date)?.status || null; }

  // Minute bars from INDstocks. bars: [{ ts, o, h, l, c }] (ts in true epoch seconds).
  saveIndexMinutes(symbol, bars) {
    const ins = this.st('INSERT OR REPLACE INTO minute_index VALUES (?, ?, ?, ?, ?, ?)');
    this.tx(() => { for (const b of bars) ins.run(symbol, b.ts, b.o, b.h, b.l, b.c); });
  }
  // Contract id for an option, created on first sight.
  contractId(symbol, expiry, strike, type, lot, tsym) {
    this.st('INSERT OR IGNORE INTO minute_contracts (symbol, expiry, strike, type, lot, tsym) VALUES (?, ?, ?, ?, ?, ?)').run(symbol, expiry, strike, type, lot, tsym);
    return this.get('SELECT id FROM minute_contracts WHERE symbol = ? AND expiry = ? AND strike = ? AND type = ?', symbol, expiry, strike, type).id;
  }
  // bars: [{ ts, c, v }] with c in rupees and v in units.
  saveOptionMinutes(cid, bars) {
    const ins = this.st('INSERT OR REPLACE INTO minute_options VALUES (?, ?, ?, ?)');
    this.tx(() => { for (const b of bars) ins.run(cid, b.ts, Math.round(b.c * 100), Math.round(b.v || 0)); });
  }
  // Recount the minute bars of each date (IST) in [from, to] for a symbol.
  countMinutes(symbol, from, to) {
    const day = (d) => Date.parse(d + 'T00:00:00+05:30') / 1000;
    for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10), a = day(d), b = a + 86400;
      const ib = this.get('SELECT count(*) n FROM minute_index WHERE symbol = ? AND ts >= ? AND ts < ?', symbol, a, b).n;
      const ob = this.get('SELECT count(*) n FROM minute_contracts k JOIN minute_options o ON o.cid = k.id WHERE k.symbol = ? AND o.ts >= ? AND o.ts < ?', symbol, a, b).n;
      if (ib || ob) this.st('INSERT OR REPLACE INTO minute_days VALUES (?, ?, ?, ?)').run(d, symbol, ib, ob);
      else this.st('DELETE FROM minute_days WHERE date = ? AND symbol = ?').run(d, symbol);
    }
  }
  markExpiry(symbol, expiry, from, to, contracts) { this.st('INSERT OR REPLACE INTO minute_expiries VALUES (?, ?, ?, ?, ?, ?)').run(symbol, expiry, from, to, contracts, Date.now()); }
  expiryFetched(symbol, expiry) { return this.get('SELECT from_date f, to_date t FROM minute_expiries WHERE symbol = ? AND expiry = ?', symbol, expiry) || null; }
  tx(fn) { this.db.exec('BEGIN'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }

  // ---- Calendar: which dates exist, not what happened on them ----
  firstTradingDay() { return this.get("SELECT min(date) d FROM days WHERE status = 'trading'")?.d || null; }
  lastTradingDay() { return this.get("SELECT max(date) d FROM days WHERE status = 'trading'")?.d || null; }
  isTradingDay(date) { return this.dayStatus(date) === 'trading'; }
  nextTradingDay(date) { return this.get("SELECT min(date) d FROM days WHERE status = 'trading' AND date > ?", date)?.d || null; }
  // First trading day on or after a date.
  tradingDayOnOrAfter(date) { return this.get("SELECT min(date) d FROM days WHERE status = 'trading' AND date >= ?", date)?.d || null; }
  tradingDaysBetween(from, to) { return this.all("SELECT date FROM days WHERE status = 'trading' AND date >= ? AND date <= ? ORDER BY date", from, to).map((r) => r.date); }

  // A day the replay clock can walk minute by minute: a trading day with index and option minute bars.
  minuteReady(date, symbol = null) {
    return Boolean(this.get(`SELECT 1 x FROM minute_days m JOIN days d ON d.date = m.date AND d.status = 'trading' WHERE m.date = ? ${symbol ? 'AND m.symbol = ? ' : ''}AND m.index_bars > 0 AND m.option_bars > 0 LIMIT 1`, ...(symbol ? [date, symbol] : [date])));
  }
  minuteCoverage() {
    const c = this.get("SELECT min(m.date) first, max(m.date) last, count(DISTINCT m.date) days FROM minute_days m JOIN days d ON d.date = m.date AND d.status = 'trading' WHERE m.index_bars > 0 AND m.option_bars > 0");
    const idx = this.get('SELECT min(date) first, max(date) last, count(DISTINCT date) days FROM minute_days WHERE index_bars > 0');
    // Minute days that still need their daily (bhavcopy) history before replay can use them.
    const needDaily = this.get("SELECT count(DISTINCT m.date) n FROM minute_days m LEFT JOIN days d ON d.date = m.date WHERE m.option_bars > 0 AND (d.status IS NULL OR d.status = 'error')").n;
    const bySymbol = Object.fromEntries(this.all('SELECT symbol, count(*) days FROM minute_days WHERE option_bars > 0 GROUP BY symbol').map((r) => [r.symbol, r.days]));
    return { first: c.first, last: c.last, days: c.days || 0, indexFirst: idx.first, indexLast: idx.last, indexDays: idx.days || 0, needDaily, bySymbol };
  }

  coverage() {
    const c = this.get(`SELECT min(date) first, max(date) last, sum(status = 'trading') trading, sum(status = 'holiday' AND coalesce(note, '') != 'weekend') holidays, sum(status = 'error') errors FROM days`);
    const errors = this.all("SELECT date, note FROM days WHERE status = 'error' ORDER BY date DESC LIMIT 10");
    // Stretches of consecutive downloaded trading days, so the UI can show gaps.
    const days = this.all("SELECT date FROM days WHERE status IN ('trading', 'holiday') ORDER BY date").map((r) => r.date);
    const ranges = [];
    for (const d of days) {
      const last = ranges[ranges.length - 1];
      if (last && (Date.parse(d) - Date.parse(last.to)) / 864e5 <= 4) last.to = d; else ranges.push({ from: d, to: d });
    }
    let bytes = 0; try { bytes = (this.get('SELECT page_count * page_size b FROM pragma_page_count(), pragma_page_size()')?.b) || 0; } catch {}
    return { first: this.firstTradingDay(), last: this.lastTradingDay(), tradingDays: c.trading || 0, holidays: c.holidays || 0, errorDays: c.errors || 0, errors, ranges, megabytes: Math.round(bytes / 1048576) };
  }

  // ---- Settings ----
  setting(key, fallback) { const r = this.get('SELECT value FROM settings WHERE key = ?', key); return r ? JSON.parse(r.value) : fallback; }
  setSetting(key, value) { this.st('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value)); }
}
