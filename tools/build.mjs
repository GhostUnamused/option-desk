// Builds dist/OptionDesk.exe (Node single executable, no console window) plus the files a GitHub Release needs:
//   app-bundle.json  every app file, base64, for the in-app updater
//   version.json     latest version, launcher version and checksums
// Run: node tools/build.mjs   (uses the Node that runs it; no npm packages needed)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const launcher = Number(/const LAUNCHER_VERSION = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'tools', 'launcher.cjs'), 'utf8'))[1]);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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

const exe = path.join(DIST, 'OptionDesk.exe');
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
fs.writeFileSync(exe, buf);
console.log(`OptionDesk.exe   ${(buf.length / 1048576).toFixed(0)} MB`);

fs.writeFileSync(path.join(DIST, 'version.json'), JSON.stringify({
  version: pkg.version, launcher, notes: process.env.NOTES || '',
  bundle: 'app-bundle.json', bundleSha256: sha256(bundle),
  exe: 'OptionDesk.exe', exeSha256: sha256(buf),
}, null, 2));
console.log(`version.json     v${pkg.version}, launcher ${launcher}`);
