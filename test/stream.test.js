// Price stream bookkeeping without a network: ticks reach pages, and dropping a chain never breaks the flush.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PriceStream } from '../lib/stream.js';

const page = () => { const out = []; return { out, writeHead() {}, write(s) { out.push(s); }, on() {} }; };

test('ticks are sent to pages by the names the page knows', () => {
  const s = new PriceStream({ token: () => null });
  s.names.set('40000001', 'NIFTY'); s.names.set('47161', 'NFO_47161');
  const p = page(); s.attach(p);
  s.onMessage(JSON.stringify(JSON.stringify({ mode: 'quote', instrument: '40000001', timestamp: 1, data: { close: 23010.5, open: 22900 } })));
  s.onMessage(JSON.stringify({ mode: 'ltp', instrument: '47161', timestamp: 2, data: { ltp: 139.95 } }));
  s.flush();
  const last = JSON.parse(p.out.at(-1).slice(6));
  assert.deepEqual(last.ticks, { NIFTY: 23010.5, NFO_47161: 139.95 });
  assert.equal(s.tick('47161').ltp, 139.95);
});

test('a chain dropped while its ticks wait does not break the next flush', () => {
  const s = new PriceStream({ token: () => null });
  s.wantGroup('NIFTY|2026-10-20', [['NFO:1', 'NFO_1']]);
  s.attach(page());
  s.onMessage(JSON.stringify({ mode: 'ltp', instrument: '1', timestamp: 1, data: { ltp: 5 } }));
  s.groups.get('NIFTY|2026-10-20').at = 0; // stale
  s.prune();
  assert.doesNotThrow(() => s.flush());
  assert.equal(s.subs.size, 0);
});
