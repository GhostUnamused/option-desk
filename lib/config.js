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
