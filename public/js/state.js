// App-wide state and a tiny event bus.
import { api, store, daysTo } from './util.js';

const listeners = new Map();
export const S = {
  meta: null,
  symbol: store.get('symbol', 'NIFTY'),
  expiry: {},          // chosen expiry per symbol
  expiries: {},        // available expiries per symbol
  unpriced: {},        // replay only: expiries listed that day without downloaded minute prices
  quotes: null,        // { indices, vix, market }
  chains: new Map(),   // `${symbol}|${expiry}` -> chain
  account: null,
  tab: 'markets',
};

export function on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); }
export function emit(ev, data) { (listeners.get(ev) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

export const cfg = (symbol = S.symbol) => S.meta.indices[symbol];
export const quote = (symbol = S.symbol) => S.quotes?.indices.find((i) => i.symbol === symbol) || null;

export async function loadExpiries(symbol = S.symbol) {
  if (!S.expiries[symbol]) {
    const r = await api(`/api/expiries?symbol=${symbol}`);
    S.expiries[symbol] = r.expiries.filter((e) => daysTo(e) > -0.01);
    S.unpriced[symbol] = r.unpriced || [];
  }
  if (!S.expiry[symbol] || !S.expiries[symbol].includes(S.expiry[symbol])) S.expiry[symbol] = S.expiries[symbol][0];
  return S.expiries[symbol];
}

// The nearest expiry with at least ~half a day left, for analysis (same-day expiries distort IV).
export function analysisExpiry(symbol = S.symbol) {
  const list = S.expiries[symbol] || [];
  return list.find((e) => daysTo(e) > 0.5) || list[0];
}

export async function loadChain(symbol, expiry, force = false) {
  const k = `${symbol}|${expiry}`;
  const hit = S.chains.get(k);
  // Keep the displayed chain close to the quote stream. INDstocks has its own short cache;
  // the longer client cache used to make each visible refresh wait at least four seconds.
  const ttl = S.meta?.broker?.connected ? 2000 : 4000;
  if (hit && !force && Date.now() - hit._at < ttl) return hit;
  const c = await api(`/api/chain?symbol=${symbol}&expiry=${expiry}`);
  c._at = Date.now();
  S.chains.set(k, c);
  emit('chain', c);
  return c;
}

export function setSymbol(symbol) {
  if (symbol === S.symbol) return;
  S.symbol = symbol; store.set('symbol', symbol);
  emit('symbol', symbol);
}

// Replay moved to another day: forget everything priced on the old one.
export function newDay() { S.expiries = {}; S.chains.clear(); emit('day'); }

// Views redraw on 'account', which wipes hover tooltips, so it fires only when the account changed (or when forced).
let lastAccount = '';
export async function refreshAccount(force = false) {
  const a = await api('/api/account'), sig = JSON.stringify(a);
  S.account = a;
  if (force || sig !== lastAccount) { lastAccount = sig; emit('account', a); }
  return a;
}
