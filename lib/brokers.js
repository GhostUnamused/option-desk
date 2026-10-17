// Keeps broker choice separate from the app's market provider contract. Only one user's broker is active at a time.
import fs from 'node:fs';
import path from 'node:path';

export class BrokerManager {
  constructor(adapters, settingsFile) {
    this.adapters = adapters; this.settingsFile = settingsFile; this.selected = 'indstocks';
    try { const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); if (adapters[s.provider]) this.selected = s.provider; } catch {}
  }
  active() { return this.adapters[this.selected]; }
  get name() { return this.active()?.name || 'NSE'; }
  get token() { return this.active()?.token || null; }
  get source() { return this.active()?.source || null; }
  get stream() { return this.active()?.stream || null; }
  usable() { return Boolean(this.active()?.usable?.()); }
  status() {
    const status = this.active()?.status?.() || {};
    return { ...status, provider: this.selected, capabilities: this.active()?.capabilities || {}, providers: Object.keys(this.adapters).map((id) => ({ id, connected: Boolean(this.adapters[id].status?.().connected), selected: id === this.selected, capabilities: this.adapters[id].capabilities || {} })) };
  }
  select(id) {
    if (!this.adapters[id]) throw new Error('Choose a supported broker.');
    this.selected = id; fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify({ provider: id }));
    return this.status();
  }
  async connect(id, credentials) {
    const adapter = this.adapters[id]; if (!adapter) throw new Error('Choose a supported broker.');
    if (id === 'indstocks') await adapter.setToken(credentials?.token);
    else if (id === 'fyers') await adapter.setCredentials(credentials);
    else if (id === 'upstox') await adapter.setToken(credentials?.token);
    else if (id === 'kotak') await adapter.setToken(credentials?.token);
    else if (id === 'breeze') await adapter.setCredentials(credentials);
    else if (id === 'angelone') await adapter.setCredentials(credentials);
    else throw new Error(`${id} setup is not available yet.`);
    this.select(id); return this.status();
  }
  forget(id = this.selected) {
    const adapter = this.adapters[id]; if (!adapter) throw new Error('Choose a supported broker.');
    adapter.forget?.(); return this.status();
  }
}

// Delegate the existing market-provider methods and broker-specific read-only helpers to the selected adapter.
for (const name of ['indices', 'marketStatus', 'expiries', 'chain', 'intraday', 'daily', 'optionIntraday', 'optionCandles', 'expiredExpiries', 'expiredContracts', 'expiredCandles', 'stockList']) {
  BrokerManager.prototype[name] = function (...args) {
    const fn = this.active()?.[name];
    if (typeof fn !== 'function') throw new Error(`${this.active()?.name || 'This broker'} does not provide this data.`);
    return fn.apply(this.active(), args);
  };
}
