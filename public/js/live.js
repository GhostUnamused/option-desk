// Live ticks and quote fields from the server (INDstocks stream, as server-sent events).
// Streamed values update immediately; the active view keeps a short REST refresh as a fallback.
import { S, emit } from './state.js';

let pending = {}, pendingQuotes = {}, timer = null, es = null;

export function init(onIndices) {
  if (S.meta.replay || !S.meta.broker) return;
  es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    Object.assign(pending, m.ticks || {});
    for (const [key, value] of Object.entries(m.quotes || {})) pendingQuotes[key] = { ...pendingQuotes[key], ...value };
    S.streamState = m.state;
    if (!timer) timer = setTimeout(() => { timer = null; apply(onIndices); }, 250);
  };
}

function apply(onIndices) {
  const ticks = pending; pending = {};
  const quotes = pendingQuotes; pendingQuotes = {};
  let idx = false; const opts = new Set();
  const q = S.quotes;
  for (const [k, v] of Object.entries(ticks)) {
    if (k.startsWith('NFO_') || k.startsWith('BFO_')) { opts.add(k); continue; }
    const i = k === 'INDIAVIX' ? q?.vix : q?.indices.find((x) => x.symbol === k);
    if (!i || !(v > 0)) continue;
    i.last = v; i.high = Math.max(i.high || v, v); i.low = Math.min(i.low || v, v);
    if (i.prevClose) { i.change = +(v - i.prevClose).toFixed(2); i.pct = +((v / i.prevClose - 1) * 100).toFixed(2); }
    idx = true;
  }
  for (const k of Object.keys(quotes)) if (k.startsWith('NFO_') || k.startsWith('BFO_')) opts.add(k);
  if (opts.size) {
    for (const c of S.chains.values()) for (const r of c.rows) for (const o of [r.ce, r.pe]) {
      if (!o || !opts.has(o.id)) continue;
      const q = quotes[o.id] || {};
      const v = ticks[o.id] || q.ltp;
      if (v > 0) {
        o.ltp = v;
        if (o.prevClose) { o.chg = +(v - o.prevClose).toFixed(2); o.pchg = +((v / o.prevClose - 1) * 100).toFixed(2); }
      }
      if (q.bid > 0) o.bid = q.bid;
      if (q.ask > 0) o.ask = q.ask;
      if (q.bidQty != null) o.bidQty = q.bidQty;
      if (q.askQty != null) o.askQty = q.askQty;
      if (q.volume != null && o.lot) o.vol = Math.round(q.volume / o.lot);
      if (q.oi != null && o.lot) {
        o.oi = Math.round(q.oi / o.lot);
        if (q.oiChange != null && q.oiChange > -100) o.chgOi = Math.round(o.oi - o.oi / (1 + q.oiChange / 100));
      }
      if (q.iv > 0) o.iv = q.iv;
    }
    emit('ticks', { options: opts, values: ticks, quotes });
  }
  if (idx) onIndices();
}
