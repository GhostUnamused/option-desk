import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NseProvider, nseGate } from '../lib/nse.js';
import { BrokerManager } from '../lib/brokers.js';

const fake = { name: 'Fake', status: () => ({ connected: false }), usable: () => false };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ow-')), 'broker-settings.json');

test('NSE stays off until chosen, and the choice is remembered', async () => {
  const file = tmp();
  let m = new BrokerManager({ indstocks: fake }, file);
  assert.equal(nseGate.open, false);
  assert.equal(m.status().needsChoice, true);
  await assert.rejects(() => new NseProvider().raw('/api/allIndices'), /switched off/);
  m.setNse(true);
  assert.equal(nseGate.open, true);
  assert.equal(m.status().needsChoice, false);
  m = new BrokerManager({ indstocks: fake }, file);
  assert.equal(m.nse, true);
  assert.equal(nseGate.open, true);
  m.select('indstocks');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nse, true, 'selecting a broker must not reset the NSE choice');
  m.setNse(false);
  nseGate.open = true; // leave the shared gate open for other test files
});
