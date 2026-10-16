// Live ticks from INDstocks' price WebSocket (wss://ws-prices.indstocks.com), passed on to the page as server-sent events.
// The REST provider still answers every request; the stream only freshens last prices between polls and lets the page
// move its numbers several times a second. Only runs in live mode with a working token.
const URL = 'wss://ws-prices.indstocks.com/api/v1/ws/prices';
const MAX_INSTRUMENTS = 2500; // INDstocks allows 3000 per connection

export class PriceStream {
  // token(): the current access token or null. onTokenError(): the token was refused.
  constructor({ token, onTokenError }) {
    this.token = token; this.onTokenError = onTokenError;
    this.ws = null; this.state = 'off'; // off | connecting | live | retrying
    this.latest = new Map();  // instrument id -> latest price plus any quote fields in the feed
    this.subs = new Map();    // 'NIDX:40000001' -> mode
    this.names = new Map();   // instrument id -> name the page knows (NIFTY, NFO_47161)
    this.groups = new Map();  // chain key -> { codes, at }
    this.clients = new Set(); this.dirty = new Set();
    this.retry = 0; this.timer = null;
    // A fault in the stream must never take the server down, so its timers catch everything.
    const safe = (fn) => () => { try { fn(); } catch (e) { console.log(`  Price stream: ${e.message}`); } };
    setInterval(safe(() => this.flush()), 300).unref();
    setInterval(() => { for (const c of this.clients) c.write(': ping\n\n'); }, 20e3).unref(); // keeps idle connections open
    setInterval(safe(() => this.prune()), 60e3).unref();
  }

  status() { return { state: this.state, instruments: this.subs.size, viewers: this.clients.size }; }

  // Keep a set of instruments subscribed. code: 'NIDX:40000001' or 'NFO:47161'; name: the key the page uses.
  want(code, name, mode = 'ltp') {
    const id = code.split(':')[1];
    this.names.set(id, name);
    if (this.subs.get(code) === mode) return;
    this.subs.set(code, mode);
    this.send({ action: 'subscribe', mode, instruments: [code] });
    this.ensure();
  }
  // A chain the page is looking at: quote mode can stream more than the last price.
  // Its contracts stay subscribed while it keeps asking (dropped 3 minutes after the last ask).
  wantGroup(key, items) {
    const g = this.groups.get(key);
    if (g) { g.at = Date.now(); return; }
    const codes = items.slice(0, MAX_INSTRUMENTS - this.subs.size).map(([code]) => code);
    this.groups.set(key, { codes, at: Date.now() });
    const fresh = [];
    for (const [code, name] of items.slice(0, codes.length)) {
      this.names.set(code.split(':')[1], name);
      if (this.subs.get(code) !== 'quote') { this.subs.set(code, 'quote'); fresh.push(code); }
    }
    if (fresh.length) this.send({ action: 'subscribe', mode: 'quote', instruments: fresh });
    this.ensure();
  }
  prune() {
    const keep = new Set();
    for (const [k, g] of this.groups) { if (Date.now() - g.at > 3 * 60e3) this.groups.delete(k); else g.codes.forEach((c) => keep.add(c)); }
    const drop = [...this.subs.keys()].filter((c) => c.startsWith('NFO:') && !keep.has(c));
    if (!drop.length) return;
    for (const c of drop) { const id = c.split(':')[1]; this.subs.delete(c); this.latest.delete(id); this.dirty.delete(id); }
    this.send({ action: 'unsubscribe', mode: 'quote', instruments: drop });
  }

  // Latest tick for an instrument id, if newer than `since` (ms).
  tick(id, since = 0) { const t = this.latest.get(String(id)); return t && t.at > since ? t : null; }

  ensure() {
    if (this.ws || this.timer || !this.token()) return;
    this.state = 'connecting';
    let ws;
    try { ws = new WebSocket(URL, { headers: { Authorization: this.token() } }); } catch (e) { this.state = 'off'; return; }
    this.ws = ws;
    ws.onopen = () => {
      this.state = 'live'; this.retry = 0;
      const by = new Map(); for (const [c, m] of this.subs) { if (!by.has(m)) by.set(m, []); by.get(m).push(c); }
      for (const [mode, instruments] of by) this.send({ action: 'subscribe', mode, instruments });
    };
    ws.onmessage = (e) => { try { this.onMessage(e.data); } catch {} };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      this.ws = null;
      if (e.code === 1008 || /auth|token|unauthor/i.test(e.reason || '')) { this.state = 'off'; this.onTokenError?.(); return; }
      if (!this.token()) { this.state = 'off'; return; }
      // Reconnect with backoff: 1, 2, 4 … 60 s.
      this.state = 'retrying';
      const wait = Math.min(60e3, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => { this.timer = null; this.ensure(); }, wait);
    };
  }
  stop() { clearTimeout(this.timer); this.timer = null; const ws = this.ws; this.ws = null; this.state = 'off'; try { ws?.close(); } catch {} }
  restart() { this.stop(); this.retry = 0; this.ensure(); }

  send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  onMessage(raw) {
    let m; try { m = JSON.parse(raw); if (typeof m === 'string') m = JSON.parse(m); } catch { return; } // frames are JSON-encoded strings
    if (!m?.instrument || !m.data) return;
    const d = m.data;
    const first = (...keys) => { for (const k of keys) if (d[k] != null && Number.isFinite(Number(d[k]))) return Number(d[k]); };
    const ltp = first('ltp', 'live_price', 'last_price', 'close', 'price');
    const prev = this.latest.get(m.instrument) || {};
    const quote = {
      ltp: ltp > 0 ? ltp : prev.ltp,
      o: first('open', 'day_open') ?? prev.o,
      h: first('high', 'day_high') ?? prev.h,
      l: first('low', 'day_low') ?? prev.l,
      prevClose: first('prev_close', 'previous_close_price') ?? prev.prevClose,
      bid: first('bid', 'best_bid', 'top_bid_price') ?? prev.bid,
      ask: first('ask', 'best_ask', 'top_ask_price') ?? prev.ask,
      bidQty: first('bid_quantity', 'top_bid_quantity') ?? prev.bidQty,
      askQty: first('ask_quantity', 'top_ask_quantity') ?? prev.askQty,
      volume: first('volume', 'vol') ?? prev.volume,
      oi: first('open_interest', 'oi') ?? prev.oi,
      oiChange: first('open_interest_change', 'oi_change') ?? prev.oiChange,
      iv: first('iv', 'implied_volatility') ?? prev.iv,
      at: m.timestamp || Date.now(),
    };
    if (quote.ltp == null && Object.values(quote).every((v) => v == null || v === quote.at)) return;
    const changed = ['ltp', 'o', 'h', 'l', 'prevClose', 'bid', 'ask', 'bidQty', 'askQty', 'volume', 'oi', 'oiChange', 'iv']
      .some((k) => quote[k] != null && quote[k] !== prev[k]);
    this.latest.set(m.instrument, quote);
    if (changed) this.dirty.add(m.instrument);
  }

  // Server-sent events to each open page: { ticks: { NIFTY: 23010.5, NFO_47161: 139.95 }, at }.
  attach(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 3000\n\n`);
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    const ticks = {}, quotes = {};
    for (const [id, t] of this.latest) { const n = this.names.get(id); if (n) { if (t.ltp > 0) ticks[n] = t.ltp; quotes[n] = t; } }
    res.write(`data: ${JSON.stringify({ ticks, quotes, at: Date.now(), state: this.state })}\n\n`);
  }
  flush() {
    if (!this.dirty.size || !this.clients.size) { this.dirty.clear(); return; }
    const ticks = {}, quotes = {};
    for (const id of this.dirty) {
      const n = this.names.get(id), t = this.latest.get(id);
      if (n && t) { if (t.ltp > 0) ticks[n] = t.ltp; quotes[n] = t; }
    }
    this.dirty.clear();
    const line = `data: ${JSON.stringify({ ticks, quotes, at: Date.now(), state: this.state })}\n\n`;
    for (const c of this.clients) c.write(line);
  }
}
