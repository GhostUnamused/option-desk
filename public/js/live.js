// Live ticks from the server (INDstocks price stream, as server-sent events). Index prices and the prices of the
// option chain on screen move several times a second; everything else still refreshes on the 5-second poll.
import { S, emit } from './state.js';

let pending = {}, timer = null, es = null;

export function init(onIndices) {
  if (S.meta.replay || !S.meta.broker) return;
  es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    Object.assign(pending, m.ticks || {});
    S.streamState = m.state;
    if (!timer) timer = setTimeout(() => { timer = null; apply(onIndices); }, 250);
  };
}

function apply(onIndices) {
  const ticks = pending; pending = {};
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
  if (opts.size) {
    for (const c of S.chains.values()) for (const r of c.rows) for (const o of [r.ce, r.pe]) {
      if (!o || !opts.has(o.id)) continue;
      const v = ticks[o.id]; o.ltp = v;
      if (o.prevClose) { o.chg = +(v - o.prevClose).toFixed(2); o.pchg = +((v / o.prevClose - 1) * 100).toFixed(2); }
    }
    emit('ticks', { options: opts, values: ticks });
  }
  if (idx) onIndices();
}
