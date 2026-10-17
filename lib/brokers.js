// Keeps broker choice separate from the app's market provider contract. Only one user's broker is active at a time.
import fs from 'node:fs';
import path from 'node:path';
import { nseGate } from './nse.js';

export class BrokerManager {
  constructor(adapters, settingsFile) {
    this.adapters = adapters; this.settingsFile = settingsFile; this.selected = 'indstocks'; this.nse = false; this.nseChosen = false;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); if (adapters[saved.provider]) this.selected = saved.provider; this.nse = saved.nse === true; this.nseChosen = saved.nseChosen === true; } catch {}
    // Installs from before 0.10 had no NSE setting and always fell back to NSE. If one already has broker credentials
    // saved, keep that backup on (once, written down) so an expired token does not leave it without prices.
    if (!('nse' in saved) && Object.values(adapters).some((a) => { const s = a.status?.(); return s?.hasToken && s.source !== 'env'; })) { this.nse = true; this.save(); }
    nseGate.open = this.nse;
  }
  active() { return this.adapters[this.selected]; }
  get name() { return this.active()?.name || 'NSE'; }
  get token() { return this.active()?.token || null; }
  get source() { return this.active()?.source || null; }
  get stream() { return this.active()?.stream || null; }
  usable() { return Boolean(this.active()?.usable?.()); }
  status() {
    const status = this.active()?.status?.() || {};
    const connected = Boolean(status.connected);
    return { ...status, nse: this.nse, needsChoice: !connected && !this.nse, provider: this.selected, capabilities: this.active()?.capabilities || {}, providers: Object.keys(this.adapters).map((id) => ({ id, connected: Boolean(this.adapters[id].status?.().connected), selected: id === this.selected, capabilities: this.adapters[id].capabilities || {} })) };
  }
  select(id) {
    if (!this.adapters[id]) throw new Error('Choose a supported broker.');
    this.selected = id; this.save();
    return this.status();
  }
  save() { fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true }); fs.writeFileSync(this.settingsFile, JSON.stringify({ provider: this.selected, nse: this.nse, ...(this.nseChosen ? { nseChosen: true } : {}) })); }
  // The person's choice to let the app read NSE's public website (as the main source or as a backup). Off until chosen,
  // or until a broker connects (see connect). Once set here, nothing else changes it.
  setNse(on) { this.nse = on === true; this.nseChosen = true; nseGate.open = this.nse; this.save(); return this.status(); }
  async connect(id, credentials) {
    const adapter = this.adapters[id]; if (!adapter) throw new Error('Choose a supported broker.');
    if (id === 'indstocks') await adapter.setToken(credentials?.token);
    else if (id === 'fyers') await adapter.setCredentials(credentials);
    else if (id === 'upstox') await adapter.setToken(credentials?.token);
    else if (id === 'kotak') await adapter.setToken(credentials?.token);
    else if (id === 'breeze') await adapter.setCredentials(credentials);
    else if (id === 'angelone') await adapter.setCredentials(credentials);
    else throw new Error(`${id} setup is not available yet.`);
    // A first broker connection turns NSE on as a backup, so an expired token still has prices. The person can untick
    // it in the Data dialog; after that their choice stands.
    if (!this.nseChosen && !this.nse) { this.nse = true; nseGate.open = true; }
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
