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

// One-minute bars for some days of the test market: NIFTY walks in a straight line from the previous close to the day's
// close over the 375 bars (09:15 to 15:29), and option bars are Black–Scholes prices on that path. The 24,300 call only
// starts trading at 12:00; each bar trades 10 lots.
export const MINUTE_DAYS = ['2024-07-02', '2024-07-03', '2024-07-04'];
export const barTs = (date, hh, mm) => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`) / 1000;
export const minuteSpot = (date, i) => { const p = spotOn(DAYS[DAYS.indexOf(date) - 1]), c = spotOn(date); return Math.round((p + (c - p) * (i + 1) / 375) * 100) / 100; };
export const minuteOption = (date, i, expiry, K, type) => {
  const T = Math.max((Date.parse(expiry + 'T15:30:00+05:30') - (barTs(date, 9, 15) + 60 * (i + 1)) * 1000) / (365 * 864e5), 0);
  return Math.max(0.05, Math.round(bs(type, minuteSpot(date, i), K, T, 0.06, 0.15).price * 20) / 20);
};
export function seedMinutes(store, days = MINUTE_DAYS) {
  for (const date of days) {
    const t0 = barTs(date, 9, 15);
    store.saveIndexMinutes('NIFTY', Array.from({ length: 375 }, (_, i) => { const c = minuteSpot(date, i); return { ts: t0 + 60 * i, o: c, h: c + 5, l: c - 5, c }; }));
    for (const expiry of EXPIRIES.filter((e) => e >= date).slice(0, 2)) {
      for (let K = 23800; K <= 24400; K += 100) for (const type of ['CE', 'PE']) {
        const cid = store.contractId('NIFTY', expiry, K, type, 25, `NIFTY${K}${type}`);
        const late = K === 24300 && type === 'CE';
        store.saveOptionMinutes(cid, Array.from({ length: 375 }, (_, i) => i).filter((i) => !late || i >= 165).map((i) => ({ ts: t0 + 60 * i, c: minuteOption(date, i, expiry, K, type), v: 250 })));
      }
    }
    store.countMinutes('NIFTY', date, date);
  }
  return store;
}
