// Builds dist/Optionwise.exe (Node single executable, no console window) plus the files a GitHub Release needs:
//   app-bundle.json  every app file, base64, for the in-app updater
//   version.json     latest version, launcher version and checksums
// Run: node tools/build.mjs   (uses the Node that runs it; no npm packages needed)
// Optional Authenticode signing (Windows SDK signtool.exe; SIGNTOOL=<path> if it is not on PATH or in Windows Kits):
//   SIGN_CERT_THUMBPRINT=<sha1>                 a certificate in the current user's store (or a token/HSM it maps to)
//   SIGN_PFX=<file.pfx> SIGN_PFX_PASSWORD=<pw>  a certificate file (keep it outside the repo)
//   SIGN_TIMESTAMP_URL                          RFC 3161 timestamp server, default http://timestamp.digicert.com
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rebrand } from './exe-resources.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const launcher = Number(/const LAUNCHER_VERSION = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'tools', 'launcher.cjs'), 'utf8'))[1]);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Newest signtool.exe from the Windows SDK, unless SIGNTOOL names one; else rely on PATH.
function findSigntool() {
  if (process.env.SIGNTOOL) return process.env.SIGNTOOL;
  const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const found = (fs.existsSync(kits) ? fs.readdirSync(kits) : []).filter((v) => /^\d+\./.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((v) => path.join(kits, v, arch, 'signtool.exe')).find((f) => fs.existsSync(f));
  return found || 'signtool.exe';
}

// Signs the exe in place when signing is configured. Returns true if signed. Any failure stops the build:
// a release must never go out unsigned by accident once signing is set up.
function sign(file) {
  const thumb = process.env.SIGN_CERT_THUMBPRINT, pfx = process.env.SIGN_PFX;
  if (!thumb && !pfx) { console.log('Optionwise.exe   unsigned (set SIGN_CERT_THUMBPRINT or SIGN_PFX to sign)'); return false; }
  if (thumb && pfx) throw new Error('Set only one of SIGN_CERT_THUMBPRINT and SIGN_PFX.');
  if (pfx && !fs.existsSync(pfx)) throw new Error(`SIGN_PFX file not found: ${pfx}`);
  const tool = findSigntool();
  const ts = process.env.SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
  const cert = thumb ? ['/sha1', thumb.replace(/\s/g, '')] : ['/f', pfx, ...(process.env.SIGN_PFX_PASSWORD ? ['/p', process.env.SIGN_PFX_PASSWORD] : [])];
  const run = (args, what) => {
    try { execFileSync(tool, args, { stdio: 'inherit' }); }
    // Rethrow without the command line: it can hold the PFX password.
    catch (e) { throw new Error(`Signing failed (${what}): ${e.code === 'ENOENT' ? `${tool} not found; install the Windows SDK or set SIGNTOOL` : `signtool exited with ${e.status}`}`); }
  };
  run(['sign', ...cert, '/fd', 'SHA256', '/tr', ts, '/td', 'SHA256', file], 'sign');
  run(['verify', '/pa', file], 'verify');
  console.log(`Optionwise.exe   signed (${thumb ? 'certificate ' + thumb.slice(0, 8) + '…' : path.basename(pfx)}), timestamped by ${ts}`);
  return true;
}

function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.posix.join(dir, d.name);
    return d.isDirectory() ? walk(rel) : [rel];
  });
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);

const files = {};
for (const rel of ['server.js', 'package.json', ...walk('lib'), ...walk('public')]) files[rel] = fs.readFileSync(path.join(ROOT, rel)).toString('base64');
const id = sha256(JSON.stringify(files)).slice(0, 16); // tells two builds of the same version apart
const bundle = Buffer.from(JSON.stringify({ version: pkg.version, id, files }));
fs.writeFileSync(path.join(DIST, 'app-bundle.json'), bundle);
console.log(`app-bundle.json  ${Object.keys(files).length} files, ${(bundle.length / 1024).toFixed(0)} KB`);

const exe = path.join(DIST, 'Optionwise.exe');
const config = path.join(DIST, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({
  main: path.join(ROOT, 'tools', 'launcher.cjs'), output: exe,
  disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false,
  assets: { 'app-bundle.json': path.join(DIST, 'app-bundle.json') },
}, null, 2));
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
fs.rmSync(config);

// Mark the exe as a Windows GUI program so double-clicking it does not open a console window.
// PE layout: offset of the PE header at 0x3C; Subsystem is 68 bytes into the optional header, which starts 24 bytes after "PE\0\0".
const buf = fs.readFileSync(exe);
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Unexpected exe layout');
buf.writeUInt16LE(2, pe + 24 + 68);
// Own icon and name (otherwise Explorer and Task Manager show Node.js).
rebrand(buf, { version: pkg.version, name: 'Optionwise', file: 'Optionwise.exe', description: 'Optionwise', copyright: 'Paper trading only. Not investment advice.' });
fs.writeFileSync(exe, buf);
console.log(`Optionwise.exe   ${(buf.length / 1048576).toFixed(0)} MB`);
const signed = sign(exe);
const exeBuf = fs.readFileSync(exe); // re-read: signing rewrites the file, and the updater checks this hash

fs.writeFileSync(path.join(DIST, 'version.json'), JSON.stringify({
  version: pkg.version, launcher, notes: process.env.NOTES || '',
  bundle: 'app-bundle.json', bundleSha256: sha256(bundle),
  exe: 'Optionwise.exe', exeSha256: sha256(exeBuf), signed,
}, null, 2));
console.log(`version.json     v${pkg.version}, launcher ${launcher}`);
