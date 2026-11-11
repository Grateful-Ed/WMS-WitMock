'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

const total = async (api, item) => {
  const r = (await api.get('/v1/reconcile')).body;
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
  return r.items.find((i) => i.item_id === item).on_hand_qty;
};

test('quantities reconcile after every movement type', async () => {
  const api = await start();
  try {
    let n = 0;
    const done = async (task_id, extra = {}) => {
      const r = await api.act('complete', { idempotency_key: `k${n++}`, task_id, ...extra });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await api.get('/v1/reconcile')).body.ok, true);
      return r.body.result;
    };
    const snap = (await api.get('/v1/snapshot')).body;
    const before = await total(api, 'SKU-1001');

    // receive
    const rcv = await api.act('post-receiving', { idempotency_key: 'r1', asn_id: 'ASN-1004', lines: [{ line: 1, qty: 30 }] });
    assert.equal(rcv.status, 202);
    await api.settle();
    // putaway: seeded pallet PAL-001 moves from staging into its bin
    const put = snap.tasks.find((t) => t.type === 'putaway');
    const palletQty = snap.inventory.find((r) => r.location_id === put.pallet_id).qty;
    const binBefore = snap.inventory.find((r) => r.location_id === put.to_bin && r.item_id === put.item_id).qty;
    await done(put.id);
    const after = (await api.get('/v1/snapshot')).body;
    assert.equal(after.inventory.find((r) => r.location_id === put.to_bin && r.item_id === put.item_id).qty, binBefore + palletQty);
    assert.equal(after.inventory.find((r) => r.location_id === put.pallet_id), undefined);

    // pick every line of SO-5001, then pack
    const picks = snap.tasks.filter((t) => t.type === 'pick' && t.order_id === 'SO-5001');
    let last;
    for (const p of picks) last = await done(p.id);
    assert.ok(last.pack_task_id);
    const packed = await done(last.pack_task_id);
    assert.ok(packed.delivery_id);

    // ship the new delivery on the loading load
    const c = await api.act('confirm-load', { idempotency_key: 'cl', load_id: 'LD-9001', delivery_ids: [packed.delivery_id] });
    assert.equal(c.status, 202);
    const unitsOnLoad = snap.inventory.filter((r) => ['PAL-004', 'PAL-005', 'PAL-006'].includes(r.location_id)).reduce((s, r) => s + r.qty, 0);
    await api.settle();
    const st = (await api.get(`/v1/acts/${c.body.act_id}`)).body;
    assert.equal(st.status, 'landed');
    assert.equal(st.result.units_shipped, unitsOnLoad + 22);
    assert.ok((await total(api, 'SKU-1001')) < before + 100);
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);

    // cycle count with variance adjusts stock and raises an exception
    const ct = snap.tasks.find((t) => t.type === 'count' && t.cycle_count_id === 'CC-401');
    const sys = snap.inventory.find((r) => r.location_id === 'ZA-01-02' && r.item_id === 'SKU-1002').qty;
    const res = await done(ct.id, { counted_qty: sys - 3 });
    assert.equal(res.variance, -3);
    assert.ok(res.exception_id);
    const fin = (await api.get('/v1/snapshot')).body;
    assert.equal(fin.inventory.find((r) => r.location_id === 'ZA-01-02' && r.item_id === 'SKU-1002').qty, sys - 3);
  } finally { await api.close(); }
});

test('exact unit accounting: order total leaves the building and nowhere else', async () => {
  const api = await start();
  try {
    const snap = (await api.get('/v1/snapshot')).body;
    const sum = (s, item) => s.inventory.filter((r) => r.item_id === item).reduce((a, r) => a + r.qty, 0);
    const start1007 = sum(snap, 'SKU-1007');
    // ship load LD-9002 (SO-5009 had 4 x SKU-1007 on PAL-008)
    await api.act('confirm-load', { idempotency_key: 'a', load_id: 'LD-9002' });
    await api.settle();
    const after = (await api.get('/v1/snapshot')).body;
    assert.equal(sum(after, 'SKU-1007'), start1007 - 4);
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);
  } finally { await api.close(); }
});

test('a refused pick leaves stock untouched', async () => {
  const api = await start();
  try {
    api.wms.d.inventory.find((r) => r.location_id === 'ZB-01-01').qty = 1; // force a shortage
    const before = JSON.stringify(api.wms.d.inventory);
    const task = api.wms.d.tasks.find((t) => t.type === 'pick' && t.from_bin === 'ZB-01-01');
    const r = await api.act('complete', { idempotency_key: 'short', task_id: task.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'insufficient_stock');
    assert.equal(JSON.stringify(api.wms.d.inventory), before);
  } finally { await api.close(); }
});
