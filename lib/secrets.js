// Broker access token: where it comes from and how it is kept.
// - Running from source: INDSTOCKS_TOKEN in a .env file next to server.js (git-ignored, never bundled into the exe).
// - The app: the owner pastes the token in the page once; it is encrypted with Windows DPAPI (only this Windows user on
//   this PC can decrypt it) and saved as broker.dat in the data folder. The token never goes back to the page or the log.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// KEY=value lines; values already in the environment win. Quotes around a value are dropped.
export function loadDotEnv(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] == null) process.env[m[1]] = v;
  }
}

// DPAPI through PowerShell (no npm modules). The entropy string stays 'OptionDesk', the old app name, so tokens saved by earlier versions still decrypt. The secret travels over stdin, never on a command line.
const PS = (op) => `Add-Type -AssemblyName System.Security; $i = [Console]::In.ReadToEnd().Trim();
$b = [Security.Cryptography.ProtectedData]::${op}(${op === 'Protect' ? '[Text.Encoding]::UTF8.GetBytes($i)' : '[Convert]::FromBase64String($i)'}, [Text.Encoding]::UTF8.GetBytes('OptionDesk'), 'CurrentUser');
[Console]::Out.Write(${op === 'Protect' ? '[Convert]::ToBase64String($b)' : '[Text.Encoding]::UTF8.GetString($b)'})`;
const ps = (op, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS(op)], { input, encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
const WIN = process.platform === 'win32';

export class SecretFile {
  constructor(file) { this.file = file; }
  save(secret) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Elsewhere than Windows there is no DPAPI: the file is kept readable by this user only.
    const body = WIN ? 'dpapi:' + ps('Protect', secret) : 'plain:' + Buffer.from(secret).toString('base64');
    fs.writeFileSync(this.file + '.tmp', body, { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file);
  }
  load() {
    let body; try { body = fs.readFileSync(this.file, 'utf8').trim(); } catch { return null; }
    try {
      if (body.startsWith('dpapi:')) return WIN ? ps('Unprotect', body.slice(6)) || null : null;
      if (body.startsWith('plain:')) return Buffer.from(body.slice(6), 'base64').toString('utf8') || null;
    } catch (e) { console.log(`  Could not read the saved broker token (${e.message.split('\n')[0]}). Paste it again in the app.`); }
    return null;
  }
  clear() { fs.rmSync(this.file, { force: true }); }
}
