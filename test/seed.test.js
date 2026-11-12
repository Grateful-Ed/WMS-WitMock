'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSeed, serializeSeed } = require('../src/seed');
const { Wms } = require('../src/wms');

test('seed is deterministic: identical bytes on every build', () => {
  const a = serializeSeed(buildSeed());
  for (let i = 0; i < 5; i++) assert.equal(serializeSeed(buildSeed()), a);
});

test('data/seed.json is byte-identical to the seed code output', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8');
  assert.equal(file, serializeSeed());
});

test('seed code uses no randomness and no wall clock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'seed.js'), 'utf8');
  assert.doesNotMatch(src, /Math\.random|Date\.now|new Date|crypto|performance\.now/);
});

test('seed shape: doors, zones, bins, pallets', () => {
  const s = buildSeed();
  assert.equal(s.doors.length, 12);
  assert.equal(s.doors.filter((d) => d.direction === 'inbound').length, 6);
  assert.equal(s.doors.filter((d) => d.direction === 'outbound').length, 6);
  assert.equal(s.zones.length, 3);
  assert.equal(s.bins.length, 30);
  for (const z of s.zones) assert.equal(s.bins.filter((b) => b.zone_id === z.id).length, 10);
  assert.equal(s.pallets.length, 8);
  assert.ok(s.asns.length > 0 && s.orders.length > 0 && s.loads.length > 0);
});

test('seed has no wall-clock leakage: store at seed time equals the seed', () => {
  const w = new Wms({ clock: () => 'X' });
  const snap = w.snapshot();
  delete snap.as_of_seq; delete snap.at; delete snap.labor_load; delete snap.generation;
  assert.deepEqual(snap, buildSeed());
});

test('seed references are all valid', () => {
  const s = buildSeed();
  const ids = (k) => new Set(s[k].map((r) => r.id));
  const items = ids('items'); const bins = ids('bins'); const pallets = ids('pallets');
  const doors = ids('doors'); const workers = ids('workers'); const orders = ids('orders');
  for (const r of s.inventory) {
    assert.ok(items.has(r.item_id));
    assert.ok(bins.has(r.location_id) || pallets.has(r.location_id), r.location_id);
    assert.ok(r.qty > 0);
  }
  for (const a of s.asns) assert.ok(doors.has(a.door_id));
  for (const t of s.tasks) { assert.ok(!t.assigned_to || workers.has(t.assigned_to)); assert.ok(items.has(t.item_id)); }
  for (const d of s.deliveries) assert.ok(orders.has(d.order_id));
  for (const i of s.items) assert.ok(bins.has(i.putaway_bin));
});

test('seed ledger replays to exactly the seeded inventory', () => {
  const w = new Wms({ clock: () => 'X' });
  const r = w.reconcile();
  assert.equal(r.ok, true);
  assert.deepEqual(r.mismatches, []);
});

test('open pick demand never exceeds the stock in the pick bin', () => {
  const s = buildSeed();
  const need = new Map();
  for (const t of s.tasks.filter((x) => x.type === 'pick')) need.set(`${t.from_bin}:${t.item_id}`, (need.get(`${t.from_bin}:${t.item_id}`) || 0) + t.qty);
  for (const [k, q] of need) {
    const [loc, item] = k.split(':');
    const row = s.inventory.find((r) => r.location_id === loc && r.item_id === item);
    assert.ok(row && row.qty >= q, k);
  }
});

test('exactly one zone is deliberately overloaded, and the data says which', () => {
  const w = new Wms({ clock: () => 'X' });
  const load = w.snapshot().labor_load;
  assert.equal(load.most_loaded_zone_id, buildSeed().labor_overload.zone_id);
  const by = Object.fromEntries(load.zones.map((z) => [z.zone_id, z]));
  assert.ok(by.ZB.tasks_per_worker >= 5);
  assert.ok(by.ZA.tasks_per_worker <= 1 && by.ZC.tasks_per_worker <= 1);
});
