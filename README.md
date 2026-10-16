# Option Desk

A practice desk for NSE index options. Learn how options are priced, watch live quotes and charts, read a broker-style option chain, build strategies, and trade them on a paper account with a dummy balance. No real money and no real orders, ever.

Current version: **0.7.4**

## Start it

**As an app (Windows):** double-click **OptionDesk.exe**. It opens in its own window and needs nothing else installed. Close the window and it quits by itself a few seconds later.

- The first time, Windows SmartScreen may say "Windows protected your PC" because the app is not code-signed. Click **More info**, then **Run anyway**.
- When a new version is out, an **Update to …** badge appears at the top. Click it; the app downloads, restarts and shows "Updated to …". Your paper account is kept.
- **Switch to replay / Switch to live prices** (next to the data badge) restarts the app in replay mode (real past market days, see below) or back on live NSE prices. Use replay to practise when the market is closed.

**From source:** install Node.js 22.13 or newer, then double-click **start.bat** (live) or **start-simulated.bat** (replay). Your browser opens http://localhost:4321. Keep the console window open while you use it. From a terminal: `node server.js` or `node server.js --sim`. Tests: `npm test`.

## What's inside

| Tab | What it does |
| --- | --- |
| Learn | Six short lessons on what moves an option's price (premium, delta, theta, vega, gamma, buying vs selling), each with a slider experiment and a check question. Includes a Black–Scholes playground and a Greeks cheat sheet. Progress is remembered. |
| Markets | Index chart (intraday, or daily candles with 20/50-day averages), a plain-English market read (trend, India VIX and its yearly percentile, implied vs realized volatility, expected move, put–call ratio, OI walls, max pain), and all F&O index quotes. |
| Option chain | NIFTY, BANK NIFTY, FIN NIFTY, MIDCAP NIFTY and NIFTY NEXT 50, every expiry. Hover a row and press B or S to trade; click a price for that option's intraday chart and Greeks. |
| Strategy builder | Twelve preset strategies or your own legs, at live fill prices. Payoff chart, chance of profit, max profit and loss, breakevens, Greeks, a what-if grid and margin. Place the whole strategy as one paper trade. |
| Replay (replay mode) | Download NSE history, start a session on any past day (optionally blind), step through it day by day, and read your trade journal and end-of-session summary. |
| Paper account | ₹5,00,000 starting balance (changeable). Open positions with live P&L, a payoff chart of what you hold, account value over time, order history and reset. |

Also: India VIX (the market's "fear gauge") in the header, a **Beginner guide** button, and dotted-underlined words that explain themselves when you hover or tap them.

## Replay: practise on real past days

Replay mode replaces live prices with NSE's own end-of-day records, so you can practise any time, including when the market is closed.

1. **Download history** in the Replay tab: pick a date range (three to six months is a good start). The app fetches NSE's daily F&O bhavcopy (the old format before July 2024 and the current UDiFF one), the NIFTY 50 and NIFTY BANK closes and India VIX, keeps NIFTY and BANK NIFTY options, and stores them on your computer in `replay.db`. About 1 MB to download per trading day; nothing is bundled in the app.
2. **Start a session** on a day of your choice, or a random day. Tick **Blind mode** to hide the real date until you finish: dates are shifted to a made-up year, while weekdays and days to expiry stay true.
3. **Trade** from the option chain or strategy builder as usual. Each option's implied volatility and Greeks are worked out from its closing price (the risk-free rate is a setting). Orders fill at the day's close plus slippage (more for strikes far from the index or with few trades), and strikes that did not trade that day are refused. The order ticket asks why you are taking the trade, and that goes into your journal.
4. **Move forward** with the bar under the tabs: **+1 day**, **+1 week**, **Next expiry**, or **Play** to step one trading day every few seconds. Weekends and holidays are skipped, and positions still open on expiry day settle at that day's index close.
5. **End the session** to see your summary: P&L, win rate, best and worst day, largest drop, charges, P&L by day and every trade with your reason.

The replay balance (`replay.json`) is separate from the live paper account. Every number on screen comes from the replay day or earlier; the code that reads history refuses anything dated later.

## How paper trades work

- Buys fill at the current ask and sells at the current bid, like a real exchange. Market orders only.
- Every leg pays charges: ₹20 brokerage, STT on sell premium, exchange and SEBI fees, GST and stamp duty (a typical discount-broker schedule).
- Selling options blocks an estimated margin: the worst expiry loss if the index moves ±9%, plus 2% exposure on unhedged short lots. Real broker margins (SPAN) differ.
- Positions still open after 3:30 pm on expiry day settle at intrinsic value against the index close.
- The account is saved in `%LOCALAPPDATA%\OptionDesk\data\paper.json` (replay keeps `replay.json` and `replay.db` next to it). The app and `node server.js` share it.

## Where the prices come from

The same public JSON endpoints nseindia.com uses in your browser. They are unofficial, so NSE can rate-limit or change them. Prices refresh every few seconds: close to live, not tick-by-tick.

To plug in a broker's live feed later (Upstox, Zerodha Kite, Dhan), add a provider in `lib/` with the same methods as `lib/nse.js` and switch to it in `server.js`.

## Settings

Lot sizes, charges and the margin model are in `lib/config.js`. Lot sizes follow NSE's January 2026 revision (NIFTY 65, BANK NIFTY 30, FIN NIFTY 60, MIDCAP NIFTY 120, NIFTY NEXT 50 25); check them against your broker.

## Building and releasing

- `node tools/build.mjs` builds `dist/OptionDesk.exe` plus the release files, using the Node that runs it. No npm packages needed.
- To publish an update: raise `version` in package.json, then run `node tools/release.mjs "what changed"`. Needs the GitHub CLI signed in; releases go to the repo in `updates.github` in package.json. Installed copies offer the update within a few hours or on their next start.

## Files

```
server.js           local web server and API
lib/nse.js          live NSE data
lib/replay/         replay mode: history download, SQLite store, as-of snapshots, fills, sessions, blind mode
lib/paper.js        paper trading engine
lib/config.js       indices, lot sizes, charges, margin model
lib/desktop.js      data folder, updates, restart and quit for the app
public/             the app itself (HTML, CSS, JavaScript, icons)
public/vendor/      TradingView Lightweight Charts 4.2.0 (Apache 2.0)
tools/              exe build, launcher and release scripts
start*.bat          run from source on Windows
test/               unit tests (npm test)
```

This is a learning and practice tool. It is not investment advice.
