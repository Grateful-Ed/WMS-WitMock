'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildSeed } = require('./seed');

class ApiError extends Error {
  constructor(status, code, reason) {
    super(reason);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}
// A business refusal. Sync acts answer with `status`; async acts store it as the verdict.
class Refusal extends Error {
  constructor(code, reason, status = 409) {
    super(reason);
    this.code = code;
    this.reason = reason;
    this.status = status;
  }
}

// collection name -> entity name used in change events
const ENTITY = {
  items: 'item', zones: 'zone', bins: 'bin', doors: 'door', dock_appointments: 'dock_appointment',
  inventory: 'inventory', pallets: 'pallet', ledger: 'ledger', asns: 'asn', orders: 'order',
  waves: 'wave', deliveries: 'delivery', loads: 'load', tasks: 'task', cycle_counts: 'cycle_count',
  exceptions: 'exception', departments: 'department', workers: 'worker',
};
const COLLECTIONS = Object.keys(ENTITY);
const idOf = (coll, r) => (coll === 'inventory' ? `${r.location_id}:${r.item_id}` : r.id);
const FLAGGABLE = {
  asn: 'asns', order: 'orders', task: 'tasks', bin: 'bins', pallet: 'pallets', load: 'loads',
  delivery: 'deliveries', item: 'items', worker: 'workers', door: 'doors',
};
const SEVERITIES = ['low', 'medium', 'high'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const isId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 64;
const posInt = (n) => Number.isInteger(n) && n > 0;
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const ASYNC_VERBS = new Set(['post-receiving', 'confirm-load']);
const VERBS = ['complete', 'flag', 'post-receiving', 'confirm-load'];

class Wms {
  constructor({ file = null, clock = () => new Date().toISOString(), asyncDelayMs = null, seedFn = buildSeed } = {}) {
    this.file = file;
    this.clock = clock;
    this.asyncDelayMs = asyncDelayMs;
    this.seedFn = seedFn;
    if (file && fs.existsSync(file)) {
      this.s = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const a of this.s.acts) if (a.status === 'sent') this._schedule(a.id);
    } else {
      this.reset();
    }
  }

  reset() {
    const seed = this.seedFn();
    const data = {};
    for (const k of Object.keys(seed)) data[k] = seed[k];
    this.s = { seq: 0, events: [], acts: [], keys: {}, counters: {}, data };
    this._save();
  }

  get d() { return this.s.data; }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.s));
    fs.renameSync(tmp, this.file);
  }

  // ---- change capture ----------------------------------------------------
  _emit(kind, entity, id, fields) {
    this.s.seq += 1;
    this.s.events.push({ seq: this.s.seq, at: this.clock(), kind, entity, id, fields });
  }
  _insert(coll, rec) {
    this.d[coll].push(rec);
    this._emit('insert', ENTITY[coll], idOf(coll, rec), clone(rec));
    return rec;
  }
  _patch(coll, rec, patch) {
    const changed = {};
    for (const [k, v] of Object.entries(patch)) {
      if (canonical(rec[k]) !== canonical(v)) changed[k] = clone(v);
    }
    if (!Object.keys(changed).length) return rec;
    Object.assign(rec, clone(changed));
    this._emit('update', ENTITY[coll], idOf(coll, rec), changed);
    return rec;
  }
  _remove(coll, rec) {
    this.d[coll].splice(this.d[coll].indexOf(rec), 1);
    this._emit('delete', ENTITY[coll], idOf(coll, rec), {});
  }
  _find(coll, id) { return this.d[coll].find((r) => r.id === id); }
  _next(prefix, coll, width) {
    if (this.s.counters[prefix] === undefined) {
      let max = 0;
      for (const r of (this.d[coll] || [])) {
        const n = Number(String(r.id).slice(prefix.length));
        if (String(r.id).startsWith(prefix) && Number.isFinite(n) && n > max) max = n;
      }
      this.s.counters[prefix] = max;
    }
    this.s.counters[prefix] += 1;
    return prefix + String(this.s.counters[prefix]).padStart(width, '0');
  }

  // ---- inventory ---------------------------------------------------------
  _row(loc, item) { return this.d.inventory.find((r) => r.location_id === loc && r.item_id === item); }
  _qty(loc, item) { const r = this._row(loc, item); return r ? r.qty : 0; }
  _change(loc, item, delta) {
    const r = this._row(loc, item);
    if (!r) {
      if (delta < 0) throw new Error(`negative stock at ${loc}/${item}`);
      this._insert('inventory', { location_id: loc, item_id: item, qty: delta });
      return;
    }
    const q = r.qty + delta;
    if (q < 0) throw new Error(`negative stock at ${loc}/${item}`);
    if (q === 0) this._remove('inventory', r);
    else this._patch('inventory', r, { qty: q });
  }
  _move(type, item, from, to, qty, ref) {
    if (from) this._change(from, item, -qty);
    if (to) this._change(to, item, qty);
    const rec = {
      id: this._next('LG-', 'ledger', 6), at: this.clock(), type, item_id: item,
      from_location: from, to_location: to, qty, ref,
    };
    this._insert('ledger', rec);
    return rec.id;
  }
  _raise(kind, entity, entityId, severity, reason, by) {
    const rec = {
      id: this._next('EX-', 'exceptions', 3), kind, entity, entity_id: entityId, severity, reason,
      status: 'open', raised_at: this.clock(), raised_by: by || null,
    };
    this._insert('exceptions', rec);
    return rec.id;
  }

  // ---- reads -------------------------------------------------------------
  laborLoad() {
    const zones = this.d.zones.map((z) => {
      const workers = this.d.workers.filter((w) => w.zone_id === z.id && w.status === 'active').length;
      const open = this.d.tasks.filter((t) => t.zone_id === z.id && t.status === 'open').length;
      return { zone_id: z.id, active_workers: workers, open_tasks: open, tasks_per_worker: workers ? Math.round((open / workers) * 100) / 100 : null };
    });
    const max = zones.reduce((m, z) => ((z.tasks_per_worker || 0) > (m.tasks_per_worker || 0) ? z : m), zones[0]);
    return { zones, most_loaded_zone_id: max.zone_id };
  }
  snapshot() {
    return { as_of_seq: this.s.seq, at: this.clock(), ...clone(this.d), labor_load: this.laborLoad() };
  }
  changes(after = 0, limit = 100) {
    const i = this.s.events.findIndex((e) => e.seq > after);
    const slice = i < 0 ? [] : this.s.events.slice(i, i + limit);
    const last = slice.length ? slice[slice.length - 1].seq : after;
    return { events: clone(slice), next_seq: last, has_more: last < this.s.seq };
  }
  reconcile() {
    const bal = new Map();
    const add = (loc, item, q) => {
      if (!loc) return;
      const k = `${loc}:${item}`;
      bal.set(k, (bal.get(k) || 0) + q);
    };
    for (const l of this.d.ledger) { add(l.from_location, l.item_id, -l.qty); add(l.to_location, l.item_id, l.qty); }
    const onHand = new Map(this.d.inventory.map((r) => [`${r.location_id}:${r.item_id}`, r.qty]));
    const mismatches = [];
    for (const k of new Set([...bal.keys(), ...onHand.keys()])) {
      const a = bal.get(k) || 0;
      const b = onHand.get(k) || 0;
      if (a !== b) { const [location_id, item_id] = k.split(':'); mismatches.push({ location_id, item_id, ledger_qty: a, on_hand_qty: b }); }
    }
    const negative = this.d.inventory.filter((r) => r.qty < 0).map((r) => ({ location_id: r.location_id, item_id: r.item_id, qty: r.qty }));
    const items = this.d.items.map((it) => ({
      item_id: it.id,
      on_hand_qty: this.d.inventory.filter((r) => r.item_id === it.id).reduce((s, r) => s + r.qty, 0),
      ledger_qty: [...bal].filter(([k]) => k.endsWith(`:${it.id}`)).reduce((s, [, q]) => s + q, 0),
    }));
    return { ok: !mismatches.length && !negative.length && items.every((i) => i.on_hand_qty === i.ledger_qty), mismatches, negative, items };
  }
  getAct(id) {
    const a = this.s.acts.find((x) => x.id === id);
    return a ? this._public(a) : null;
  }
  _public(a) {
    return {
      act_id: a.id, verb: a.verb, idempotency_key: a.key, status: a.status,
      reason: a.reason, result: a.result, status_url: `/v1/acts/${a.id}`,
      submitted_at: a.submitted_at, settled_at: a.settled_at,
    };
  }

  // ---- acts --------------------------------------------------------------
  // Returns { status, body, replay }. Throws ApiError for malformed/unknown requests.
  submit(verb, body, headerKey) {
    if (!VERBS.includes(verb)) throw new ApiError(404, 'unknown_act', `Unknown act "${verb}". Use one of: ${VERBS.join(', ')}.`);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'Request body must be a JSON object.');
    const key = body.idempotency_key !== undefined ? body.idempotency_key : headerKey;
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
      throw new ApiError(400, 'missing_idempotency_key', 'Every act needs an idempotency_key (string, 1 to 128 chars) in the body or in the Idempotency-Key header.');
    }
    const payload = { ...body };
    delete payload.idempotency_key;
    const hash = crypto.createHash('sha256').update(verb + canonical(payload)).digest('hex');

    const prior = this.s.keys[key];
    if (prior) {
      const act = this.s.acts.find((a) => a.id === prior);
      if (act.verb !== verb || act.hash !== hash) {
        throw new ApiError(422, 'idempotency_key_reuse', `Idempotency key "${key}" was already used for a different request (${act.id}). Use a new key for a new request.`);
      }
      return { ...this._respond(act), replay: true };
    }

    this._validate(verb, payload); // throws ApiError, key not consumed

    const act = {
      id: this._next('ACT-', 'acts_virtual', 6), key, verb, hash, payload,
      mode: ASYNC_VERBS.has(verb) ? 'async' : 'sync', status: 'sent', reason: null, result: null,
      http_status: null, error_code: null, submitted_at: this.clock(), settled_at: null,
    };
    this.s.acts.push(act);
    this.s.keys[key] = act.id;
    if (act.mode === 'sync') this._settle(act);
    else this._schedule(act.id);
    this._save();
    return { ...this._respond(act), replay: false };
  }

  _respond(act) {
    if (act.mode === 'sync') {
      if (act.status === 'landed') return { status: 200, body: this._public(act) };
      return { status: act.http_status, body: { error: { code: act.error_code, reason: act.reason, act_id: act.id } } };
    }
    return { status: act.status === 'sent' ? 202 : 200, body: this._public(act) };
  }

  _schedule(id) {
    if (this.asyncDelayMs === null || this.asyncDelayMs === undefined) return;
    const timer = setTimeout(() => this.settle(id), this.asyncDelayMs);
    if (timer.unref) timer.unref();
  }

  // Settle one pending async act, or all of them in submit order.
  settle(id) {
    const done = [];
    for (const act of this.s.acts) {
      if (act.status !== 'sent' || (id && act.id !== id)) continue;
      this._settle(act);
      done.push(act.id);
    }
    if (done.length) this._save();
    return done;
  }

  _settle(act) {
    try {
      const result = this._apply(act.verb, act.payload);
      act.status = 'landed';
      act.result = result;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      act.status = 'refused';
      act.reason = e.reason;
      act.error_code = e.code;
      act.http_status = e.status;
    }
    act.settled_at = this.clock();
  }

  // ---- validation (shape and existence only; rule checks are refusals) ---
  _validate(verb, b) {
    const bad = (m) => { throw new ApiError(400, 'invalid_request', m); };
    if (verb === 'complete') {
      if (!isId(b.task_id)) bad('task_id is required (string).');
      const task = this._find('tasks', b.task_id);
      if (!task) throw new ApiError(404, 'not_found', `Task ${b.task_id} does not exist.`);
      if (b.worker_id !== undefined && b.worker_id !== null) {
        if (!isId(b.worker_id)) bad('worker_id must be a string.');
        if (!this._find('workers', b.worker_id)) throw new ApiError(404, 'not_found', `Worker ${b.worker_id} does not exist.`);
      }
      if (task.type === 'count') {
        if (!Number.isInteger(b.counted_qty) || b.counted_qty < 0) bad('counted_qty is required for count tasks (integer, 0 or more).');
      } else if (b.counted_qty !== undefined) bad('counted_qty is only allowed for count tasks.');
    } else if (verb === 'flag') {
      if (!FLAGGABLE[b.entity]) bad(`entity must be one of: ${Object.keys(FLAGGABLE).join(', ')}.`);
      if (!isId(b.id)) bad('id is required (string).');
      if (!isId(b.kind)) bad('kind is required (string, for example damage, shortage, overage, quality_hold).');
      if (typeof b.reason !== 'string' || !b.reason.trim()) bad('reason is required (non-empty string).');
      if (b.severity !== undefined && !SEVERITIES.includes(b.severity)) bad(`severity must be one of: ${SEVERITIES.join(', ')}.`);
      if (b.worker_id !== undefined && b.worker_id !== null && !this._find('workers', b.worker_id)) throw new ApiError(404, 'not_found', `Worker ${b.worker_id} does not exist.`);
      if (!this._find(FLAGGABLE[b.entity], b.id)) throw new ApiError(404, 'not_found', `${b.entity} ${b.id} does not exist.`);
    } else if (verb === 'post-receiving') {
      if (!isId(b.asn_id)) bad('asn_id is required (string).');
      if (!Array.isArray(b.lines) || !b.lines.length) bad('lines is required (non-empty array of {line, qty}).');
      const seen = new Set();
      for (const l of b.lines) {
        if (!l || !posInt(l.line) || !posInt(l.qty)) bad('Each line needs line (integer 1 or more) and qty (integer 1 or more).');
        if (seen.has(l.line)) bad(`Line ${l.line} appears twice.`);
        seen.add(l.line);
      }
    } else if (verb === 'confirm-load') {
      if (!isId(b.load_id)) bad('load_id is required (string).');
      if (b.delivery_ids !== undefined && (!Array.isArray(b.delivery_ids) || !b.delivery_ids.every(isId))) bad('delivery_ids must be an array of strings.');
      if (b.seal_no !== undefined && b.seal_no !== null && typeof b.seal_no !== 'string') bad('seal_no must be a string.');
    }
  }

  _apply(verb, b) {
    if (verb === 'complete') return this._complete(b);
    if (verb === 'flag') return this._flag(b);
    if (verb === 'post-receiving') return this._postReceiving(b);
    return this._confirmLoad(b);
  }

  // ---- complete ----------------------------------------------------------
  _complete(b) {
    const task = this._find('tasks', b.task_id);
    if (task.status !== 'open') throw new Refusal('task_not_open', `Task ${task.id} is already ${task.status}.`);
    const by = b.worker_id || task.assigned_to || null;
    const ref = task.id;
    let result;
    if (task.type === 'putaway') {
      const pallet = this._find('pallets', task.pallet_id);
      const rows = this.d.inventory.filter((r) => r.location_id === pallet.id);
      const binTotal = this.d.inventory.filter((r) => r.location_id === task.to_bin).reduce((s, r) => s + r.qty, 0);
      const incoming = rows.reduce((s, r) => s + r.qty, 0);
      const bin = this._find('bins', task.to_bin);
      if (bin.status !== 'active') throw new Refusal('bin_not_active', `Bin ${bin.id} is ${bin.status}.`);
      if (binTotal + incoming > bin.capacity) throw new Refusal('bin_over_capacity', `Bin ${bin.id} holds ${binTotal} of ${bin.capacity}. Pallet ${pallet.id} adds ${incoming}.`);
      for (const r of [...rows]) this._move('putaway', r.item_id, pallet.id, task.to_bin, r.qty, ref);
      this._patch('pallets', pallet, { status: 'put_away' });
      result = { task_id: task.id, type: 'putaway', pallet_id: pallet.id, to_bin: task.to_bin, qty: incoming };
    } else if (task.type === 'pick') {
      const have = this._qty(task.from_bin, task.item_id);
      if (have < task.qty) throw new Refusal('insufficient_stock', `Bin ${task.from_bin} has ${have} of ${task.item_id}. The pick needs ${task.qty}.`);
      this._move('pick', task.item_id, task.from_bin, task.to_location, task.qty, ref);
      const order = this._find('orders', task.order_id);
      const lines = order.lines.map((l) => (l.line === task.line ? { ...l, picked_qty: l.picked_qty + task.qty } : l));
      this._patch('orders', order, { lines });
      result = { task_id: task.id, type: 'pick', order_id: order.id, qty: task.qty, from_bin: task.from_bin, to_location: task.to_location };
      if (order.lines.every((l) => l.picked_qty >= l.qty)) {
        this._patch('orders', order, { status: 'picked' });
        const packId = this._next('TK-', 'tasks', 4);
        this._insert('tasks', {
          id: packId, type: 'pack', status: 'open', zone_id: null, assigned_to: null, order_id: order.id,
          from_location: task.to_location, created_at: this.clock(), completed_at: null, completed_by: null,
        });
        result.pack_task_id = packId;
        const wave = order.wave_id && this._find('waves', order.wave_id);
        if (wave && wave.order_ids.every((id) => ['picked', 'packed', 'shipped'].includes(this._find('orders', id).status))) {
          this._patch('waves', wave, { status: 'picked' });
        }
      }
    } else if (task.type === 'pack') {
      const order = this._find('orders', task.order_id);
      const rows = this.d.inventory.filter((r) => r.location_id === task.from_location);
      const palletId = this._next('PAL-', 'pallets', 3);
      const delId = this._next('OD-', 'deliveries', 4);
      this._insert('pallets', { id: palletId, direction: 'outbound', lane: 'STG-OUT', status: 'staged_for_load', asn_id: null, asn_line: null, delivery_id: delId });
      for (const r of [...rows]) this._move('pack', r.item_id, task.from_location, palletId, r.qty, ref);
      this._insert('deliveries', { id: delId, order_id: order.id, status: 'packed', load_id: null, pallet_ids: [palletId], shipped_at: null });
      this._patch('orders', order, { status: 'packed', delivery_id: delId });
      result = { task_id: task.id, type: 'pack', order_id: order.id, delivery_id: delId, pallet_id: palletId };
    } else if (task.type === 'count') {
      const cc = this._find('cycle_counts', task.cycle_count_id);
      const system = this._qty(task.bin_id, task.item_id);
      const variance = b.counted_qty - system;
      if (variance > 0) this._move('adjust', task.item_id, null, task.bin_id, variance, ref);
      if (variance < 0) this._move('adjust', task.item_id, task.bin_id, null, -variance, ref);
      this._patch('cycle_counts', cc, { status: variance ? 'adjusted' : 'counted', system_qty: system, counted_qty: b.counted_qty, variance });
      result = { task_id: task.id, type: 'count', cycle_count_id: cc.id, system_qty: system, counted_qty: b.counted_qty, variance };
      if (variance) result.exception_id = this._raise('count_variance', 'cycle_count', cc.id, 'medium', `Counted ${b.counted_qty}, system had ${system}. Stock adjusted by ${variance}.`, by);
    }
    this._patch('tasks', task, { status: 'done', completed_at: this.clock(), completed_by: by });
    return result;
  }

  // ---- flag --------------------------------------------------------------
  _flag(b) {
    const id = this._raise(b.kind, b.entity, b.id, b.severity || 'medium', b.reason, b.worker_id);
    return { exception_id: id };
  }

  // ---- post-receiving (async) -------------------------------------------
  _postReceiving(b) {
    const asn = this._find('asns', b.asn_id);
    if (!asn) throw new Refusal('unknown_asn', `ASN ${b.asn_id} does not exist.`);
    if (!['arrived', 'receiving'].includes(asn.status)) {
      const why = asn.status === 'scheduled' ? 'The truck has not arrived.' : `The ASN is ${asn.status}.`;
      throw new Refusal('asn_not_receivable', `ASN ${asn.id} cannot be received. ${why}`);
    }
    if (b.worker_id && !this._find('workers', b.worker_id)) throw new Refusal('unknown_worker', `Worker ${b.worker_id} does not exist.`);
    for (const l of b.lines) {
      const line = asn.lines.find((x) => x.line === l.line);
      if (!line) throw new Refusal('unknown_line', `ASN ${asn.id} has no line ${l.line}.`);
      if (line.received_qty + l.qty > line.expected_qty) {
        throw new Refusal('over_receipt', `Line ${l.line} (${line.item_id}) expects ${line.expected_qty} and already has ${line.received_qty}. Receiving ${l.qty} more is too many.`);
      }
    }
    const lane = `STG-${asn.door_id}`;
    const lines = asn.lines.map((x) => ({ ...x }));
    const pallets = [];
    for (const l of b.lines) {
      const line = lines.find((x) => x.line === l.line);
      const item = this._find('items', line.item_id);
      const palletId = this._next('PAL-', 'pallets', 3);
      this._insert('pallets', { id: palletId, direction: 'inbound', lane, status: 'putaway_pending', asn_id: asn.id, asn_line: line.line, delivery_id: null });
      this._move('receive', line.item_id, null, palletId, l.qty, asn.id);
      line.received_qty += l.qty;
      const taskId = this._next('TK-', 'tasks', 4);
      this._insert('tasks', {
        id: taskId, type: 'putaway', status: 'open', zone_id: item.putaway_bin.slice(0, 2), assigned_to: null,
        pallet_id: palletId, item_id: line.item_id, qty: l.qty, from_location: palletId, to_bin: item.putaway_bin,
        created_at: this.clock(), completed_at: null, completed_by: null,
      });
      pallets.push({ pallet_id: palletId, line: line.line, item_id: line.item_id, qty: l.qty, putaway_task_id: taskId });
    }
    const full = lines.every((x) => x.received_qty >= x.expected_qty);
    this._patch('asns', asn, { lines, status: full ? 'received' : 'receiving' });
    if (full) {
      const door = this._find('doors', asn.door_id);
      this._patch('doors', door, { status: 'free', current_ref: null });
      this._patch('dock_appointments', this._find('dock_appointments', asn.appointment_id), { status: 'completed' });
    }
    return { asn_id: asn.id, asn_status: full ? 'received' : 'receiving', pallets };
  }

  // ---- confirm-load (async) ---------------------------------------------
  _confirmLoad(b) {
    const load = this._find('loads', b.load_id);
    if (!load) throw new Refusal('unknown_load', `Load ${b.load_id} does not exist.`);
    if (load.status === 'shipped') throw new Refusal('load_already_shipped', `Load ${load.id} already shipped.`);
    const door = this._find('doors', load.door_id);
    if (door.direction !== 'outbound') throw new Refusal('wrong_door', `Door ${door.id} is not an outbound door.`);
    const requested = b.delivery_ids || [];
    for (const id of requested) {
      const del = this._find('deliveries', id);
      if (!del) throw new Refusal('unknown_delivery', `Delivery ${id} does not exist.`);
      if (del.load_id && del.load_id !== load.id) throw new Refusal('delivery_on_other_load', `Delivery ${id} is already on load ${del.load_id}.`);
    }
    const all = [...new Set([...load.delivery_ids, ...requested])];
    if (!all.length) throw new Refusal('empty_load', `Load ${load.id} has no deliveries.`);
    for (const id of all) {
      const del = this._find('deliveries', id);
      if (del.status !== 'packed') throw new Refusal('delivery_not_packed', `Delivery ${id} is ${del.status}, not packed.`);
    }
    let units = 0;
    let palletCount = 0;
    for (const id of all) {
      const del = this._find('deliveries', id);
      for (const pid of del.pallet_ids) {
        const pallet = this._find('pallets', pid);
        for (const r of [...this.d.inventory.filter((x) => x.location_id === pid)]) {
          this._move('ship', r.item_id, pid, null, r.qty, load.id);
          units += r.qty;
        }
        this._patch('pallets', pallet, { status: 'shipped' });
        palletCount += 1;
      }
      this._patch('deliveries', del, { status: 'shipped', load_id: load.id, shipped_at: this.clock() });
      this._patch('orders', this._find('orders', del.order_id), { status: 'shipped' });
    }
    this._patch('loads', load, { status: 'shipped', delivery_ids: all, seal_no: b.seal_no || null, shipped_at: this.clock() });
    this._patch('doors', door, { status: 'free', current_ref: null });
    this._patch('dock_appointments', this._find('dock_appointments', load.appointment_id), { status: 'completed' });
    return { load_id: load.id, delivery_ids: all, pallets_shipped: palletCount, units_shipped: units };
  }
}

module.exports = { Wms, ApiError, Refusal, ENTITY, COLLECTIONS, idOf, VERBS };
