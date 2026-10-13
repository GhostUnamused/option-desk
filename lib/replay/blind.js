// Blind mode: hide which real dates a replay session is on. The server shifts every date it sends by a fixed
// number of days (a multiple of 7, so weekdays and days-to-expiry stay true) and shifts dates it receives back.
// The browser only ever sees the disguised calendar, so nothing in the page needs to know about blind mode.

const pad = (n) => String(n).padStart(2, '0');
const DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)|(?<!\d)(\d{2})-(\d{2})-(\d{4})(?!\d)/g; // YYYY-MM-DD, or DD-MM-YYYY inside option ids
const TIME_KEYS = new Set(['t', 'openedAt', 'now']); // epoch timestamps (ms, or s for chart points)

function shiftIso(y, m, d, days) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d) + days * 864e5);
  return [dt.getUTCFullYear(), pad(dt.getUTCMonth() + 1), pad(dt.getUTCDate())];
}

export function shiftText(s, days) {
  if (!days || typeof s !== 'string') return s;
  return s.replace(DATE, (all, y, m, d, d2, m2, y2) => {
    if (y) { const [a, b, c] = shiftIso(y, m, d, days); return `${a}-${b}-${c}`; }
    const [a, b, c] = shiftIso(y2, m2, d2, days); return `${c}-${b}-${a}`;
  });
}

// Deep copy of a JSON value with every date moved by `days` (negative to undo).
export function disguise(value, days, key = '') {
  if (!days || value == null) return value;
  if (typeof value === 'string') return shiftText(value, days);
  if (typeof value === 'number') return TIME_KEYS.has(key) && value > 1e8 ? value + days * (value > 1e11 ? 864e5 : 86400) : value;
  if (Array.isArray(value)) return value.map((v) => disguise(v, days));
  if (typeof value === 'object') { const o = {}; for (const [k, v] of Object.entries(value)) o[k] = disguise(v, days, k); return o; }
  return value;
}

// A whole number of weeks that moves `date` to somewhere in the 2100s, so disguised dates are obviously not real.
export function pickOffset(date, rand = Math.random) {
  const target = Date.UTC(2101 + Math.floor(rand() * 40), Math.floor(rand() * 12), 1);
  return Math.round((target - Date.parse(date)) / 864e5 / 7) * 7;
}
