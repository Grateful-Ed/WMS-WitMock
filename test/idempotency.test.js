'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

const events = (api) => api.wms.s.events.length;

test('complete: duplicate key returns the original outcome and applies once', async () => {
  const api = await start();
  try {
    const body = { idempotency_key: 'dup-1', task_id: 'TK-0001' };
    const first = await api.act('complete', body);
    assert.equal(first.status, 200);
    const n = events(api);
    const again = await api.act('complete', body);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
    assert.equal(again.headers.get('idempotent-replay'), 'true');
    assert.equal(events(api), n, 'replay must emit no new change events');
    const snap = (await api.get('/v1/snapshot')).body;
    const line = snap.orders.find((o) => o.id === 'SO-5001').lines[0];
    assert.equal(line.picked_qty, 12, 'picked once, not twice');
  } finally { await api.close(); }
});

test('complete: a duplicate of a refused act returns the same refusal', async () => {
  const api = await start();
  try {
    await api.act('complete', { idempotency_key: 'a', task_id: 'TK-0001' });
    const r1 = await api.act('complete', { idempotency_key: 'b', task_id: 'TK-0001' });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error.code, 'task_not_open');
    const r2 = await api.act('complete', { idempotency_key: 'b', task_id: 'TK-0001' });
    assert.equal(r2.status, 409);
    assert.deepEqual(r2.body, r1.body);
  } finally { await api.close(); }
});

test('flag: duplicate key creates one exception only', async () => {
  const api = await start();
  try {
    const body = { idempotency_key: 'f1', entity: 'asn', id: 'ASN-1004', kind: 'shortage', reason: 'Pallet short by 4 cartons.' };
    const a = await api.act('flag', body);
    const b = await api.act('flag', body);
    assert.equal(a.status, 200);
    assert.deepEqual(b.body, a.body);
    const ex = (await api.get('/v1/snapshot')).body.exceptions;
    assert.equal(ex.length, 3);
    assert.equal(ex.filter((e) => e.reason === body.reason).length, 1);
    assert.equal(ex[2].severity, 'medium');
  } finally { await api.close(); }
});

test('post-receiving: duplicate key, before and after the verdict, never receives twice', async () => {
  const api = await start();
  try {
    const body = { idempotency_key: 'p1', asn_id: 'ASN-1003', lines: [{ line: 1, qty: 40 }] };
    const a = await api.act('post-receiving', body);
    assert.equal(a.status, 202);
    const b = await api.act('post-receiving', body);
    assert.equal(b.status, 202);
    assert.equal(b.body.act_id, a.body.act_id);
    await api.settle();
    const c = await api.act('post-receiving', body);
    assert.equal(c.status, 200);
    assert.equal(c.body.act_id, a.body.act_id);
    assert.equal(c.body.status, 'landed');
    assert.equal(c.headers.get('idempotent-replay'), 'true');
    const asn = (await api.get('/v1/snapshot')).body.asns.find((x) => x.id === 'ASN-1003');
    assert.equal(asn.lines[0].received_qty, 40);
    assert.equal((await api.get('/v1/snapshot')).body.pallets.length, 9);
  } finally { await api.close(); }
});

test('confirm-load: duplicate key ships once', async () => {
  const api = await start();
  try {
    const body = { idempotency_key: 'c1', load_id: 'LD-9001', seal_no: 'S-1' };
    await api.act('confirm-load', body);
    await api.settle();
    const r = await api.act('confirm-load', body);
    assert.equal(r.body.status, 'landed');
    const snap = (await api.get('/v1/snapshot')).body;
    assert.equal(snap.ledger.filter((l) => l.type === 'ship').length, 3);
    assert.equal(snap.loads.find((l) => l.id === 'LD-9001').seal_no, 'S-1');
  } finally { await api.close(); }
});

test('same key with a different request is rejected, not replayed', async () => {
  const api = await start();
  try {
    await api.act('complete', { idempotency_key: 'x', task_id: 'TK-0001' });
    const r = await api.act('complete', { idempotency_key: 'x', task_id: 'TK-0002' });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'idempotency_key_reuse');
    assert.ok(r.body.error.reason.length > 10);
  } finally { await api.close(); }
});

test('key can come from the Idempotency-Key header; missing key is a 400', async () => {
  const api = await start();
  try {
    const h = await api.call('POST', '/v1/acts/complete', { task_id: 'TK-0002' }, { 'idempotency-key': 'hdr-1' });
    assert.equal(h.status, 200);
    assert.equal(h.body.idempotency_key, 'hdr-1');
    const none = await api.act('complete', { task_id: 'TK-0003' });
    assert.equal(none.status, 400);
    assert.equal(none.body.error.code, 'missing_idempotency_key');
  } finally { await api.close(); }
});
