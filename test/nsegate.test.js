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

test('an install from before 0.10 with a saved broker keeps NSE as a backup; a fresh one does not', () => {
  const saved = { ...fake, status: () => ({ connected: false, hasToken: true, source: 'saved' }) };
  const env = { ...fake, status: () => ({ connected: false, hasToken: true, source: 'env' }) };
  const old = tmp(); fs.writeFileSync(old, JSON.stringify({ provider: 'indstocks' }));
  let m = new BrokerManager({ indstocks: saved }, old);
  assert.equal(m.nse, true);
  assert.equal(m.status().needsChoice, false, 'an expired token must not leave an old install without prices');
  assert.equal(JSON.parse(fs.readFileSync(old, 'utf8')).nse, true, 'the migration is written down once');
  m.setNse(false);
  assert.equal(new BrokerManager({ indstocks: saved }, old).nse, false, 'turning it off afterwards sticks');
  assert.equal(new BrokerManager({ indstocks: saved }, tmp()).nse, true, 'saved credentials without a settings file count too');
  assert.equal(new BrokerManager({ indstocks: fake }, tmp()).nse, false, 'fresh install: off');
  assert.equal(new BrokerManager({ indstocks: env }, tmp()).nse, false, 'a .env token in a source run is not an old install');
  nseGate.open = true;
});
