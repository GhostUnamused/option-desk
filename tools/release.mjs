// Publishes a new version to GitHub Releases so installed copies can update themselves.
// 1. Raise "version" in package.json (e.g. 0.2.0 -> 0.2.1).   2. Run: node tools/release.mjs "What changed"
// Needs the GitHub CLI (gh) signed in, and package.json "updates.github" set to "owner/repo" (a public repo).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const repo = pkg.updates?.github;
if (!repo) throw new Error('Set "updates": { "github": "owner/repo" } in package.json first.');
const notes = process.argv.slice(2).join(' ') || `Optionwise ${pkg.version}`;
const tag = 'v' + pkg.version;

try { execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' }); throw new Error(`${tag} is already released. Raise the version in package.json.`); }
catch (e) { if (e.message.includes('already released')) throw e; }

execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.mjs')], { stdio: 'inherit', env: { ...process.env, NOTES: notes } });
const dist = (f) => path.join(ROOT, 'dist', f);
const assets = ['Optionwise.exe', 'app-bundle.json', 'version.json'];
// Hashes of the files exactly as uploaded (after signing), so anyone can check a download.
const sums = assets.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(dist(f))).digest('hex')}  ${f}`);
const signed = JSON.parse(fs.readFileSync(dist('version.json'), 'utf8')).signed;
const fence = '```';
const body = [
  notes, '',
  '### Checksums (SHA-256)', fence, ...sums, fence,
  'To check a download, run this in PowerShell in the folder you saved it to. The Hash it prints should match the line above (upper or lower case does not matter):',
  fence + 'powershell', 'Get-FileHash .\\Optionwise.exe -Algorithm SHA256', fence,
  signed ? 'Optionwise.exe is Authenticode-signed: right-click it, Properties, Digital Signatures shows who signed it.'
    : 'Optionwise.exe is not code-signed, so Windows SmartScreen may warn the first time you run it.',
].join('\n');
console.log('\n' + sums.join('\n'));
execFileSync('gh', ['release', 'create', tag, ...assets.map(dist), '--repo', repo, '--title', `Optionwise ${pkg.version}`, '--notes', body], { stdio: 'inherit' });
console.log(`\nReleased ${tag}. Running copies will offer the update within a few hours, or on their next start.`);
