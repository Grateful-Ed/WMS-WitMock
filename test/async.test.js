'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

test('post-receiving: sent -> landed', async () => {
  const api = await start();
  try {
    const before = (await api.get('/v1/snapshot')).body;
    const r = await api.act('post-receiving', { idempotency_key: 'r', asn_id: 'ASN-1004', lines: [{ line: 1, qty: 60 }, { line: 2, qty: 48 }] });
    assert.equal(r.status, 202);
    assert.equal(r.body.status, 'sent');
    assert.equal(r.body.status_url, `/v1/acts/${r.body.act_id}`);
    // sent means nothing has happened yet
    const mid = (await api.get('/v1/snapshot')).body;
    assert.equal(mid.as_of_seq, before.as_of_seq);
    assert.equal((await api.get(r.body.status_url)).body.status, 'sent');

    assert.deepEqual((await api.settle()).body.settled, [r.body.act_id]);
    const v = (await api.get(r.body.status_url)).body;
    assert.equal(v.status, 'landed');
    assert.equal(v.reason, null);
    assert.equal(v.result.asn_status, 'received');
    assert.equal(v.result.pallets.length, 2);
    const after = (await api.get('/v1/snapshot')).body;
    assert.equal(after.asns.find((a) => a.id === 'ASN-1004').status, 'received');
    assert.equal(after.doors.find((d) => d.id === 'D04').status, 'free');
    assert.equal(after.tasks.filter((t) => t.type === 'putaway' && t.status === 'open').length, 5);
  } finally { await api.close(); }
});

test('post-receiving: sent -> refused (over-receipt), nothing applied', async () => {
  const api = await start();
  try {
    const r = await api.act('post-receiving', { idempotency_key: 'over', asn_id: 'ASN-1004', lines: [{ line: 1, qty: 61 }] });
    assert.equal(r.status, 202);
    const seq = (await api.get('/v1/snapshot')).body.as_of_seq;
    await api.settle();
    const v = (await api.get(r.body.status_url)).body;
    assert.equal(v.status, 'refused');
    assert.match(v.reason, /too many/);
    assert.equal(v.result, null);
    assert.equal((await api.get('/v1/snapshot')).body.as_of_seq, seq);
  } finally { await api.close(); }
});

test('post-receiving: refused when the truck has not arrived', async () => {
  const api = await start();
  try {
    const r = await api.act('post-receiving', { idempotency_key: 'sch', asn_id: 'ASN-1001', lines: [{ line: 1, qty: 10 }] });
    await api.settle();
    const v = (await api.get(r.body.status_url)).body;
    assert.equal(v.status, 'refused');
    assert.match(v.reason, /not arrived/);
  } finally { await api.close(); }
});

test('confirm-load: sent -> landed', async () => {
  const api = await start();
  try {
    const r = await api.act('confirm-load', { idempotency_key: 'cl', load_id: 'LD-9001' });
    assert.equal(r.status, 202);
    assert.equal((await api.get('/v1/snapshot')).body.loads.find((l) => l.id === 'LD-9001').status, 'loading');
    await api.settle();
    const v = (await api.get(r.body.status_url)).body;
    assert.equal(v.status, 'landed');
    assert.equal(v.result.pallets_shipped, 3);
    const s = (await api.get('/v1/snapshot')).body;
    assert.equal(s.loads.find((l) => l.id === 'LD-9001').status, 'shipped');
    assert.equal(s.orders.find((o) => o.id === 'SO-5007').status, 'shipped');
    assert.equal(s.doors.find((d) => d.id === 'D07').status, 'free');
  } finally { await api.close(); }
});

test('confirm-load: sent -> refused (already shipped, unknown delivery)', async () => {
  const api = await start();
  try {
    await api.act('confirm-load', { idempotency_key: 'one', load_id: 'LD-9001' });
    await api.settle();
    const again = await api.act('confirm-load', { idempotency_key: 'two', load_id: 'LD-9001' });
    const bad = await api.act('confirm-load', { idempotency_key: 'three', load_id: 'LD-9002', delivery_ids: ['OD-0000'] });
    await api.settle();
    const a = (await api.get(again.body.status_url)).body;
    const b = (await api.get(bad.body.status_url)).body;
    assert.equal(a.status, 'refused');
    assert.match(a.reason, /already shipped/);
    assert.equal(b.status, 'refused');
    assert.match(b.reason, /does not exist/);
    assert.equal((await api.get('/v1/snapshot')).body.loads.find((l) => l.id === 'LD-9002').status, 'planned');
  } finally { await api.close(); }
});

test('timer mode: verdict arrives by itself after the delay', async () => {
  const { Wms } = require('../src/wms');
  const w = new Wms({ asyncDelayMs: 20 });
  const out = w.submit('confirm-load', { idempotency_key: 't', load_id: 'LD-9002' });
  assert.equal(out.status, 202);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.getAct(out.body.act_id).status, 'landed');
});
