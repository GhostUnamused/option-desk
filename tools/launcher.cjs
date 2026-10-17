// Optionwise.exe entry point (built by tools/build.mjs as a Node single executable).
// The exe carries a copy of the app (server.js, lib/, public/). On start it unpacks that copy into
// %LOCALAPPDATA%\Optionwise\app\<version> unless a newer version is already installed there by the in-app updater,
// then runs that version's server.js. Paper accounts live in %LOCALAPPDATA%\Optionwise\data and survive updates.
// Bump LAUNCHER_VERSION only when this file changes: the updater then also downloads a new exe.
const LAUNCHER_VERSION = 4;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const sea = require('node:sea');

// Settings come from OPTIONWISE_* variables. The launcher of the old Option Desk (0.7 and earlier) set OPTION_DESK_* instead, so both are read.
const env = (name) => process.env['OPTIONWISE_' + name] ?? process.env['OPTION_DESK_' + name];
const BASE = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
const LEGACY_HOME = path.join(BASE, 'OptionDesk'); // where the app kept everything up to 0.7
const homeEnv = env('HOME');
const CUSTOM_HOME = homeEnv && path.resolve(homeEnv) !== path.resolve(LEGACY_HOME) ? homeEnv : ''; // the old launcher passes its own default folder down on restart
const HOME = CUSTOM_HOME || path.join(BASE, 'Optionwise');
const PORT = Number(process.env.PORT) || 4321;
const RESTART = env('RESTART') === '1';

// Move the old folder across once (paper account, replay history, saved token, installed app files). This must happen before anything is written to the new folder.
let migrated = '';
if (!CUSTOM_HOME && !fs.existsSync(HOME) && fs.existsSync(LEGACY_HOME)) {
  for (let i = 0; i < 12 && !migrated; i++) { // right after an update the previous copy may still be shutting down
    try { fs.renameSync(LEGACY_HOME, HOME); migrated = `Moved ${LEGACY_HOME} to ${HOME}`; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  if (!migrated) {
    try { fs.cpSync(path.join(LEGACY_HOME, 'data'), path.join(HOME, 'data'), { recursive: true }); migrated = `Copied your data from ${LEGACY_HOME} to ${HOME}`; }
    catch (e) { migrated = `Could not carry over your data from ${LEGACY_HOME}: ${e.message}`; }
  }
}
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });

// The exe has no console window, so everything the server prints goes to a log file instead.
const logFile = path.join(HOME, 'logs', 'optionwise.log');
try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.1'); } catch {}
const log = (...a) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map(String).join(' ')}\n`); } catch {} };
console.log = console.info = console.warn = console.error = log;
if (migrated) log(migrated);

function fatal(e) {
  log('FATAL', e && e.stack || e);
  const msg = e && e.code === 'EADDRINUSE' ? `Another program is already using port ${PORT}. Close it and open Optionwise again.` : String(e && e.message || e);
  const text = `Optionwise could not start.\n\n${msg}\n\nDetails are in ${logFile}`.replace(/'/g, "''");
  spawn('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Optionwise') | Out-Null`], { windowsHide: true, stdio: 'ignore' })
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

// Is Optionwise already running? Resolves to its /api/meta, or null.
function running() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/meta', timeout: 1500 }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }).on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(s) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function post(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); }); req.end();
  });
}

function openWindow(url) {
  if (env('NO_WINDOW')) return; // tests
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
  const other = RESTART ? null : await running();
  // A copy started from the project folder (start.bat / node server.js) has no app features, so don't quietly reuse it.
  if (other && !(other.app && other.app.packaged)) return fatal(new Error('Optionwise is already running from the project folder (start.bat or node server.js). Close that window, then open the app again.'));
  const embedded = JSON.parse(sea.getAsset('app-bundle.json', 'utf8'));
  if (other) {
    // An older copy is running (say you just downloaded a new exe): ask it to quit and take over. Otherwise open a window on it.
    const older = cmp(embedded.version, other.app.version) > 0 || (other.app.launcher || 0) < LAUNCHER_VERSION;
    if (!older || !(await post('/api/quit'))) { openWindow(`http://localhost:${PORT}`); setTimeout(() => process.exit(0), 500); return; }
    log(`Replacing running ${other.app.version}`);
    for (let i = 0; i < 40 && await running(); i++) await new Promise((r) => setTimeout(r, 250));
  }

  const current = readJson(path.join(HOME, 'current.json'));
  let version = current && current.version;
  const sameButRebuilt = version === embedded.version && current.id !== embedded.id;
  if (!version || cmp(embedded.version, version) > 0 || sameButRebuilt || !fs.existsSync(path.join(HOME, 'app', version, 'server.js'))) { unpack(embedded); version = embedded.version; }

  // Keep only the version in use.
  for (const d of fs.readdirSync(path.join(HOME, 'app'))) if (d !== version) fs.rmSync(path.join(HOME, 'app', d), { recursive: true, force: true });

  Object.assign(process.env, { OPTIONWISE_APP: '1', OPTIONWISE_HOME: HOME, OPTIONWISE_LAUNCHER: String(LAUNCHER_VERSION) });
  log(`Starting Optionwise ${version} (launcher ${LAUNCHER_VERSION})${process.argv.includes('--sim') ? ' in simulated mode' : ''}`);
  const entry = path.join(HOME, 'app', version, 'server.js');
  createRequire(entry)(entry);
}

main().catch((e) => fatal(e));
