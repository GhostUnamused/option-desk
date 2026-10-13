# Option Desk — notes for Claude Code

Local NSE index-options workstation (also packaged as a self-updating Windows app): guided lessons, live quotes and charts, broker-style option chain, strategy builder, paper trading with a dummy balance. Owner is a beginner learning options; keep UI copy plain and explain finance terms in the interface.

## Run
- `node server.js` → http://localhost:4321 (live NSE). `node server.js --sim` (or `--replay`, `MOCK=1`) → replay mode: real past NSE days from a local SQLite store, separate account file. The UI still calls it the simulated/replay switch.
- Windows: `start.bat`, `start-simulated.bat`. Node ≥ 22.13 (replay uses the built-in `node:sqlite`; live mode still runs on older Node), zero npm dependencies — keep it that way unless there's a strong reason.
- Tests: `npm test` (`node --test "test/*.test.js"`, built-in runner). `test/snapshot.test.js` guards the replay as-of gate; keep it passing.
- Desktop app: `node tools/build.mjs` → `dist/OptionDesk.exe` (Node single executable, GUI subsystem, opens an Edge/Chrome app window). Release: raise `version` in package.json, then `node tools/release.mjs "notes"` (needs `gh` and `updates.github` in package.json). Bump `LAUNCHER_VERSION` in `tools/launcher.cjs` only when that file changes; installed apps then download a new exe too.
- Testing the exe: always isolate it from the owner's install with `OPTION_DESK_HOME=<scratch dir> OPTION_DESK_NO_WINDOW=1 PORT=4399` (and `OPTION_DESK_UPDATE_URL=http://127.0.0.1:<port>/` for a fake release). Commands run by Claude Code here are inside the Claude desktop app's MSIX container, so their %LOCALAPPDATA% writes land in %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local: the owner's real OptionDesk folder and log are not what you see. Never run test servers on 4321, the app's port; the preview config uses 4322 (`--port`).
- Test UI changes in `--sim` mode first. Replay needs some history in `replay.db`: download a few months from the Replay tab (NSE's archive host `nsearchives.nseindia.com` is reachable from here; the live JSON API may not be).

## Layout
- `server.js` — http server, JSON API (`/api/indices`, `/api/expiries`, `/api/chain`, `/api/intraday`, `/api/daily`, `/api/option-intraday`, `/api/account`, `/api/preview`, `/api/order`, `/api/exit`, `/api/reset`, replay-only `/api/replay` (status), `/api/replay/{download,download/cancel,start,step,end,settings,journal}`, plus `/api/meta` and the desktop endpoints `/api/update`, `/api/restart`, `/api/ping`, `/api/bye`, `/api/quit`) and static files from `public/`.
- `lib/nse.js` — NSE provider (cookie warm-up on `/` and `/option-chain`, 4 s cache, de-duped requests, ~120 ms spacing). `lib/replay/provider.js` — same interface, answered from history (see Replay below). A broker provider should implement the same methods: `indices, marketStatus, expiries, chain, intraday, optionIntraday, daily`.
- `lib/desktop.js` — data folder (`%LOCALAPPDATA%\OptionDesk\data`, shared by source runs and the exe; migrates an old project `data/*.json` once), update check/install from GitHub Releases, restart (live/sim switch), quit when the last window closes. `tools/launcher.cjs` is the exe entry: unpacks the embedded app to `%LOCALAPPDATA%\OptionDesk\app\<version>` and loads its server.js (via require(esm), so no top-level await in server/lib). Exe logs: `%LOCALAPPDATA%\OptionDesk\logs`.
- `lib/paper.js` — paper engine: buys at ask / sells at bid, per-leg charges, netting, realized P&L, margin estimate (`marginFor`), expiry settlement at intrinsic, equity snapshots. State in `paper.json` under the data folder (atomic writes; `file: null` keeps it in memory). The clock is injectable (`opts.now`) and fills carry the contract's lot (`q.lot`), which is how the replay account reuses it.
- `lib/config.js` — indices, lot sizes (Jan 2026 revision), charges, margin model, risk-free rate; replay tables `LOT_HISTORY`/`KNOWN_LOTS` (lot by trade date), `EXPIRY_RULES` (weekly/monthly weekday by date), `REPLAY` (symbols, slippage model, defaults), helpers `lotOn`, `expiryRule`, `expiryKind`.
- `public/js/` — plain ES modules, no build step. `app.js` (header, India VIX block, tabs, beginner guide, tab intros, polling every 5 s), `learn.js` (Learn tab: 6 guided lessons + Black–Scholes slider playground + Greeks cheat sheet; progress in localStorage), `glossary.js` (plain-English term tooltips via `term()`), `state.js` (shared state + event bus: quotes, symbol, expiries, chain, account, addLeg, goto), `markets.js`, `chain.js`, `drawer.js` (option detail), `ticket.js` (order dialog, single or basket), `strategy.js`, `positions.js`, `payoff.js` (P&L math + SVG payoff chart), `bs.js` (Black–Scholes, shared with server; `setClock`/`now` is the page's "now", set to the replay day's close in replay), `util.js`, `replay.js` (Replay tab + control bar under the tabs; only in replay mode).
- `public/vendor/` — TradingView Lightweight Charts 4.2.0 (UMD global `LightweightCharts`), served locally.

## NSE endpoint notes (unofficial, may change)
- `/api/allIndices`, `/api/marketStatus`, `/api/option-chain-contract-info?symbol=`, `/api/option-chain-v3?type=Indices&symbol=&expiry=DD-Mon-YYYY`
- Intraday index: `/api/NextApi/apiClient/indexTrackerApi?functionName=getIndexChart&&index=NIFTY%2050&flag=1D` — timestamps are IST wall-clock encoded as UTC epoch ms; points flagged `PO` are pre-open.
- Option intraday: `/api/chart-databyindex?index=<identifier>` (e.g. `OPTIDXNIFTY19-10-2026CE22500.00`).
- Daily history: `/api/historicalOR/indicesHistory?indexType=NIFTY%2050&from=DD-MM-YYYY&to=DD-MM-YYYY`, VIX: `/api/historicalOR/vixhistory?from=&to=` — fetched in 90-day windows.

## Replay (the simulated mode)
- Data: per trading day, the F&O bhavcopy (`nsearchives.nseindia.com/content/historical/DERIVATIVES/YYYY/MON/foDDMONYYYYbhav.csv.zip` until 2024-07-05, then UDiFF `content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip`) and `content/indices/ind_close_all_DDMMYYYY.csv` (NIFTY 50, NIFTY BANK, India VIX OHLC). No cookies needed. Weekends are probed too (budget days, muhurat). Only NIFTY/BANKNIFTY index options are kept (`REPLAY.symbols`). Volume is contracts in both formats; OI is units.
- `lib/replay/bhavcopy.js` — URLs, zip reader (central directory; local headers lack sizes), `parseFo` (detects format by header), `parseIndexClose`, `inferLot` (old format has no lot: gcd of a contract's OI figures, checked against `LOT_HISTORY`/`KNOWN_LOTS`; lots are per contract during revisions).
- `lib/replay/store.js` — `replay.db` (node:sqlite via `process.getBuiltinModule`, so live mode never loads it): `days` (trading/holiday/error), `options`, `indices`, `settings`. Writes and calendar questions only.
- `lib/replay/snapshot.js` — **the as-of gate**. All replay market reads go through `getSnapshot(store, asOf)`; every query must bind `date <= ?`/`= ?`/`< ?`, and each returned row is checked (`AsOfViolation`). Price = close if it traded, else NSE's settlement price. IV is backed out of that price per row (`impliedVol`, configurable risk-free rate) with Greeks; `T` runs to 15:30 IST on expiry from 15:30 on as-of.
- `lib/replay/fills.js` — bid/ask around the day's price: half-spread grows with distance from spot and with low volume (`REPLAY.slippage`), on the 0.05 tick. `lib/replay/account.js` — `ReplayAccount extends PaperAccount`: replay clock, `replay.json`, zero-volume strikes refused (`checkQuote`), marks at the day's price, one equity point per day, `journal()` (trades with notes, P&L by day, summary stats).
- `lib/replay/engine.js` — session (`start`, `step` by day/week/expiry, walking every trading day in between so settlements and equity points happen, `end`), `serial()` lock for steps and orders, `blindDays()`. `lib/replay/download.js` — background downloader (3 workers, retries, progress). `lib/replay/blind.js` — blind mode: `server.js` shifts every date in responses by a multiple of 7 days (and back on requests), so the page needs no blind logic. Keep any new date fields as ISO strings, or epoch numbers under `t`/`openedAt`/`now`, or they will leak in blind mode.
- Backtester (not built yet): loop `store.tradingDaysBetween(from, to)`, take `getSnapshot(store, day)` for each, let a rule decide orders from that snapshot alone, and run them through a `ReplayAccount` with `file: null` and a clock pointing at the day (`ReplayEngine(dir, { accountFile: null })` already works headless; see `test/replay.test.js`). `EXPIRY_RULES`/`lotOn` answer "next weekly" and lot questions for rules.

## Conventions
- Indian number formatting (`en-IN`, lakh/crore via `util.compact`), ₹ amounts, IST times.
- Colors only via CSS tokens in `public/css/app.css` (single premium-black theme, TradingView-style). Gains `--up`, losses `--down`; No blue: `--accent` is a white/silver fill (black text on it), `--accent-text` for highlighted text. India VIX has its own header block (`renderVix` in app.js, bands in `util.vixMood`).
- Paper trading only; never add real order placement.

## Known gaps / next ideas
- Market orders only (no limit/stop orders, no GTT).
- Margin is an estimate, not SPAN.
- No stock options yet (indices only); no SENSEX/BANKEX (BSE).
- No IV history in live mode. Replay's `replay.db` has every day's option closes, so a true IV rank (from stored ATM IV) can be built from it.
- Replay has no intraday data (bhavcopy is end of day), only NIFTY/BANKNIFTY, and blind mode can't hide the index level itself (NIFTY at 8,000 says "2016").
- Broker live feed (Upstox / Kite / Dhan) as an alternative provider.
