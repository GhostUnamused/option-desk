// Desktop-app plumbing: where the paper account lives, update check and install from GitHub Releases,
// restarting (live <-> simulated, after an update) and quitting when the last app window closes.
// Most of it only switches on when the server was started by OptionDesk.exe (tools/launcher.cjs sets OPTION_DESK_APP=1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const PACKAGED = process.env.OPTION_DESK_APP === '1';
export const HOME = process.env.OPTION_DESK_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'OptionDesk');
export const DATA_DIR = process.env.OPTION_DESK_DATA || path.join(HOME, 'data');
export const VERSION = PKG.version;
const STARTED = Date.now(); // lets a page tell a restarted app from the one it was talking to
const LAUNCHER = Number(process.env.OPTION_DESK_LAUNCHER) || 0;
const REPO = PKG.updates?.github || '';
const RELEASE = process.env.OPTION_DESK_UPDATE_URL || (REPO && `https://github.com/${REPO}/releases/latest/download/`); // env override is for testing

// The account used to live in <project>/data. Copy it over once so running from source and from the exe share one account.
export function migrateData() {
  for (const f of ['paper.json', 'paper-sim.json']) {
    const from = path.join(ROOT, 'data', f), to = path.join(DATA_DIR, f);
    if (!fs.existsSync(to) && fs.existsSync(from)) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.copyFileSync(from, to); console.log(`  Moved ${f} to ${DATA_DIR}`); }
  }
}

export function info() {
  return { packaged: PACKAGED, version: VERSION, launcher: LAUNCHER, started: STARTED, updates: Boolean(PACKAGED && RELEASE), dataDir: DATA_DIR };
}

// ---- Updates ----
const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function get(name) {
  const r = await fetch(RELEASE + name, { headers: { 'User-Agent': 'OptionDesk/' + VERSION }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${name}`);
  return Buffer.from(await r.arrayBuffer());
}

let checked = null; // { at, latest }: the last answer from GitHub, reused for 15 minutes
export async function checkUpdate(force = false) {
  if (!PACKAGED || !RELEASE) return { available: false, current: VERSION };
  if (force || !checked || Date.now() - checked.at > 15 * 60e3) {
    const latest = JSON.parse((await get('version.json')).toString('utf8'));
    checked = { at: Date.now(), latest };
  }
  const l = checked.latest;
  const needsNewExe = l.launcher > LAUNCHER;
  // A newer exe counts as an update even when the app files are already current.
  return { available: cmp(l.version, VERSION) > 0 || needsNewExe, current: VERSION, latest: l.version, notes: l.notes || '', needsNewExe };
}

export async function installUpdate() {
  const u = await checkUpdate(true);
  if (!u.available) throw new Error('Already on the latest version.');
  const l = checked.latest;
  if (u.needsNewExe) {
    // Windows allows renaming a running exe, so swap it: current -> .old (deleted next start), new -> current name.
    const exe = process.execPath, buf = await get(l.exe);
    if (sha256(buf) !== l.exeSha256) throw new Error('Downloaded app failed its checksum. Try again later.');
    try { fs.writeFileSync(exe + '.new', buf); fs.rmSync(exe + '.old', { force: true }); fs.renameSync(exe, exe + '.old'); fs.renameSync(exe + '.new', exe); }
    catch (e) { throw new Error(`Could not replace ${path.basename(exe)} (${e.code || e.message}). Move it to a folder you own, such as Desktop or Documents, and try again.`); }
  }
  const buf = await get(l.bundle);
  if (sha256(buf) !== l.bundleSha256) throw new Error('Downloaded update failed its checksum. Try again later.');
  const bundle = JSON.parse(buf.toString('utf8'));
  const dir = path.join(HOME, 'app', bundle.version), tmp = dir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, b64] of Object.entries(bundle.files)) {
    const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  }
  fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
  fs.writeFileSync(path.join(HOME, 'current.json'), JSON.stringify({ version: bundle.version, id: bundle.id }));
  return { version: bundle.version };
}

// ---- Restart and quit ----
let server = null;
export function attach(s) { server = s; }

// Start a fresh copy of the exe (it picks the newest installed app version), then step aside so it can take the port.
export function restart(sim) {
  if (!PACKAGED) throw new Error('Restart only works in the desktop app. Stop the server and start it again.');
  const args = sim ? ['--sim'] : [];
  spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, OPTION_DESK_RESTART: '1' } }).unref();
  setTimeout(() => { server?.close(); process.exit(0); }, 300);
}

// Each open window pings every 30 s (hidden windows are throttled to about once a minute) and says goodbye on close.
// When the last window has gone, the app quits. A reload says goodbye and pings again within a second, so it survives.
// Safety net: if no window has been heard from for 15 minutes (a goodbye got lost), quit as well.
const clients = new Map();
let quitTimer = null, lastPing = Date.now();
export function quit(why) { console.log(`Quitting: ${why}`); server?.close(); setTimeout(() => process.exit(0), 100); }
export function ping(id) {
  if (!PACKAGED || !id) return;
  if (!clients.has(id)) console.log(`Window opened (${clients.size + 1} open)`);
  clients.set(id, lastPing = Date.now()); clearTimeout(quitTimer); quitTimer = null;
}
export function bye(id) {
  if (!PACKAGED || !id) return;
  clients.delete(id);
  console.log(`Window closed (${clients.size} still open)`);
  clearTimeout(quitTimer);
  // Just after a restart the other windows may not have pinged yet, so give them a minute to show up.
  const wait = process.env.OPTION_DESK_RESTART === '1' ? Math.max(10e3, 60e3 - process.uptime() * 1000) : 10e3;
  quitTimer = setTimeout(() => {
    for (const [k, t] of clients) if (Date.now() - t > 90e3) clients.delete(k);
    if (!clients.size) quit('last window closed');
  }, wait);
}
if (PACKAGED) setInterval(() => { if (Date.now() - lastPing > 15 * 60e3) quit('no window open for 15 minutes'); }, 60e3).unref();

// Open the app in its own window (Edge or Chrome app mode), falling back to the default browser.
export function openWindow(url) {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = pf.flatMap((p) => [path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
  const browser = candidates.find((f) => fs.existsSync(f));
  if (browser) spawn(browser, ['--app=' + url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
