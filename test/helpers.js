// Test helpers: a throwaway replay store filled with a small, made-up but consistent market.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayStore } from '../lib/replay/store.js';
import { bs } from '../public/js/bs.js';

export function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'optiondesk-test-')); }

// Trading days Mon 2024-07-01 .. Fri 2024-07-12 (10 days). NIFTY rises 100 points a day from 24,000.
// Two expiries: 2024-07-04 (weekly) and 2024-07-11. Prices come from Black–Scholes at 15% vol, so implied vol
// backs out to ~15%. The 24,500 call never trades (volume 0).
export const DAYS = ['2024-07-01', '2024-07-02', '2024-07-03', '2024-07-04', '2024-07-05', '2024-07-08', '2024-07-09', '2024-07-10', '2024-07-11', '2024-07-12'];
export const EXPIRIES = ['2024-07-04', '2024-07-11', '2024-07-25'];
export const spotOn = (date) => 24000 + 100 * DAYS.indexOf(date);

export function seedStore(dir, { days = DAYS } = {}) {
  const store = new ReplayStore(path.join(dir, 'replay.db'));
  for (const date of days) {
    const S = spotOn(date); const now = Date.parse(date + 'T15:30:00+05:30');
    const options = [];
    for (const expiry of EXPIRIES.filter((e) => e >= date)) {
      const T = Math.max((Date.parse(expiry + 'T15:30:00+05:30') - now) / (365 * 864e5), 0);
      for (let K = 23500; K <= 25500; K += 100) {
        for (const type of ['CE', 'PE']) {
          const p = Math.max(0.05, Math.round(bs(type, S, K, T, 0.06, 0.15).price * 20) / 20);
          const dead = K === 24500 && type === 'CE';
          options.push({ symbol: 'NIFTY', expiry, strike: K, type, open: p, high: p, low: p, close: p, settle: p, volume: dead ? 0 : 1000, oi: 50000, chgOi: 0, lot: 25 });
        }
      }
    }
    store.saveDay(date, { format: 'udiff', options, indices: { NIFTY: { open: S - 20, high: S + 30, low: S - 40, close: S }, INDIAVIX: { open: 14, high: 14.5, low: 13.5, close: 14 } } });
  }
  return store;
}

// Every date-like value found anywhere in a JSON-able structure.
export function datesIn(value, out = []) {
  if (typeof value === 'string') { for (const m of value.matchAll(/\d{4}-\d{2}-\d{2}/g)) out.push(m[0]); }
  else if (Array.isArray(value)) value.forEach((v) => datesIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => datesIn(v, out));
  return out;
}
