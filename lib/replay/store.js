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

  // ---- Calendar: which dates exist, not what happened on them ----
  firstTradingDay() { return this.get("SELECT min(date) d FROM days WHERE status = 'trading'")?.d || null; }
  lastTradingDay() { return this.get("SELECT max(date) d FROM days WHERE status = 'trading'")?.d || null; }
  isTradingDay(date) { return this.dayStatus(date) === 'trading'; }
  nextTradingDay(date) { return this.get("SELECT min(date) d FROM days WHERE status = 'trading' AND date > ?", date)?.d || null; }
  // First trading day on or after a date.
  tradingDayOnOrAfter(date) { return this.get("SELECT min(date) d FROM days WHERE status = 'trading' AND date >= ?", date)?.d || null; }
  tradingDaysBetween(from, to) { return this.all("SELECT date FROM days WHERE status = 'trading' AND date >= ? AND date <= ? ORDER BY date", from, to).map((r) => r.date); }

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
