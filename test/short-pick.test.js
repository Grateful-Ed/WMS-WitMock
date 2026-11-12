'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

let n = 0;
const key = () => `sp-${n++}`;
const complete = (api, task_id, extra = {}) => api.act('complete', { idempotency_key: key(), task_id, ...extra });
const picksOf = (api, order) => api.wms.d.tasks.filter((t) => t.type === 'pick' && t.order_id === order);
const orderOf = (api, id) => api.wms.d.orders.find((o) => o.id === id);

test('short pick closes the line as short, moves actual stock, raises a shortage, and feeds the change log', async () => {
  const api = await start();
  try {
    const task = picksOf(api, 'SO-5001')[0]; // TK-0001, 12 x SKU-1001 from ZB-01-01
    const seq0 = (await api.get('/v1/snapshot')).body.as_of_seq;
    const r = await complete(api, task.id, { picked_qty: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'landed');
    assert.equal(r.body.result.qty, 7);
    assert.equal(r.body.result.short, true);
    assert.match(r.body.result.exception_id, /^EX-/);
    const line = orderOf(api, 'SO-5001').lines[0];
    assert.equal(line.picked_qty, 7);
    assert.equal(line.status, 'short');
    assert.equal(api.wms.d.tasks.find((t) => t.id === task.id).status, 'done');
    assert.equal(api.wms.d.inventory.find((x) => x.location_id === 'PK-SO-5001' && x.item_id === 'SKU-1001').qty, 7);
    const ex = api.wms.d.exceptions.find((e) => e.id === r.body.result.exception_id);
    assert.deepEqual([ex.kind, ex.entity, ex.entity_id, ex.status], ['shortage', 'order', 'SO-5001', 'open']);
    const ev = (await api.get(`/v1/changes?after=${seq0}`)).body.events;
    assert.ok(ev.some((e) => e.entity === 'task' && e.id === task.id && e.fields.status === 'done'));
    assert.ok(ev.some((e) => e.entity === 'order' && e.id === 'SO-5001' && e.fields.lines[0].status === 'short'));
    assert.ok(ev.some((e) => e.entity === 'exception' && e.kind === 'insert' && e.id === ex.id));
    assert.ok(ev.some((e) => e.entity === 'ledger' && e.fields.qty === 7 && e.fields.type === 'pick'));
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);
  } finally { await api.close(); }
});

test('picked_qty refusals: zero, above task qty, wrong type, not a whole number, above bin stock', async () => {
  const api = await start();
  try {
    const task = picksOf(api, 'SO-5001')[0];
    const before = api.wms.s.seq;
    const zero = await complete(api, task.id, { picked_qty: 0 });
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, 'invalid_request');
    assert.match(zero.body.error.reason, /Zero means the act did not happen/);
    for (const bad of [13, -1, 1.5, '5', null]) {
      const r = await complete(api, task.id, { picked_qty: bad });
      assert.equal(r.status, 400, `picked_qty ${JSON.stringify(bad)}`);
      assert.equal(r.body.error.code, 'invalid_request');
    }
    const put = api.wms.d.tasks.find((t) => t.type === 'putaway');
    assert.equal((await complete(api, put.id, { picked_qty: 1 })).status, 400);
    assert.equal(api.wms.s.seq, before, 'validation refusals change nothing');
    // bin holds less than the requested picked_qty -> existing insufficient_stock refusal
    api.wms.d.inventory.find((x) => x.location_id === task.from_bin && x.item_id === task.item_id).qty = 5;
    const short = await complete(api, task.id, { picked_qty: 6 });
    assert.equal(short.status, 409);
    assert.equal(short.body.error.code, 'insufficient_stock');
    // but a pick within the stock now works
    assert.equal((await complete(api, task.id, { picked_qty: 5 })).status, 200);
  } finally { await api.close(); }
});

test('a short order packs and ships what was actually picked, with no second exception at pack time', async () => {
  const api = await start();
  try {
    const picks = picksOf(api, 'SO-5001');
    const first = await complete(api, picks[0].id, { picked_qty: 7 });
    assert.notEqual(orderOf(api, 'SO-5001').status, 'picked', 'not picked until every line is closed');
    await complete(api, picks[1].id);
    const last = await complete(api, picks[2].id);
    assert.equal(orderOf(api, 'SO-5001').status, 'picked');
    assert.ok(last.body.result.pack_task_id);
    assert.equal(last.body.result.exception_id, undefined);
    const exBefore = api.wms.d.exceptions.length;
    const pack = await complete(api, last.body.result.pack_task_id);
    assert.equal(pack.status, 200);
    assert.equal(api.wms.d.exceptions.length, exBefore, 'no second exception');
    const pallet = pack.body.result.pallet_id;
    const onPallet = Object.fromEntries(api.wms.d.inventory.filter((r) => r.location_id === pallet).map((r) => [r.item_id, r.qty]));
    assert.deepEqual(onPallet, { 'SKU-1001': 7, 'SKU-1003': 6, 'SKU-1009': 4 });
    assert.equal(api.wms.d.inventory.filter((r) => r.location_id === 'PK-SO-5001').length, 0);
    const order = orderOf(api, 'SO-5001');
    assert.deepEqual(order.lines.map((l) => [l.qty, l.picked_qty]), [[12, 7], [6, 6], [4, 4]]);
    const load = await api.act('confirm-load', { idempotency_key: key(), load_id: 'LD-9001', delivery_ids: [pack.body.result.delivery_id] });
    assert.equal(load.status, 202);
    await api.settle();
    const verdict = (await api.get(`/v1/acts/${load.body.act_id}`)).body;
    assert.equal(verdict.status, 'landed');
    assert.equal(orderOf(api, 'SO-5001').status, 'shipped');
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);
    assert.equal(first.body.result.short, true);
  } finally { await api.close(); }
});

test('an order whose every line is short is picked and still gets a pack task (picked_qty is at least 1)', async () => {
  const api = await start();
  try {
    let last;
    for (const t of picksOf(api, 'SO-5001')) last = await complete(api, t.id, { picked_qty: 1 });
    assert.ok(last.body.result.pack_task_id);
    assert.equal(api.wms.d.exceptions.filter((e) => e.kind === 'shortage' && e.entity_id === 'SO-5001').length, 3);
    const o = orderOf(api, 'SO-5001');
    assert.ok(o.lines.reduce((s, l) => s + l.picked_qty, 0) > 0);
  } finally { await api.close(); }
});

test('a full-quantity pick is unchanged: explicit picked_qty equal to the task quantity matches omitting it, event for event', async () => {
  const run = async (explicit) => {
    const api = await start();
    try {
      const tasks = picksOf(api, 'SO-5001');
      let last;
      const results = [];
      for (const t of tasks) {
        last = await complete(api, t.id, explicit ? { picked_qty: t.qty } : {});
        results.push(last.body.result);
      }
      const pack = await complete(api, last.body.result.pack_task_id);
      const ev = (await api.get('/v1/changes?after=0&limit=1000')).body.events;
      // the shared test clock keeps ticking across runs, so compare everything except timestamps
      const noTime = JSON.parse(JSON.stringify(ev, (k, v) => (['at', 'created_at', 'completed_at'].includes(k) ? undefined : v)));
      return { results, pack: pack.body.result, ev: noTime, lines: orderOf(api, 'SO-5001').lines };
    } finally { await api.close(); }
  };
  const a = await run(false);
  const b = await run(true);
  assert.deepEqual(b, a);
  for (const l of a.lines) assert.deepEqual(Object.keys(l), ['line', 'item_id', 'qty', 'picked_qty']);
  assert.deepEqual(Object.keys(a.results[0]), ['task_id', 'type', 'order_id', 'qty', 'from_bin', 'to_location']);
  assert.ok(!a.ev.some((e) => e.entity === 'exception'), 'a full pick raises no exception');
});

test('a line that reaches its full quantity carries no status, even after an earlier short pick', async () => {
  const api = await start();
  try {
    // Two pick tasks for one line, built directly in the store: line 1 of SO-5001 orders 12.
    const [a, ...others] = picksOf(api, 'SO-5001');
    api.wms._insert('tasks', { ...a, id: 'TK-9001', qty: 5 });
    const shortages = () => api.wms.d.exceptions.filter((e) => e.kind === 'shortage' && e.entity_id === 'SO-5001');
    const line = () => orderOf(api, 'SO-5001').lines[0];

    const first = await complete(api, a.id, { picked_qty: 7 }); // 7 of 12: short
    assert.equal(first.body.result.short, true);
    assert.deepEqual([line().picked_qty, line().status], [7, 'short']);
    assert.equal(shortages().length, 1);

    const second = await complete(api, 'TK-9001'); // the remaining 5 in full
    assert.equal(second.status, 200);
    assert.equal(line().picked_qty, 12);
    assert.equal('status' in line(), false, 'a full line has no status field');
    assert.equal(shortages().length, 1, 'the shortage exception stands as the historical record');
    assert.equal(second.body.result.short, undefined);

    let last;
    for (const t of others) last = await complete(api, t.id);
    assert.equal(orderOf(api, 'SO-5001').status, 'picked');
    assert.equal(api.wms.d.tasks.filter((t) => t.type === 'pack' && t.order_id === 'SO-5001').length, 1);
    assert.ok(last.body.result.pack_task_id);
    assert.equal((await api.get('/v1/reconcile')).body.ok, true);
  } finally { await api.close(); }
});

test('a one-task short pick still ends flagged short', async () => {
  const api = await start();
  try {
    await complete(api, picksOf(api, 'SO-5001')[0].id, { picked_qty: 11 });
    const l = orderOf(api, 'SO-5001').lines[0];
    assert.deepEqual([l.picked_qty, l.status], [11, 'short']);
  } finally { await api.close(); }
});

test('a short pick or pack creates no task of its own (no re-pick, no replenishment)', async () => {
  const api = await start();
  try {
    const picks = picksOf(api, 'SO-5001');
    const ids = () => api.wms.d.tasks.map((t) => t.id).sort();
    const before = ids();
    await complete(api, picks[0].id, { picked_qty: 7 });
    assert.deepEqual(ids(), before, 'a short pick that does not finish the order adds no task');
    await complete(api, picks[1].id);
    const last = await complete(api, picks[2].id);
    assert.deepEqual(ids().filter((id) => !before.includes(id)), [last.body.result.pack_task_id], 'only the pack task appears');
    const afterPick = ids();
    await complete(api, last.body.result.pack_task_id);
    assert.deepEqual(ids(), afterPick, 'packing a short order adds no task');
  } finally { await api.close(); }
});
