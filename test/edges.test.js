'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Wms } = require('../src/wms');
const { start } = require('./helpers');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wms-edge-')), 'state.json');
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. settle never wedges or crashes ----------------------------------

test('settle: an unexpected error is refused as internal_error and rolled back', async () => {
  const file = tmpFile();
  const api = await start({ file });
  try {
    api.wms.warn = quiet;
    const real = api.wms._apply.bind(api.wms);
    // Mutate first, then throw: the worst case for a half-applied act.
    api.wms._apply = (verb, b) => { real(verb, b); throw new TypeError('boom'); };
    const before = JSON.stringify(api.wms.s.data);
    const seq = api.wms.s.seq;
    const r = await api.act('post-receiving', { idempotency_key: 'wedge', asn_id: 'ASN-1004', lines: [{ line: 1, qty: 10 }] });
    assert.equal(r.status, 202);
    await api.settle();
    const v = (await api.get(r.body.status_url)).body;
    assert.equal(v.status, 'refused');
    assert.equal(v.result, null);
    assert.ok(v.settled_at);
    assert.match(v.reason, /internal error/);
    assert.equal(JSON.stringify(api.wms.s.data), before, 'state rolled back');
    assert.equal(api.wms.s.seq, seq, 'no events left behind');
    assert.equal(api.wms.reconcile().ok, true);
    // replay is well formed and the key stays spent
    const again = await api.act('post-receiving', { idempotency_key: 'wedge', asn_id: 'ASN-1004', lines: [{ line: 1, qty: 10 }] });
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'refused');
    // server still alive
    assert.equal((await api.get('/v1/snapshot')).status, 200);

    // a sync act that throws answers 500 internal_error, and replays the same way
    const s1 = await api.act('complete', { idempotency_key: 'sync-wedge', task_id: 'TK-0001' });
    assert.equal(s1.status, 500);
    assert.equal(s1.body.error.code, 'internal_error');
    assert.ok(s1.body.error.act_id);
    assert.equal(api.wms.s.seq, seq);
    const s2 = await api.act('complete', { idempotency_key: 'sync-wedge', task_id: 'TK-0001' });
    assert.deepEqual(s2.body, s1.body);

    // restart on the settled state: nothing is pending, nothing loops
    const w2 = new Wms({ file, asyncDelayMs: 10, warn: quiet });
    assert.equal(w2.s.acts.filter((a) => a.status === 'sent').length, 0);
    await sleep(40);
    assert.equal(w2.getAct(r.body.act_id).status, 'refused');
  } finally { await api.close(); }
});

test('settle: a throw on the timer path does not kill the process, and a restart does not loop', async () => {
  const file = tmpFile();
  const w = new Wms({ file, asyncDelayMs: 15, warn: quiet });
  w._apply = () => { throw new Error('timer boom'); };
  const out = w.submit('confirm-load', { idempotency_key: 'tm', load_id: 'LD-9002' });
  await sleep(80); // an uncaught exception here would fail the whole test run
  assert.equal(w.getAct(out.body.act_id).status, 'refused');
  assert.equal(w.getAct(out.body.act_id).reason.includes('internal error'), true);
  const w2 = new Wms({ file, asyncDelayMs: 15, warn: quiet });
  await sleep(50);
  assert.equal(w2.getAct(out.body.act_id).status, 'refused');
});

test('dangling references refuse cleanly: dock appointment in post-receiving', async () => {
  const api = await start();
  try {
    api.wms.d.dock_appointments.splice(api.wms.d.dock_appointments.findIndex((a) => a.id === 'APT-104'), 1);
    const seq = api.wms.s.seq;
    const r = await api.act('post-receiving', { idempotency_key: 'd1', asn_id: 'ASN-1004', lines: [{ line: 1, qty: 60 }, { line: 2, qty: 48 }] });
    await api.settle();
    const v = (await api.get(r.body.status_url)).body;
    assert.equal(v.status, 'refused');
    assert.match(v.reason, /Dock appointment APT-104 does not exist/);
    assert.equal(api.wms.s.seq, seq, 'partial receipt rolled back');
    assert.equal(api.wms.s.acts.length, 1);
  } finally { await api.close(); }
});

test('dangling references refuse cleanly: dock appointment in confirm-load', async () => {
  const api = await start();
  try {
    api.wms.d.dock_appointments.splice(api.wms.d.dock_appointments.findIndex((a) => a.id === 'APT-201'), 1);
    const seq = api.wms.s.seq;
    const r = await api.act('confirm-load', { idempotency_key: 'd2', load_id: 'LD-9001' });
    await api.settle();
    const v = (await api.get(r.body.status_url)).body;
    assert.equal(v.status, 'refused');
    assert.match(v.reason, /Dock appointment APT-201 does not exist/);
    assert.equal(api.wms.s.seq, seq, 'shipped stock rolled back');
    assert.equal(api.wms.reconcile().ok, true);
  } finally { await api.close(); }
});

test('dangling references refuse cleanly: pallet in putaway completion', async () => {
  const api = await start();
  try {
    api.wms.d.pallets.splice(api.wms.d.pallets.findIndex((p) => p.id === 'PAL-001'), 1);
    const r = await api.act('complete', { idempotency_key: 'd3', task_id: 'TK-0018' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'dangling_reference');
    assert.match(r.body.error.reason, /Pallet PAL-001/);
    assert.equal(api.wms.d.tasks.find((t) => t.id === 'TK-0018').status, 'open');
  } finally { await api.close(); }
});

test('dangling references refuse cleanly: cycle count in count completion', async () => {
  const api = await start();
  try {
    const task = api.wms.d.tasks.find((t) => t.type === 'count');
    const seq = api.wms.s.seq;
    api.wms.d.cycle_counts.splice(api.wms.d.cycle_counts.findIndex((c) => c.id === task.cycle_count_id), 1);
    const r = await api.act('complete', { idempotency_key: 'd4', task_id: task.id, counted_qty: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'dangling_reference');
    assert.match(r.body.error.reason, /Cycle count/);
    assert.equal(api.wms.s.seq, seq, 'stock adjustment rolled back');
    assert.equal(api.wms.d.tasks.find((t) => t.id === task.id).status, 'open');
  } finally { await api.close(); }
});

// ---- 2. 413 arrives ------------------------------------------------------

test('a body over 1 MB gets HTTP 413 body_too_large, not a connection reset', async () => {
  const api = await start();
  try {
    const big = JSON.stringify({ idempotency_key: 'big', task_id: 'TK-0001', pad: 'x'.repeat(2_000_000) });
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${api.base}/v1/acts/complete`, { method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' }, body: big });
      assert.equal(res.status, 413);
      assert.equal((await res.json()).error.code, 'body_too_large');
    }
    // same through raw http, with the body written in chunks
    const code = await new Promise((resolve, reject) => {
      const req = http.request(`${api.base}/v1/acts/complete`, { method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' } }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, t }));
      });
      req.on('error', reject);
      for (let i = 0; i < 30; i++) req.write('y'.repeat(100_000));
      req.end();
    });
    assert.equal(code.status, 413);
    assert.match(code.t, /body_too_large/);
    assert.equal((await api.get('/v1/snapshot')).status, 200, 'server still serving');
  } finally { await api.close(); }
});

// ---- 3. reset cancels timers --------------------------------------------

test('reset cancels pending verdict timers', async () => {
  const w = new Wms({ asyncDelayMs: 100, warn: quiet });
  const a = w.submit('confirm-load', { idempotency_key: 'a', load_id: 'LD-9001' });
  assert.equal(a.body.act_id, 'ACT-000001');
  w.reset();
  assert.equal(w.timers.size, 0);
  await sleep(60);
  const b = w.submit('confirm-load', { idempotency_key: 'b', load_id: 'LD-9002' });
  assert.equal(b.body.act_id, 'ACT-000001', 'ids restart after a reset');
  await sleep(70); // the dead act's timer would have fired by now
  assert.equal(w.getAct('ACT-000001').status, 'sent', 'new act untouched until its own verdict');
  await sleep(120);
  assert.equal(w.getAct('ACT-000001').status, 'landed');
});

// ---- 4. cursor safety and generation ------------------------------------

test('changes: next_seq never passes the server seq', async () => {
  const api = await start();
  try {
    await api.act('complete', { idempotency_key: 'c1', task_id: 'TK-0001' });
    const seq = (await api.get('/v1/snapshot')).body.as_of_seq;
    assert.ok(seq > 0);
    const r = (await api.get('/v1/changes?after=999999')).body;
    assert.deepEqual(r.events, []);
    assert.equal(r.next_seq, seq);
    assert.equal(r.has_more, false);
    // a consumer that used that cursor still sees the next event
    await api.act('complete', { idempotency_key: 'c2', task_id: 'TK-0002' });
    const later = (await api.get(`/v1/changes?after=${r.next_seq}`)).body;
    assert.ok(later.events.length > 0);
    // in range cursors are unchanged
    assert.equal((await api.get(`/v1/changes?after=${seq}&limit=1`)).body.next_seq, seq + 1);
  } finally { await api.close(); }
});

test('generation: a consumer detects a reset and resyncs', async () => {
  const api = await start();
  try {
    // consumer following the documented pattern
    const consumer = { gen: null, cursor: 0, resyncs: 0, view: null };
    const sync = async () => {
      const snap = (await api.get('/v1/snapshot')).body;
      consumer.gen = snap.generation; consumer.cursor = snap.as_of_seq; consumer.view = snap; consumer.resyncs += 1;
    };
    const poll = async () => {
      const r = (await api.get(`/v1/changes?after=${consumer.cursor}`)).body;
      if (r.generation !== consumer.gen) return sync();
      consumer.cursor = r.next_seq;
    };
    await sync();
    assert.equal(consumer.gen, 1);
    await api.act('complete', { idempotency_key: 'g1', task_id: 'TK-0001' });
    await poll();
    assert.equal(consumer.resyncs, 1);
    assert.ok(consumer.cursor > 0);

    await api.post('/v1/admin/reset');
    await api.act('complete', { idempotency_key: 'g2', task_id: 'TK-0001' }); // history differs from the old world
    await poll();
    assert.equal(consumer.resyncs, 2, 'generation change caused a resync');
    assert.equal(consumer.gen, 2);
    const live = (await api.get('/v1/snapshot')).body;
    assert.equal(consumer.cursor, live.as_of_seq);
    assert.equal(live.generation, 2);
    assert.equal((await api.get('/v1/changes')).body.generation, 2);
  } finally { await api.close(); }
});

test('generation survives a restart and counts up through resets', () => {
  const file = tmpFile();
  const a = new Wms({ file });
  assert.equal(a.snapshot().generation, 1);
  a.reset(); a.reset();
  assert.equal(new Wms({ file }).snapshot().generation, 3);
});

// ---- 5. corrupt state file ----------------------------------------------

test('a truncated state file does not brick startup: bad file is kept, seed is used', () => {
  const file = tmpFile();
  const good = new Wms({ file });
  good.reset();
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
  const warnings = [];
  const w = new Wms({ file, warn: (m) => warnings.push(m) });
  assert.equal(w.s.seq, 0);
  assert.equal(w.snapshot().generation, 3, 'generation still moves forward when it can be read from the bad file');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /corrupt/);
  const kept = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), text.slice(0, Math.floor(text.length / 2)));
  // the new file is good
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('a state file with the wrong shape is quarantined too', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"hello":"world"}');
  const w = new Wms({ file, warn: quiet });
  assert.equal(w.s.seq, 0);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-')).length, 1);
});

// ---- 7. single-source dedupe (behavior unchanged) -----------------------

test('auth and verbs behave the same on every route', async () => {
  const api = await start();
  try {
    const noKey = (m, p, b) => fetch(api.base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b });
    assert.equal((await noKey('POST', '/v1/acts/flag', '{}')).status, 401);
    assert.equal((await noKey('GET', '/v1/snapshot')).status, 401);
    const bearer = await fetch(`${api.base}/v1/snapshot`, { headers: { authorization: 'Bearer test-key' } });
    assert.equal(bearer.status, 200);
    for (const v of ['complete', 'flag', 'post-receiving', 'confirm-load']) {
      assert.equal((await api.act(v, {})).status, 400, v);
    }
    const unk = await api.act('teleport', {});
    assert.equal(unk.status, 404);
    assert.equal(unk.body.error.code, 'unknown_act');
    assert.match(unk.body.error.reason, /complete, flag, post-receiving, confirm-load/);
    assert.equal((await api.get('/v1/acts/complete')).status, 405);
  } finally { await api.close(); }
});
