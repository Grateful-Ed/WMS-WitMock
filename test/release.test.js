'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

let n = 0;
const key = () => `rl-${n++}`;
const release = (api, wave_id, extra = {}) => api.act('release', { idempotency_key: key(), wave_id, ...extra });
const order = (id, wave_id, status, lines) => ({
  id, customer: `Test ${id}`, status, wave_id, delivery_id: null,
  lines: lines.map(([item, qty], k) => ({ line: k + 1, item_id: `SKU-${item}`, qty, picked_qty: 0 })),
});
// Build an unreleased wave straight in the store: a planned wave, its orders, no tasks. Seed file untouched.
function addWave(api, id, orders) {
  for (const o of orders) api.wms.d.orders.push(o);
  api.wms.d.waves.push({ id, status: 'planned', order_ids: orders.map((o) => o.id), released_at: null });
}
const settled = async (api, r) => { await api.settle(); return (await api.get(r.body.status_url)).body; };
const tasksOf = (api, wave) => api.wms.d.tasks.filter((t) => t.wave_id === wave);

test('release is async: 202 first, nothing changes until the verdict, then the wave exists as work', async () => {
  const api = await start();
  try {
    addWave(api, 'WV-401', [order('SO-6001', 'WV-401', 'open', [[1001, 5], [1009, 2]])]);
    const seq0 = api.wms.s.seq;
    const r = await release(api, 'WV-401');
    assert.equal(r.status, 202);
    assert.equal(r.body.status, 'sent');
    assert.equal(r.body.verb, 'release');
    assert.equal(api.wms.s.seq, seq0);
    assert.equal(tasksOf(api, 'WV-401').length, 0);
    const act = await settled(api, r);
    assert.equal(act.status, 'landed');
    assert.deepEqual(act.result.released_order_ids, ['SO-6001']);
    assert.deepEqual(act.result.skipped_order_ids, []);
    assert.equal(act.result.task_ids.length, 2);
    assert.equal(api.wms.d.orders.find((o) => o.id === 'SO-6001').status, 'released');
    const wave = api.wms.d.waves.find((w) => w.id === 'WV-401');
    assert.equal(wave.status, 'released');
    assert.ok(wave.released_at);
    assert.equal(act.result.wave_status, 'released');
    const ev = (await api.get(`/v1/changes?after=${seq0}`)).body.events;
    assert.ok(ev.some((e) => e.entity === 'order' && e.kind === 'update' && e.id === 'SO-6001' && e.fields.status === 'released'));
    assert.ok(ev.some((e) => e.entity === 'wave' && e.kind === 'update' && e.id === 'WV-401' && e.fields.status === 'released'));
    assert.deepEqual(ev.filter((e) => e.entity === 'task' && e.kind === 'insert').map((e) => e.id), act.result.task_ids);
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);
  } finally { await api.close(); }
});

test('created tasks match the seeded pick tasks: zone, bin, quantity, destination, and assignment', async () => {
  const api = await start();
  try {
    // Four new orders with the same lines as SO-5001 to SO-5004 must give the same tasks as the seed has.
    const seeded = api.wms.d.tasks.filter((t) => t.type === 'pick' && t.wave_id === 'WV-301');
    assert.equal(seeded.length, 17);
    const orders = ['SO-5001', 'SO-5002', 'SO-5003', 'SO-5004'].map((id, i) => {
      const src = api.wms.d.orders.find((o) => o.id === id);
      return order(`SO-610${i + 1}`, 'WV-402', 'open', src.lines.map((l) => [Number(l.item_id.slice(4)), l.qty]));
    });
    addWave(api, 'WV-402', orders);
    const r = await release(api, 'WV-402');
    const act = await settled(api, r);
    assert.equal(act.status, 'landed');
    const made = tasksOf(api, 'WV-402');
    assert.equal(made.length, 17);
    const shape = (t, wave, map) => ({ ...t, id: undefined, created_at: undefined, wave_id: wave, order_id: map(t.order_id), to_location: map(t.to_location) });
    const toSeed = (id) => id.replace('SO-610', 'SO-500');
    assert.deepEqual(made.map((t) => shape(t, 'WV-301', toSeed)), seeded.map((t) => shape(t, 'WV-301', (x) => x)));
    assert.deepEqual(Object.keys(made[0]), Object.keys(seeded[0]));
    assert.equal(made[0].id, 'TK-0023'); // the next free task id (the seed has 22)
  } finally { await api.close(); }
});

test('releasing the same wave again creates nothing; the same key replays the first result', async () => {
  const api = await start();
  try {
    addWave(api, 'WV-403', [order('SO-6201', 'WV-403', 'open', [[1002, 3]]), order('SO-6202', 'WV-403', 'open', [[1011, 1]])]);
    const k = key();
    const first = await api.act('release', { idempotency_key: k, wave_id: 'WV-403' });
    const done = await settled(api, first);
    assert.equal(done.result.task_ids.length, 2);
    const seq = api.wms.s.seq;
    const replay = await api.act('release', { idempotency_key: k, wave_id: 'WV-403' });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.deepEqual(replay.body.result, done.result);
    const again = await release(api, 'WV-403'); // a new key is a new request
    const second = await settled(api, again);
    assert.equal(second.status, 'landed');
    assert.deepEqual(second.result.released_order_ids, []);
    assert.deepEqual(second.result.task_ids, []);
    assert.deepEqual(second.result.skipped_order_ids, ['SO-6201', 'SO-6202']);
    assert.equal(api.wms.s.seq, seq);
    assert.equal(tasksOf(api, 'WV-403').length, 2);
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);
  } finally { await api.close(); }
});

test('orders already released or beyond are skipped; only open orders are released', async () => {
  const api = await start();
  try {
    addWave(api, 'WV-404', [
      order('SO-6301', 'WV-404', 'open', [[1003, 2]]),
      order('SO-6302', 'WV-404', 'released', [[1003, 2]]),
      order('SO-6303', 'WV-404', 'picked', [[1003, 2]]),
      order('SO-6304', 'WV-404', 'shipped', [[1003, 2]]),
    ]);
    const act = await settled(api, await release(api, 'WV-404'));
    assert.deepEqual(act.result.released_order_ids, ['SO-6301']);
    assert.deepEqual(act.result.skipped_order_ids, ['SO-6302', 'SO-6303', 'SO-6304']);
    assert.deepEqual(tasksOf(api, 'WV-404').map((t) => t.order_id), ['SO-6301']);
    assert.deepEqual(api.wms.d.orders.filter((o) => o.wave_id === 'WV-404').map((o) => o.status), ['released', 'released', 'picked', 'shipped']);
  } finally { await api.close(); }
});

test('the seeded waves ship as they are: WV-301 releases nothing, planned WV-302 releases its two orders', async () => {
  const api = await start();
  try {
    const none = await settled(api, await release(api, 'WV-301'));
    assert.deepEqual(none.result.task_ids, []);
    assert.equal(api.wms.d.tasks.filter((t) => t.type === 'pick').length, 17);
    const act = await settled(api, await release(api, 'WV-302'));
    assert.deepEqual(act.result.released_order_ids, ['SO-5005', 'SO-5006']);
    assert.equal(act.result.task_ids.length, 3);
    assert.deepEqual(tasksOf(api, 'WV-302').map((t) => [t.from_bin, t.qty, t.to_location]),
      [['ZB-01-01', 10, 'PK-SO-5005'], ['ZB-02-01', 4, 'PK-SO-5005'], ['ZB-01-04', 6, 'PK-SO-5006']]);
    assert.equal((await api.get('/v1/snapshot')).body.waves.find((w) => w.id === 'WV-302').status, 'released');
    assert.equal(api.wms.d.orders.find((o) => o.id === 'SO-5010').status, 'open'); // no wave, so not touched
  } finally { await api.close(); }
});

test('unknown or malformed wave_id: 404 or 400 at once, and the key is not used up', async () => {
  const api = await start();
  try {
    const k = key();
    const r = await api.act('release', { idempotency_key: k, wave_id: 'WV-999' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'not_found');
    assert.equal(api.wms.s.acts.length, 0);
    assert.equal((await api.act('release', { idempotency_key: k, wave_id: 'WV-302' })).status, 202); // key still free
    for (const body of [{}, { wave_id: 5 }, { wave_id: '' }, { wave_id: null }]) {
      const bad = await api.act('release', { idempotency_key: key(), ...body });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'invalid_request');
    }
    assert.equal((await api.act('release', { wave_id: 'WV-302' })).body.error.code, 'missing_idempotency_key');
  } finally { await api.close(); }
});

test('a line with no bin refuses the whole release and changes nothing', async () => {
  const api = await start();
  try {
    api.wms.d.items.push({ ...api.wms.d.items[0], id: 'SKU-9999' });
    addWave(api, 'WV-405', [order('SO-6401', 'WV-405', 'open', [[1001, 1]]), order('SO-6402', 'WV-405', 'open', [[9999, 1]])]);
    const seq = api.wms.s.seq;
    const act = await settled(api, await release(api, 'WV-405'));
    assert.equal(act.status, 'refused');
    assert.match(act.reason, /SKU-9999/);
    assert.equal(api.wms.s.seq, seq);
    assert.equal(tasksOf(api, 'WV-405').length, 0);
    assert.deepEqual(api.wms.d.orders.filter((o) => o.wave_id === 'WV-405').map((o) => o.status), ['open', 'open']);
    assert.equal(api.wms.d.waves.find((w) => w.id === 'WV-405').status, 'planned');
  } finally { await api.close(); }
});

test('released tasks work like any pick task: pick them all and the order is picked and the wave follows', async () => {
  const api = await start();
  try {
    addWave(api, 'WV-406', [order('SO-6501', 'WV-406', 'open', [[1001, 4], [1010, 2]])]);
    const act = await settled(api, await release(api, 'WV-406'));
    for (const id of act.result.task_ids) {
      const r = await api.act('complete', { idempotency_key: key(), task_id: id });
      assert.equal(r.status, 200);
    }
    assert.equal(api.wms.d.orders.find((o) => o.id === 'SO-6501').status, 'picked');
    assert.equal(api.wms.d.waves.find((w) => w.id === 'WV-406').status, 'picked');
    assert.equal(api.wms.d.tasks.filter((t) => t.type === 'pack' && t.order_id === 'SO-6501').length, 1);
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);
  } finally { await api.close(); }
});
