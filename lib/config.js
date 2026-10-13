// Index derivatives the app supports. Lot sizes follow NSE's revision effective January 2026;
// check them against your broker and edit here if NSE changes them again.
export const INDICES = {
  NIFTY:      { name: 'NIFTY 50',                  short: 'NIFTY',      lot: 65,  step: 50 },
  BANKNIFTY:  { name: 'NIFTY BANK',                short: 'BANK NIFTY', lot: 30,  step: 100 },
  FINNIFTY:   { name: 'NIFTY FINANCIAL SERVICES',  short: 'FIN NIFTY',  lot: 60,  step: 50 },
  MIDCPNIFTY: { name: 'NIFTY MIDCAP SELECT',       short: 'MIDCAP NIFTY', lot: 120, step: 25 },
  NIFTYNXT50: { name: 'NIFTY NEXT 50',             short: 'NIFTY NEXT 50', lot: 25,  step: 100 },
};
export const VIX_NAME = 'INDIA VIX';

export const PAPER = {
  startBalance: 500000,
  // Charges per executed leg (approximate retail discount-broker schedule for index options).
  brokeragePerOrder: 20,
  sttSellPct: 0.001,        // 0.1% of sell-side premium
  exchangePct: 0.0003503,   // NSE transaction charge on premium
  sebiPerCrore: 10,
  gstPct: 0.18,             // on brokerage + exchange + SEBI fees
  stampBuyPct: 0.00003,     // 0.003% on buy-side premium
  // Margin estimate for sold options: worst loss over a ±scan move, plus exposure margin.
  marginScanPct: 0.09,
  exposurePct: 0.02,
};

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
