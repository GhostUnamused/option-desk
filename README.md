# Option Desk

A local options workstation for NSE index options: live quotes and charts, a broker-style option chain, a strategy builder, and a paper trading account with a dummy balance.

## Start it

**As an app:** double-click **OptionDesk.exe**. It opens in its own window and needs nothing else installed. It quits by itself when you close the window. Click the **Live NSE / Simulated data** badge to switch markets. When a new version is out, an **Update to …** badge appears; click it to install. Your paper account is kept.

**From source:**

1. Install Node.js 18 or newer (LTS from nodejs.org) if you don't have it.
2. Double-click **start.bat**. A console window opens and your browser goes to http://localhost:4321.
3. Keep the console window open while you use the app. Close it (or press Ctrl+C) to stop.

From a terminal you can also run `node server.js`.

If NSE is unreachable (blocked network, NSE maintenance), double-click **start-simulated.bat** to run on a simulated market. The simulated account is kept separately from the real one.

## What's inside

| Tab | What it does |
| --- | --- |
| Markets | Live index chart (intraday, or daily candles with 20/50-day averages), a plain-English market read (trend, India VIX and its yearly percentile, implied vs realized volatility, expected move, put–call ratio, OI walls, max pain), and all F&O index quotes. |
| Option chain | NIFTY, BANK NIFTY, FIN NIFTY, MIDCAP NIFTY and NIFTY NEXT 50 chains, every expiry. Hover a row and press B or S to trade; click a price for that option's intraday chart and Greeks. |
| Strategy builder | Twelve preset strategies or your own legs, at live fill prices. Payoff chart, chance of profit, max profit and loss, breakevens, Greeks, a what-if grid, and margin. Place the whole strategy as one paper trade. |
| Paper account | ₹5,00,000 starting balance (changeable). Open positions with live P&L, a payoff chart of what you hold, account value over time, order history, reset. |

## How paper trades work

- Buys fill at the current ask and sells at the current bid, as on a real exchange.
- Charges are deducted on every leg: ₹20 brokerage, STT on sell premium, exchange and SEBI fees, GST and stamp duty (a typical discount-broker schedule).
- Selling options blocks an estimated margin: the worst expiry loss if the index moves ±9%, plus 2% exposure on unhedged short lots. Real broker margins (SPAN) differ.
- Positions still open after 3:30 pm on expiry day settle at intrinsic value against the index close.
- Your account is saved in `%LOCALAPPDATA%OptionDeskdatapaper.json` (the app and `node server.js` share it). Use Reset to start over.

## Where the data comes from

The server reads the same public JSON endpoints that nseindia.com uses in your browser. They are unofficial: NSE can rate-limit or change them. Prices refresh every few seconds, which is close to live but not tick-by-tick.

To use a broker's live feed later (Upstox, Zerodha Kite, Dhan and others offer APIs), add a provider in `lib/` with the same methods as `lib/nse.js` (`indices`, `marketStatus`, `expiries`, `chain`, `intraday`, `optionIntraday`, `daily`) and switch to it in `server.js`.

## Building and releasing the app

- `node tools/build.mjs` builds `dist/OptionDesk.exe` with the Node that runs it (no npm packages).
- To publish an update: raise `version` in package.json, then run `node tools/release.mjs "what changed"`. This needs the GitHub CLI signed in and `"updates": { "github": "owner/repo" }` in package.json, pointing at a public repo. Installed copies offer the update within a few hours or on their next start.

## Settings

Lot sizes, charges and the margin model are in `lib/config.js`. Lot sizes follow NSE's January 2026 revision (NIFTY 65, BANK NIFTY 30, FIN NIFTY 60, MIDCAP NIFTY 120, NIFTY NEXT 50 25); check them against your broker.

## Files

```
server.js            local web server and API
lib/nse.js           NSE data provider
lib/mock.js          simulated market
lib/paper.js         paper trading engine
lib/config.js        indices, lot sizes, charges, margin model
public/              the app (HTML, CSS, JavaScript)
public/js/bs.js      Black–Scholes pricing and Greeks
public/vendor/       TradingView Lightweight Charts 4.2.0 (Apache 2.0)
data/                your paper account (created on first run)
```

This is a learning and practice tool. It is not investment advice.
