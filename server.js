// Optionwise local server. Run: node server.js   (--sim or MOCK=1 for the replay market: real past NSE days). Optionwise.exe runs this same file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NseProvider } from './lib/nse.js';
import { IndstocksProvider } from './lib/indstocks.js';
import { loadDotEnv, SecretFile } from './lib/secrets.js';
import { PaperAccount } from './lib/paper.js';
import { INDICES, PAPER, RISK_FREE, REPLAY, CHARGES, addStock, removeStock } from './lib/config.js';
import * as desktop from './lib/desktop.js';
import { ReplayEngine } from './lib/replay/engine.js';
import { ReplayProvider } from './lib/replay/provider.js';
import { disguise } from './lib/replay/blind.js';
import { News } from './lib/news.js';
import { eventsUpTo } from './lib/events.js';
import { LiveOptionHistory } from './lib/opthist.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT) || 4321;
// "Simulated" mode is the replay: practise on real past days, stepped forward one trading day at a time.
const MOCK = process.env.MOCK === '1' || process.argv.includes('--sim') || process.argv.includes('--replay');
desktop.migrateData();
loadDotEnv(path.join(ROOT, '.env')); // source runs only: INDSTOCKS_TOKEN for the broker feed (the exe asks in the page instead)
let replay = null, replayError = null;
// Replay downloads minute history from INDstocks with the same token as live mode (.env or the one saved in the app).
const history = MOCK ? new IndstocksProvider(new NseProvider(), new SecretFile(path.join(desktop.DATA_DIR, 'broker.dat'))) : null;
if (MOCK) { try { replay = new ReplayEngine(desktop.DATA_DIR, { history: () => history }); } catch (e) { replayError = e.message; console.log(`  Replay unavailable: ${e.message}`); } }
// Live prices come from INDstocks when it has a token, else from NSE's website (IndstocksProvider falls back by itself).
const broker = MOCK ? null : new IndstocksProvider(new NseProvider(), new SecretFile(path.join(desktop.DATA_DIR, 'broker.dat')), { stream: true });
// Stocks the owner follows (their options join the symbol list). Kept with their lot, strike step and INDstocks id.
const WATCH_FILE = path.join(desktop.DATA_DIR, 'watchlist.json');
let watchlist = []; try { watchlist = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')); } catch {}
if (!MOCK) for (const s of watchlist) addStock(s);
const saveWatchlist = () => { fs.mkdirSync(desktop.DATA_DIR, { recursive: true }); fs.writeFileSync(WATCH_FILE, JSON.stringify(watchlist, null, 1)); };
const STOCKS_FILE = path.join(desktop.DATA_DIR, 'fno-stocks.json');
const provider = MOCK ? (replay?.provider || new ReplayProvider({ snapshot() { throw new Error(replayError); } })) : broker;
const account = MOCK ? replay?.account : new PaperAccount(path.join(desktop.DATA_DIR, 'paper.json'), provider);
const news = new News({ cacheFile: path.join(desktop.DATA_DIR, 'news-cache.json') });
const liveHist = MOCK ? null : new LiveOptionHistory(desktop.DATA_DIR, provider);
const istToday = () => new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
// Headlines and event names give the real date away, so a blind session gets none.
const BLIND_NEWS = 'News and event markers are hidden in blind mode, because headlines would give away the real date.';
const needBroker = () => { if (!broker) throw new Error('Option history comes from INDstocks, so it works with live prices only.'); if (!broker.usable()) throw new Error('Connect INDstocks (the Data button in the tab bar) to see option history.'); return broker; };
const needAccount = () => { if (!account) throw new Error(replayError); return account; };
const NOT_REPLAY = 'Replay is only available after switching to replay (node server.js --sim).';
const needReplay = () => { if (!replay) throw new Error(replayError || NOT_REPLAY); return replay; };
// Indices the page offers: replay has NIFTY and BANK NIFTY, with the lot size in force on the replay date.
async function metaIndices() {
  // Live: BSE indices and stocks only have data through INDstocks, so they are offered once a token is in.
  if (!MOCK) return Object.fromEntries(Object.entries(INDICES).filter(([, v]) => !v.broker || broker.token));
  const out = Object.fromEntries(REPLAY.symbols.map((s) => [s, { ...INDICES[s] }]));
  try { for (const i of (await provider.indices()).indices) out[i.symbol].lot = i.lot; } catch {}
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('Request too large'); }
  return s ? JSON.parse(s) : {};
}
const sym = (q) => { const s = (q.get('symbol') || 'NIFTY').toUpperCase(); if (!INDICES[s] && s !== 'INDIAVIX') throw new Error(`Unknown index ${s}`); return s; };

const routes = {
  'GET /api/meta': async () => ({ provider: provider.name, mock: MOCK, broker: broker ? broker.status() : null, indices: await metaIndices(), paper: { startBalance: MOCK ? REPLAY.startBalance : PAPER.startBalance }, riskFree: replay ? replay.riskFree() : RISK_FREE, app: desktop.info(),
    charges: { brokers: CHARGES.brokers, perOrder: CHARGES.brokeragePerOrder },
    replay: MOCK ? (replay ? replay.publicState() : { available: false, error: replayError }) : null }),
  'GET /api/indices': async () => ({ ...(await provider.indices()), market: await provider.marketStatus().catch(() => null), broker: broker?.status() }),
  'GET /api/expiries': async (q) => ({ expiries: await provider.expiries(sym(q)), unpriced: (await provider.unpricedExpiries?.(sym(q))) || [] }),
  'GET /api/chain': async (q) => provider.chain(sym(q), q.get('expiry')),
  'GET /api/intraday': async (q) => provider.intraday(sym(q)),
  'GET /api/daily': async (q) => ({ rows: await provider.daily(sym(q), Math.min(Number(q.get('days')) || 365, 730)) }),
  'GET /api/option-intraday': async (q) => provider.optionIntraday(q.get('id')),
  // Option price history from INDstocks: live contracts by id, expired ones by trading symbol (live mode only).
  'GET /api/option-candles': async (q) => needBroker().optionCandles(q.get('id'), q.get('range') || '1D'),
  'GET /api/expired/expiries': async (q) => ({ expiries: await needBroker().expiredExpiries(sym(q)) }),
  'GET /api/expired/contracts': async (q) => ({ contracts: await needBroker().expiredContracts(sym(q), q.get('expiry')) }),
  'GET /api/expired/candles': async (q) => needBroker().expiredCandles(q.get('contract'), q.get('expiry'), q.get('range') || 'week'),
  'GET /api/option-history': async (q) => {
    const days = Math.min(Number(q.get('days')) || 365, 730);
    if (MOCK) return { rows: needReplay().snapshot().optionHistory(sym(q), days), intraday: [] };
    return liveHist.history(sym(q), days, Boolean((await provider.marketStatus().catch(() => null))?.open));
  },
  'GET /api/news': async (q) => {
    if (!MOCK) return news.latest(sym(q), q.get('refresh') === '1');
    if (needReplay().blindDays()) return { hidden: true, reason: BLIND_NEWS, items: [] };
    const s = replay.snapshot();
    return news.asOf(s.date, sym(q), s.now);
  },
  'GET /api/events': async () => {
    if (!MOCK) return { events: eventsUpTo(istToday()) };
    if (needReplay().blindDays()) return { hidden: true, reason: BLIND_NEWS, events: [] };
    // While a replay day is running, its surprises have not happened yet; scheduled events show by name only.
    const s = replay.snapshot();
    return { events: eventsUpTo(s.date).flatMap((e) => (!s.live || e.date < s.date ? [e] : e.kind === 'scheduled' ? [{ ...e, note: '' }] : [])) };
  },
  'GET /api/account': async () => needAccount().summary(),
  'POST /api/preview': async (q, b) => needAccount().preview(b.legs),
  'POST /api/order': async (q, b) => tradeLock(async () => {
    if (!String(b.note || '').trim()) throw new Error('Write at least one character in your journal entry before placing the trade.');
    return { ...(await canTrade().place(b.legs, b.tag || '', b.note || '', b.plan || '')), account: await account.summary() };
  }),
  'POST /api/exit': async (q, b) => tradeLock(async () => ({ ...(await canTrade().exit(b.key)), account: await account.summary() })),
  'POST /api/exit-rules': async (q, b) => tradeLock(async () => {
    const a = canTrade(); a.setExitRules(b.key, { stop: b.stop, target: b.target });
    return { account: await a.summary() };
  }),
  'POST /api/reset': async (q, b) => { if (MOCK) throw new Error('Start a new replay session in the Replay tab instead.'); account.reset(b.balance); return account.summary(); },
  // Replay (simulated mode only)
  'GET /api/replay': async () => needReplay().status(),
  'GET /api/replay/journal': async () => needReplay().account.journal(),
  'POST /api/replay/download': async (q, b) => needReplay().downloader.start(b.from, b.to, { retryHolidays: Boolean(b.retryHolidays), symbols: b.symbols }),
  'POST /api/replay/download/cancel': async () => needReplay().downloader.cancel(),
  'POST /api/replay/minutes/download': async (q, b) => needReplay().minutes.start(b.from, b.to, b.symbols),
  'POST /api/replay/minutes/cancel': async () => needReplay().minutes.cancel(),
  'POST /api/replay/start': async (q, b) => needReplay().start(b),
  'POST /api/replay/step': async (q, b) => needReplay().step(b),
  'POST /api/replay/end': async () => needReplay().end(),
  'POST /api/replay/review': async (q, b) => needReplay().saveReview(b.review || {}),
  'POST /api/replay/settings': async (q, b) => needReplay().setRiskFree(b.riskFreePct),
  // Stock options: search the stocks that have options, and follow or drop one (live mode, INDstocks).
  'GET /api/stocks': async (q) => {
    const list = await needBroker().stockList(STOCKS_FILE), s = (q.get('q') || '').trim().toUpperCase();
    const hits = s ? list.filter((x) => x.symbol.includes(s) || x.name.toUpperCase().includes(s)).sort((a, b) => (b.symbol.startsWith(s) - a.symbol.startsWith(s)) || a.symbol.localeCompare(b.symbol)) : list;
    return { stocks: hits.slice(0, 40).map((x) => ({ ...x, watched: watchlist.some((w) => w.symbol === x.symbol) })), total: list.length, watchlist };
  },
  'POST /api/watchlist': async (q, b) => {
    const symbol = String(b.symbol || '').toUpperCase();
    if (b.add) {
      if (watchlist.length >= 15) throw new Error('You can follow up to 15 stocks. Remove one first.');
      const s = (await needBroker().stockList(STOCKS_FILE)).find((x) => x.symbol === symbol);
      if (!s) throw new Error(`${symbol} has no listed options.`);
      if (!watchlist.some((w) => w.symbol === symbol)) { watchlist.push(s); addStock(s); saveWatchlist(); }
    } else {
      if ((account?.state?.positions || []).some((p) => p.symbol === symbol)) throw new Error(`Close your ${symbol} positions before removing it.`);
      watchlist = watchlist.filter((w) => w.symbol !== symbol); removeStock(symbol); saveWatchlist();
    }
    return { indices: await metaIndices(), watchlist };
  },
  // Broker connection (live mode). The token goes in, never comes back out: status only says whether it works.
  'GET /api/broker': async () => (broker ? broker.status() : { available: false }),
  'POST /api/broker': async (q, b) => { if (!broker) throw new Error('Switch to live prices to connect INDstocks.'); return broker.setToken(b.token); },
  'POST /api/broker/forget': async () => { if (!broker) throw new Error('Switch to live prices first.'); return broker.forget(); },
  'GET /api/update': async (q) => desktop.checkUpdate(q.get('force') === '1'),
  'POST /api/update': async () => { const r = await desktop.installUpdate(); desktop.restart(MOCK); return r; },
  'POST /api/restart': async (q, b) => { desktop.restart(b.sim ?? MOCK); return { ok: true }; },
  'POST /api/ping': async (q) => { desktop.ping(q.get('c')); return { version: desktop.VERSION, mock: MOCK }; },
  'POST /api/bye': async (q) => { desktop.bye(q.get('c')); return {}; },
  'POST /api/quit': async () => { if (desktop.PACKAGED) setTimeout(() => desktop.quit('asked by a newer copy'), 50); return { ok: desktop.PACKAGED }; },
};

// Replay orders wait for any running step, and need a running session.
const tradeLock = (fn) => (replay ? replay.serial(fn) : fn());
function canTrade() {
  const a = needAccount();
  if (replay && !replay.active()) throw new Error(replay.session ? 'This replay session has ended. Start a new one in the Replay tab.' : 'Start a replay session in the Replay tab first.');
  return a;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Live ticks for the page (server-sent events). Replay, or no broker: the page just keeps polling.
  if (url.pathname === '/api/stream') { if (!broker?.stream) { res.writeHead(204); return res.end(); } return broker.stream.attach(res); }
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    // Only this app's own page may change things: a POST from any other website (Origin set and not ours) is refused.
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Forbidden' });
    // Blind replay: the page only sees disguised dates, so translate them back on the way in and out.
    const inDays = replay?.blindDays() || 0;
    const q = new URLSearchParams([...url.searchParams].map(([k, v]) => [k, disguise(v, -inDays)]));
    try {
      const b = req.method === 'POST' ? disguise(await body(req), -inDays) : null;
      const out = await route(q, b);
      send(res, 200, disguise(out, replay?.blindDays() || 0));
    } catch (e) { send(res, 400, { error: disguise(e.message || String(e), replay?.blindDays() || 0) }); }
    return;
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(ROOT, 'public', rel));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

desktop.attach(server);
// After a restart the previous copy may hold the port for a moment, so retry briefly.
let tries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && desktop.env('RESTART') === '1' && ++tries < 40) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Optionwise is running: http://localhost:${PORT}`);
  console.log(`  Data: ${MOCK ? 'replay of past NSE days' : 'live (INDstocks when connected, else NSE website)'} · Account: ${path.join(desktop.DATA_DIR, MOCK ? 'replay.json' : 'paper.json')}`);
  if (desktop.PACKAGED && desktop.env('RESTART') !== '1' && !desktop.env('NO_WINDOW')) desktop.openWindow(`http://localhost:${PORT}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
  if (!MOCK) console.log(`  INDstocks: ${broker.token ? `token from ${broker.source === 'env' ? '.env' : 'the app (encrypted)'}` : 'no token yet, using NSE website data'}`);
  if (!MOCK) provider.indices().then(() => console.log(`  Connected to ${provider.name}.`)).catch((e) => console.log(`  Could not reach NSE yet: ${e.message}. The app will keep retrying.`));
});
