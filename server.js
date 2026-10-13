// Option Desk local server. Run: node server.js   (--sim or MOCK=1 for a simulated market). OptionDesk.exe runs this same file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NseProvider } from './lib/nse.js';
import { MockProvider } from './lib/mock.js';
import { PaperAccount } from './lib/paper.js';
import { INDICES, PAPER, RISK_FREE } from './lib/config.js';
import * as desktop from './lib/desktop.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT) || 4321;
const MOCK = process.env.MOCK === '1' || process.argv.includes('--sim');
const provider = MOCK ? new MockProvider() : new NseProvider();
desktop.migrateData();
const account = new PaperAccount(path.join(desktop.DATA_DIR, MOCK ? 'paper-sim.json' : 'paper.json'), provider);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

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
  'GET /api/meta': async () => ({ provider: provider.name, mock: MOCK, indices: INDICES, paper: { startBalance: PAPER.startBalance }, riskFree: RISK_FREE, app: desktop.info() }),
  'GET /api/indices': async () => ({ ...(await provider.indices()), market: await provider.marketStatus().catch(() => null) }),
  'GET /api/expiries': async (q) => ({ expiries: await provider.expiries(sym(q)) }),
  'GET /api/chain': async (q) => provider.chain(sym(q), q.get('expiry')),
  'GET /api/intraday': async (q) => provider.intraday(sym(q)),
  'GET /api/daily': async (q) => ({ rows: await provider.daily(sym(q), Math.min(Number(q.get('days')) || 365, 730)) }),
  'GET /api/option-intraday': async (q) => provider.optionIntraday(q.get('id')),
  'GET /api/account': async () => account.summary(),
  'POST /api/preview': async (q, b) => account.preview(b.legs),
  'POST /api/order': async (q, b) => ({ ...(await account.place(b.legs, b.tag || '')), account: await account.summary() }),
  'POST /api/exit': async (q, b) => ({ ...(await account.exit(b.key)), account: await account.summary() }),
  'POST /api/reset': async (q, b) => { account.reset(b.balance); return account.summary(); },
  'GET /api/update': async (q) => desktop.checkUpdate(q.get('force') === '1'),
  'POST /api/update': async () => { const r = await desktop.installUpdate(); desktop.restart(MOCK); return r; },
  'POST /api/restart': async (q, b) => { desktop.restart(b.sim ?? MOCK); return { ok: true }; },
  'POST /api/ping': async (q) => { desktop.ping(q.get('c')); return {}; },
  'POST /api/bye': async (q) => { desktop.bye(q.get('c')); return {}; },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try { send(res, 200, await route(url.searchParams, req.method === 'POST' ? await body(req) : null)); }
    catch (e) { send(res, 400, { error: e.message || String(e) }); }
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
  if (e.code === 'EADDRINUSE' && process.env.OPTION_DESK_RESTART === '1' && ++tries < 40) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Option Desk is running: http://localhost:${PORT}`);
  console.log(`  Data: ${MOCK ? 'simulated market (MOCK=1)' : 'live NSE'} · Paper account: ${path.join(desktop.DATA_DIR, MOCK ? 'paper-sim.json' : 'paper.json')}`);
  if (desktop.PACKAGED && process.env.OPTION_DESK_RESTART !== '1') desktop.openWindow(`http://localhost:${PORT}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
  if (!MOCK) provider.indices().then(() => console.log('  Connected to NSE.')).catch((e) => console.log(`  Could not reach NSE yet: ${e.message}. The app will keep retrying.`));
});
