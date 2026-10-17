// Candle helpers shared by the broker adapters. The page's charts take t in seconds: intraday bars on the IST wall
// clock (true epoch + 5:30, like NSE's charts), daily bars at midnight UTC of the trading day (candles.js, drawer.js).
export const IST = 19800;

// A broker's time string to IST wall-clock seconds. With an offset (Z, +05:30, +0530) it is converted; a bare
// "2026-10-16 09:15:00" or "2026-10-16" is already Indian time.
export function wallClock(v) {
  const s = String(v ?? '').trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = /(Z|[+-]\d{2}:\d{2})$/.test(s) ? Date.parse(s) + IST * 1000 : Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : `${s}Z`);
  return Math.floor(ms / 1000);
}
export const fromEpoch = (seconds) => Math.floor(Number(seconds)) + IST;
export const dayOf = (t) => t - (((t % 86400) + 86400) % 86400);
export const isoDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// Ascending, one bar per time, no unparseable times (Lightweight Charts refuses anything else); daily bars at midnight.
export function tidy(rows, daily = false) {
  const out = new Map();
  for (const r of rows) if (Number.isFinite(r.t)) { const t = daily ? dayOf(r.t) : r.t; out.set(t, { ...r, t }); }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
// Only the latest session's bars (intraday requests reach back a few days to cover weekends and holidays).
export function lastSession(rows) {
  if (!rows.length) return rows;
  const last = dayOf(rows[rows.length - 1].t);
  return rows.filter((r) => dayOf(r.t) === last);
}
