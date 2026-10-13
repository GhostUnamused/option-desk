// OptionDesk.exe entry point (built by tools/build.mjs as a Node single executable).
// The exe carries a copy of the app (server.js, lib/, public/). On start it unpacks that copy into
// %LOCALAPPDATA%\OptionDesk\app\<version> unless a newer version is already installed there by the in-app updater,
// then runs that version's server.js. Paper accounts live in %LOCALAPPDATA%\OptionDesk\data and survive updates.
// Bump LAUNCHER_VERSION only when this file changes: the updater then also downloads a new exe.
const LAUNCHER_VERSION = 1;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const sea = require('node:sea');

const HOME = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'OptionDesk');
const PORT = Number(process.env.PORT) || 4321;
const RESTART = process.env.OPTION_DESK_RESTART === '1';
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });

// The exe has no console window, so everything the server prints goes to a log file instead.
const logFile = path.join(HOME, 'logs', 'option-desk.log');
try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.1'); } catch {}
const log = (...a) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map(String).join(' ')}\n`); } catch {} };
console.log = console.info = console.warn = console.error = log;

function fatal(e) {
  log('FATAL', e && e.stack || e);
  const msg = e && e.code === 'EADDRINUSE' ? `Another program is already using port ${PORT}. Close it and open Option Desk again.` : String(e && e.message || e);
  const text = `Option Desk could not start.\n\n${msg}\n\nDetails are in ${logFile}`.replace(/'/g, "''");
  spawn('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Option Desk') | Out-Null`], { windowsHide: true, stdio: 'ignore' })
    .on('exit', () => process.exit(1));
}
process.on('uncaughtException', (e) => fatal(e));

const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function unpack(bundle) {
  const dir = path.join(HOME, 'app', bundle.version), tmp = dir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, b64] of Object.entries(bundle.files)) {
    const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  }
  fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
  fs.writeFileSync(path.join(HOME, 'current.json'), JSON.stringify({ version: bundle.version, id: bundle.id }));
}

// Is Option Desk already running? Then just open another window on it.
function running() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/meta', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openWindow(url) {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const browser = pf.flatMap((p) => [path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')]).find((f) => fs.existsSync(f));
  if (browser) spawn(browser, ['--app=' + url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  // Left behind by an exe self-update. Right after the swap the old copy is still shutting down, so retry for a while.
  const old = process.execPath + '.old';
  const clean = (n) => { try { fs.rmSync(old, { force: true }); } catch { if (n > 0) setTimeout(() => clean(n - 1), 2000).unref(); } };
  clean(15);
  if (!RESTART && await running()) { openWindow(`http://localhost:${PORT}`); setTimeout(() => process.exit(0), 500); return; }

  const embedded = JSON.parse(sea.getAsset('app-bundle.json', 'utf8'));
  const current = readJson(path.join(HOME, 'current.json'));
  let version = current && current.version;
  const sameButRebuilt = version === embedded.version && current.id !== embedded.id;
  if (!version || cmp(embedded.version, version) > 0 || sameButRebuilt || !fs.existsSync(path.join(HOME, 'app', version, 'server.js'))) { unpack(embedded); version = embedded.version; }

  // Keep only the version in use.
  for (const d of fs.readdirSync(path.join(HOME, 'app'))) if (d !== version) fs.rmSync(path.join(HOME, 'app', d), { recursive: true, force: true });

  Object.assign(process.env, { OPTION_DESK_APP: '1', OPTION_DESK_HOME: HOME, OPTION_DESK_LAUNCHER: String(LAUNCHER_VERSION) });
  log(`Starting Option Desk ${version} (launcher ${LAUNCHER_VERSION})${process.argv.includes('--sim') ? ' in simulated mode' : ''}`);
  const entry = path.join(HOME, 'app', version, 'server.js');
  createRequire(entry)(entry);
}

main().catch((e) => fatal(e));
