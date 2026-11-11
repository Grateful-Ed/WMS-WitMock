'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./helpers');
const { Wms, ENTITY, idOf } = require('../src/wms');

test('API key is required on /v1; errors are JSON with a reason', async () => {
  const api = await start();
  try {
    for (const headers of [{ 'x-api-key': '' }, { 'x-api-key': 'wrong' }]) {
      const r = await api.call('GET', '/v1/snapshot', undefined, headers);
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'unauthorized');
      assert.ok(r.body.error.reason.length > 5);
    }
    const bearer = await api.call('GET', '/v1/snapshot', undefined, { 'x-api-key': '', authorization: 'Bearer test-key' });
    assert.equal(bearer.status, 200);
    assert.equal((await api.call('GET', '/health', undefined, { 'x-api-key': '' })).status, 200);
    assert.equal((await api.get('/v1/nope')).status, 404);
    const bad = await api.act('complete', { idempotency_key: 'k' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_request');
    assert.equal((await api.act('complete', { idempotency_key: 'k2', task_id: 'TK-9999' })).status, 404);
    assert.equal((await api.act('fly', { idempotency_key: 'k3' })).status, 404);
    assert.equal((await api.get('/v1/acts/complete')).status, 405);
    const res = await fetch(`${api.base}/v1/acts/flag`, { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_json');
  } finally { await api.close(); }
});

test('snapshot carries the whole warehouse and its position in the feed', async () => {
  const api = await start();
  try {
    const s = (await api.get('/v1/snapshot')).body;
    assert.equal(s.as_of_seq, 0);
    assert.equal(s.doors.length, 12);
    assert.equal(s.bins.length, 30);
    assert.ok(s.labor_load.zones.length === 3);
  } finally { await api.close(); }
});

test('changes feed: ordered {seq, at, kind, entity, id, fields}, paged by after/limit', async () => {
  const api = await start();
  try {
    assert.deepEqual((await api.get('/v1/changes')).body, { events: [], next_seq: 0, has_more: false });
    await api.act('complete', { idempotency_key: 'c', task_id: 'TK-0001' });
    const all = (await api.get('/v1/changes?after=0&limit=1000')).body;
    assert.ok(all.events.length >= 4);
    all.events.forEach((e, i) => {
      assert.deepEqual(Object.keys(e), ['seq', 'at', 'kind', 'entity', 'id', 'fields']);
      assert.equal(e.seq, i + 1);
      assert.ok(['insert', 'update', 'delete'].includes(e.kind));
    });
    const task = all.events.find((e) => e.entity === 'task');
    assert.deepEqual([task.kind, task.id, task.fields.status], ['update', 'TK-0001', 'done']);
    const page = (await api.get('/v1/changes?after=1&limit=2')).body;
    assert.deepEqual(page.events.map((e) => e.seq), [2, 3]);
    assert.equal(page.next_seq, 3);
    assert.equal(page.has_more, true);
    assert.equal((await api.get('/v1/changes?after=x')).status, 400);
  } finally { await api.close(); }
});

test('applying the feed to a seq-0 snapshot rebuilds the live snapshot', async () => {
  const api = await start();
  try {
    const state = (await api.get('/v1/snapshot')).body;
    const run = async (verb, b) => (await api.act(verb, b));
    await run('complete', { idempotency_key: '1', task_id: 'TK-0001' });
    await run('complete', { idempotency_key: '2', task_id: 'TK-0018' });
    await run('flag', { idempotency_key: '3', entity: 'bin', id: 'ZA-01-01', kind: 'damage', reason: 'Rack bent.' });
    await run('post-receiving', { idempotency_key: '4', asn_id: 'ASN-1003', lines: [{ line: 1, qty: 100 }, { line: 2, qty: 60 }] });
    await run('confirm-load', { idempotency_key: '5', load_id: 'LD-9001' });
    await api.settle();
    const evs = (await api.get('/v1/changes?after=0&limit=1000')).body.events;
    const byEntity = Object.fromEntries(Object.entries(ENTITY).map(([c, e]) => [e, c]));
    for (const e of evs) {
      const coll = byEntity[e.entity];
      const at = state[coll].findIndex((r) => idOf(coll, r) === e.id);
      if (e.kind === 'insert') { assert.equal(at, -1); state[coll].push(e.fields); }
      if (e.kind === 'update') Object.assign(state[coll][at], e.fields);
      if (e.kind === 'delete') state[coll].splice(at, 1);
    }
    const live = (await api.get('/v1/snapshot')).body;
    for (const c of Object.keys(ENTITY)) assert.deepEqual(state[c], live[c], c);
  } finally { await api.close(); }
});

test('flag validates entity, severity and existence', async () => {
  const api = await start();
  try {
    assert.equal((await api.act('flag', { idempotency_key: 'a', entity: 'spaceship', id: 'x', kind: 'k', reason: 'r' })).status, 400);
    assert.equal((await api.act('flag', { idempotency_key: 'b', entity: 'bin', id: 'NOPE', kind: 'k', reason: 'r' })).status, 404);
    assert.equal((await api.act('flag', { idempotency_key: 'c', entity: 'bin', id: 'ZA-01-01', kind: 'k', reason: 'r', severity: 'huge' })).status, 400);
    const ok = await api.act('flag', { idempotency_key: 'd', entity: 'pallet', id: 'PAL-001', kind: 'damage', reason: 'Wet wrap', severity: 'high' });
    assert.equal(ok.status, 200);
    assert.match(ok.body.result.exception_id, /^EX-/);
  } finally { await api.close(); }
});

test('state and idempotency survive a restart when a store file is used', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wms-')), 'state.json');
  const a = await start({ file });
  const first = await a.act('complete', { idempotency_key: 'persist', task_id: 'TK-0001' });
  const seq = (await a.get('/v1/snapshot')).body.as_of_seq;
  await a.close();
  const b = await start({ file });
  try {
    assert.equal((await b.get('/v1/snapshot')).body.as_of_seq, seq);
    const again = await b.act('complete', { idempotency_key: 'persist', task_id: 'TK-0001' });
    assert.deepEqual(again.body, first.body);
    assert.equal((await b.get('/v1/snapshot')).body.as_of_seq, seq);
    await b.post('/v1/admin/reset');
    assert.equal((await b.get('/v1/snapshot')).body.as_of_seq, 0);
  } finally { await b.close(); }
});
