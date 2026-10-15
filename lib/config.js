// Underlyings the app trades options on. Lot sizes follow NSE's revision effective January 2026 and BSE's of the same
// time; check them against your broker and edit here if the exchanges change them again.
// exchange: where the options trade. broker: only INDstocks has their data (NSE's website has no BSE or stock chains).
// The object grows at runtime: stocks the owner adds to the watchlist join it as { kind: 'stock', id, ... } (addStock).
export const INDICES = {
  NIFTY:      { name: 'NIFTY 50',                  short: 'NIFTY',      lot: 65,  step: 50,  exchange: 'NSE', kind: 'index' },
  BANKNIFTY:  { name: 'NIFTY BANK',                short: 'BANK NIFTY', lot: 30,  step: 100, exchange: 'NSE', kind: 'index' },
  FINNIFTY:   { name: 'NIFTY FINANCIAL SERVICES',  short: 'FIN NIFTY',  lot: 60,  step: 50,  exchange: 'NSE', kind: 'index' },
  MIDCPNIFTY: { name: 'NIFTY MIDCAP SELECT',       short: 'MIDCAP NIFTY', lot: 120, step: 25, exchange: 'NSE', kind: 'index' },
  NIFTYNXT50: { name: 'NIFTY NEXT 50',             short: 'NIFTY NEXT 50', lot: 25, step: 100, exchange: 'NSE', kind: 'index' },
  SENSEX:     { name: 'SENSEX',                    short: 'SENSEX',     lot: 20,  step: 100, exchange: 'BSE', kind: 'index', broker: true },
  BANKEX:     { name: 'BANKEX',                    short: 'BANKEX',     lot: 30,  step: 100, exchange: 'BSE', kind: 'index', broker: true },
};
// A stock with listed options: symbol (NSE code), name, lot, strike step, and its NSE equity id at INDstocks.
export function addStock(s) {
  if (INDICES[s.symbol]?.kind === 'index') return INDICES[s.symbol];
  return (INDICES[s.symbol] = { name: s.name, short: s.symbol, lot: s.lot, step: s.step, exchange: 'NSE', kind: 'stock', broker: true, id: s.id });
}
export function removeStock(symbol) { if (INDICES[symbol]?.kind === 'stock') delete INDICES[symbol]; }
export const VIX_NAME = 'INDIA VIX';

export const PAPER = {
  startBalance: 500000,
  // Margin estimate for sold options: worst loss over a ±scan move, plus exposure margin. Single stocks swing more.
  marginScanPct: 0.09,
  marginScanPctStock: 0.15,
  exposurePct: 0.02,
};

// What an NSE index-options trade costs at a discount broker. Zerodha, Groww and Angel One all charge a flat ₹20 per
// executed order; everything else is a statutory levy that is the same at every broker. Rates change over time, so each
// is a list of [first date, rate] and an order pays the rate in force on its trade date (the replay day, in replay).
// Checked against zerodha.com/charges and angelone.in in Oct 2026. Not modelled: NSE's IPFT levy (₹0.01 per crore, rounds
// to zero), call-and-trade or auto square-off fees, and splitting orders above the exchange freeze quantity.
export const CHARGES = {
  brokers: 'Zerodha, Groww and Angel One',
  brokeragePerOrder: 20,                 // flat, per executed order (each leg of a basket is its own order)
  sttSell: [['2000-01-01', 0.00017], ['2016-06-01', 0.0005], ['2023-04-01', 0.000625], ['2024-10-01', 0.001], ['2026-04-01', 0.0015]], // on sell-side premium
  sttExercise: [['2000-01-01', 0.00125], ['2026-04-01', 0.0015]], // on the settlement value of bought options that expire in the money
  exchange: [['2000-01-01', 0.00053], ['2023-04-01', 0.0005], ['2024-04-01', 0.000495], ['2024-10-01', 0.0003503], ['2026-04-01', 0.0003553]], // NSE transaction charge on premium, both sides (the 2026 start date is approximate)
  exchangeBse: [['2000-01-01', 0.0005], ['2024-10-01', 0.000325]], // BSE's charge on SENSEX/BANKEX option premium (flat rate from October 2024)
  sebiPerCrore: [['2000-01-01', 15], ['2020-06-01', 10]], // SEBI turnover fee, ₹ per crore of premium
  stampBuy: [['2000-01-01', 0.00002], ['2020-07-01', 0.00003]], // stamp duty on buy-side premium (one national rate from July 2020)
  gst: [['2000-01-01', 0.15], ['2017-07-01', 0.18]], // on brokerage + exchange charge + SEBI fee (service tax before GST)
};
// The rate in force on an ISO date from one of the CHARGES lists.
export function rateOn(list, date) {
  let r = list[0][1];
  for (const [from, v] of list) if (date >= from) r = v;
  return r;
}

export const RISK_FREE = 0.06;

// ---- Replay (the simulated account practises on real past days) ----
// Lot size by trade date, used for old-format bhavcopies (before July 2024) and as a fallback.
// Lots really belong to each contract: during a revision old contracts keep the old lot for a while,
// so the importer reads the lot from the file (new format) or from the open interest (old format) and
// falls back to this table. Each entry: [first trade date, lot].
export const LOT_HISTORY = {
  NIFTY:     [['2015-10-30', 75], ['2021-07-23', 50], ['2024-04-26', 25], ['2024-11-20', 75], ['2025-12-31', 65]],
  BANKNIFTY: [['2015-10-30', 40], ['2018-04-27', 20], ['2020-07-31', 25], ['2023-07-01', 15], ['2024-11-20', 30], ['2025-04-25', 35], ['2025-12-31', 30]],
};
// Every lot size each index has used: a value inferred from open interest must be one of these.
export const KNOWN_LOTS = { NIFTY: [25, 50, 65, 75], BANKNIFTY: [15, 20, 25, 30, 35, 40] };

// Which weekday contracts expire on, by date (null = no weekly contracts then). A holiday moves an
// expiry to the trading day before. The replay reads real expiry dates from the data; this table labels
// them weekly or monthly and is what a backtester uses to find "the next weekly" on any date.
export const EXPIRY_RULES = {
  NIFTY: [
    { from: '2000-01-01', weekly: null, monthly: 'Thu' },
    { from: '2019-02-11', weekly: 'Thu', monthly: 'Thu' },
    { from: '2025-09-01', weekly: 'Tue', monthly: 'Tue' },
  ],
  BANKNIFTY: [
    { from: '2000-01-01', weekly: null, monthly: 'Thu' },
    { from: '2016-05-27', weekly: 'Thu', monthly: 'Thu' },
    { from: '2023-09-04', weekly: 'Wed', monthly: 'Thu' },
    { from: '2024-03-01', weekly: 'Wed', monthly: 'Wed' },
    { from: '2024-11-20', weekly: null, monthly: 'Wed' },
    { from: '2025-01-01', weekly: null, monthly: 'Thu' },
    { from: '2025-09-01', weekly: null, monthly: 'Tue' },
  ],
};

export const REPLAY = {
  symbols: ['NIFTY', 'BANKNIFTY'],
  earliest: '2016-01-01',     // oldest date the downloader offers
  startBalance: 500000,
  riskFree: RISK_FREE,        // default for backing implied volatility out of closing prices; changeable in the Replay tab
  // Replay fills: the day's close plus a half-spread that widens away from the money and when few contracts traded.
  // halfSpread = close × min(maxPct, (basePct + perPctAway × % away from spot) × (1 + volumeK / √contracts)), at least one tick.
  slippage: { basePct: 0.003, perPctAway: 0.004, volumeK: 3, maxPct: 0.25, tick: 0.05 },
  // Minute-by-minute replay from INDstocks history (checked Oct 2026): index 1-minute bars from 19 Mar 2024 (India VIX from
  // 21 May 2024), expired option contracts from the 3 Apr 2025 expiry (price and volume, no OI). Per expiry the downloader
  // keeps strikesEachSide strikes beyond the index's range over the daysBefore calendar days up to expiry.
  intraday: {
    indexFrom: '2024-03-19', optionsFrom: '2025-04-03',
    firstMinute: 9 * 60 + 16, // the clock opens at 09:16, when the first one-minute bar (09:15) has finished
    strikesEachSide: 15, daysBefore: { NIFTY: 7, BANKNIFTY: 35 },
  },
};

// Lot size for a symbol on a trade date, from LOT_HISTORY.
export function lotOn(symbol, date) {
  let lot = null;
  for (const [from, l] of LOT_HISTORY[symbol] || []) if (date >= from) lot = l;
  return lot ?? LOT_HISTORY[symbol]?.[0]?.[1] ?? INDICES[symbol]?.lot ?? null;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function expiryRule(symbol, date) {
  let rule = null;
  for (const r of EXPIRY_RULES[symbol] || []) if (date >= r.from) rule = r;
  return rule;
}
// 'weekly' or 'monthly' for a real expiry date (monthly = the last expiry of its month for that index).
export function expiryKind(expiry, allExpiries) {
  const month = expiry.slice(0, 7);
  return allExpiries.filter((e) => e.slice(0, 7) === month).sort().pop() === expiry ? 'monthly' : 'weekly';
}
export { WEEKDAY };
