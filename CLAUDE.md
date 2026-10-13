# Option Desk — notes for Claude Code

Local NSE index-options workstation: live quotes and charts, broker-style option chain, strategy builder, paper trading with a dummy balance. Owner is a beginner learning options; keep UI copy plain and explain finance terms in the interface.

## Run
- `node server.js` → http://localhost:4321 (live NSE). `node server.js --sim` (or `MOCK=1`) → simulated market, separate account file.
- Windows: `start.bat`, `start-simulated.bat`. Node ≥ 18, zero npm dependencies — keep it that way unless there's a strong reason.
- Desktop app: `node tools/build.mjs` → `dist/OptionDesk.exe` (Node single executable, GUI subsystem, opens an Edge/Chrome app window). Release: raise `version` in package.json, then `node tools/release.mjs "notes"` (needs `gh` and `updates.github` in package.json). Bump `LAUNCHER_VERSION` in `tools/launcher.cjs` only when that file changes; installed apps then download a new exe too.
- Testing the exe: always isolate it from the owner's install with `OPTION_DESK_HOME=<scratch dir> OPTION_DESK_NO_WINDOW=1 PORT=4399` (and `OPTION_DESK_UPDATE_URL=http://127.0.0.1:<port>/` for a fake release). Never run test servers on 4321, the app's port; the preview config uses 4322 (`--port`).
- Test UI changes in `--sim` mode first; NSE is only reachable on the owner's machine/network.

## Layout
- `server.js` — http server, JSON API (`/api/indices`, `/api/expiries`, `/api/chain`, `/api/intraday`, `/api/daily`, `/api/option-intraday`, `/api/account`, `/api/preview`, `/api/order`, `/api/exit`, `/api/reset`) and static files from `public/`.
- `lib/nse.js` — NSE provider (cookie warm-up on `/` and `/option-chain`, 4 s cache, de-duped requests, ~120 ms spacing). `lib/mock.js` — same interface, simulated. A broker provider should implement the same methods: `indices, marketStatus, expiries, chain, intraday, optionIntraday, daily`.
- `lib/desktop.js` — data folder (`%LOCALAPPDATA%OptionDeskdata`, shared by source runs and the exe; migrates old `data/*.json` once), update check/install from GitHub Releases, restart (live/sim switch), quit when the last window closes. `tools/launcher.cjs` is the exe entry: unpacks the embedded app to `%LOCALAPPDATA%OptionDeskapp<version>` and loads its server.js (via require(esm), so no top-level await in server/lib). Exe logs: `%LOCALAPPDATA%OptionDesklogs`.
- `lib/paper.js` — paper engine: buys at ask / sells at bid, per-leg charges, netting, realized P&L, margin estimate (`marginFor`), expiry settlement at intrinsic, equity snapshots. State in `paper.json` (`paper-sim.json` in sim) under the data folder. Atomic writes.
- `lib/config.js` — indices, lot sizes (Jan 2026 revision), charges, margin model, risk-free rate.
- `public/js/` — plain ES modules, no build step. `app.js` (header, India VIX block, tabs, beginner guide, tab intros, polling every 5 s), `learn.js` (Learn tab: 6 guided lessons + Black–Scholes slider playground + Greeks cheat sheet; progress in localStorage), `glossary.js` (plain-English term tooltips via `term()`), `state.js` (shared state + event bus: quotes, symbol, expiries, chain, account, addLeg, goto), `markets.js`, `chain.js`, `drawer.js` (option detail), `ticket.js` (order dialog, single or basket), `strategy.js`, `positions.js`, `payoff.js` (P&L math + SVG payoff chart), `bs.js` (Black–Scholes, shared with server), `util.js`.
- `public/vendor/` — TradingView Lightweight Charts 4.2.0 (UMD global `LightweightCharts`), served locally.

## NSE endpoint notes (unofficial, may change)
- `/api/allIndices`, `/api/marketStatus`, `/api/option-chain-contract-info?symbol=`, `/api/option-chain-v3?type=Indices&symbol=&expiry=DD-Mon-YYYY`
- Intraday index: `/api/NextApi/apiClient/indexTrackerApi?functionName=getIndexChart&&index=NIFTY%2050&flag=1D` — timestamps are IST wall-clock encoded as UTC epoch ms; points flagged `PO` are pre-open.
- Option intraday: `/api/chart-databyindex?index=<identifier>` (e.g. `OPTIDXNIFTY19-10-2026CE22500.00`).
- Daily history: `/api/historicalOR/indicesHistory?indexType=NIFTY%2050&from=DD-MM-YYYY&to=DD-MM-YYYY`, VIX: `/api/historicalOR/vixhistory?from=&to=` — fetched in 90-day windows.

## Conventions
- Indian number formatting (`en-IN`, lakh/crore via `util.compact`), ₹ amounts, IST times.
- Colors only via CSS tokens in `public/css/app.css` (single premium-black theme, TradingView-style). Gains `--up`, losses `--down`; No blue: `--accent` is a white/silver fill (black text on it), `--accent-text` for highlighted text. India VIX has its own header block (`renderVix` in app.js, bands in `util.vixMood`).
- Paper trading only; never add real order placement.

## Known gaps / next ideas
- Market orders only (no limit/stop orders, no GTT).
- Margin is an estimate, not SPAN.
- No stock options yet (indices only); no SENSEX/BANKEX (BSE).
- No IV history storage yet — saving a daily chain snapshot would enable true IV rank.
- Broker live feed (Upstox / Kite / Dhan) as an alternative provider.
