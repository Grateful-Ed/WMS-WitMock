# WMS-WitMock

A standalone, generic, modern warehouse management system (SAP EWM / Manhattan Active class), built as a **mock host system for testing**. An integration layer connects to it through the REST/JSON API below. It has no AI, no voice, and no concepts from any other system.

- Node 20+ (tested on 22). **No dependencies.** Plain `node:http`.
- Store: one JSON file (`var/state.json`), written after every change. In-memory when no file is set.
- Tests: `npm test`. Start: `npm start`. Re-export seed: `npm run seed:export`. Check seed file: `npm run seed:check`.

## Run

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `WMS_API_KEY` | `wms-dev-key` | The API key |
| `WMS_DATA_FILE` | `var/state.json` | Store file. Delete it to start from the seed. |
| `WMS_ASYNC_DELAY_MS` | `1500` | Time before an async act gets its verdict. `manual` = only when `POST /v1/admin/settle` is called. |

## The seeded warehouse

One deterministic warehouse, `WH-01`. The seed code is `src/seed.js`. It uses no randomness and no clock. The same seed is exported to **`data/seed.json`**, which is the canonical dataset. A test fails if the two ever differ, so a seed change and a dataset change land in the same commit.

- 12 dock doors: `D01`–`D06` inbound, `D07`–`D12` outbound.
- 3 zones (`ZA` Reserve, `ZB` Forward Pick, `ZC` Overflow and Returns). 10 bins each, 30 total. Bin ids look like `ZA-01-02`.
- 8 staging pallets: `PAL-001`–`PAL-003` inbound (waiting for putaway), `PAL-004`–`PAL-008` outbound (packed, waiting to ship).
- 12 items (`SKU-1001`–`SKU-1012`). Inventory by bin and by pallet.
- Inbound: 5 ASNs (2 scheduled, 1 arrived, 1 receiving, 1 received) with dock appointments.
- Outbound: 10 orders, 2 waves, 3 packed deliveries, 2 loads. Wave `WV-301` is released with 17 open pick tasks.
- 22 open tasks, 2 cycle counts, 2 open exceptions.
- Labor: 6 departments, 17 workers. Zone `ZB` is the deliberately overloaded zone: 14 open tasks, 2 workers. `labor_overload.zone_id` in the dataset names it.

Pseudo-locations: stock being picked sits at `PK-<order id>` (for example `PK-SO-5001`) until it is packed onto a pallet.

## API contract

Base path `/v1`. All bodies are JSON. Time values are ISO 8601 UTC strings.

**Auth.** Send the key as `X-API-Key: <key>` (or `Authorization: Bearer <key>`). `GET /health` needs no key.

### Error shape

Every error is JSON with a human-readable reason:

```json
{ "error": { "code": "over_receipt", "reason": "Line 1 (SKU-1003) expects 120 and already has 60. Receiving 61 more is too many." } }
```

`code` is stable and for machines. `reason` is for people. Sync act refusals also carry `error.act_id`.

| HTTP | When |
|---|---|
| 400 | Bad JSON, missing field, wrong type, missing idempotency key (`invalid_json`, `invalid_request`, `missing_idempotency_key`) |
| 401 | Missing or wrong API key (`unauthorized`) |
| 404 | Unknown route, unknown act verb, or (sync acts) unknown task/entity (`not_found`, `unknown_act`) |
| 405 | Wrong HTTP method |
| 409 | Sync act refused by a business rule (`task_not_open`, `insufficient_stock`, `bin_over_capacity`, ...) |
| 413 | Body over 1 MB |
| 422 | Idempotency key reused with a different request (`idempotency_key_reuse`) |

### Reads

| Request | Answer |
|---|---|
| `GET /v1/snapshot` | The full warehouse. Top-level keys: `as_of_seq`, `at`, `warehouse`, `labor_overload`, `labor_load`, and one array per collection: `items zones bins doors dock_appointments inventory pallets ledger asns orders waves deliveries loads tasks cycle_counts exceptions departments workers`. At seq 0 the data equals `data/seed.json`. |
| `GET /v1/changes?after=<seq>&limit=<n>` | `{ "events": [...], "next_seq": 12, "has_more": false }`. `after` default 0. `limit` default 100, max 1000. |
| `GET /v1/acts/{act_id}` | The act object (see below). |
| `GET /v1/reconcile` | Quantity check: `{ ok, mismatches[], negative[], items[{item_id,on_hand_qty,ledger_qty}] }`. `ok` is true when on-hand stock equals the ledger replay for every location and item. |

**Sync pattern:** read the snapshot, remember `as_of_seq`, then read `/v1/changes?after=<as_of_seq>`.

### Event shape (change feed)

```json
{ "seq": 7, "at": "2026-02-01T10:00:03.120Z", "kind": "update", "entity": "task", "id": "TK-0001", "fields": { "status": "done", "completed_at": "...", "completed_by": "W-09" } }
```

- `seq`: whole number. Starts at 1. No gaps. Strictly increasing.
- `kind`: `insert` (fields = the whole record), `update` (fields = only the changed fields), or `delete` (fields = `{}`).
- `entity`: one of `item zone bin door dock_appointment inventory pallet ledger asn order wave delivery load task cycle_count exception department worker`.
- `id`: the record id. For `inventory` the id is `<location_id>:<item_id>`, for example `ZB-01-01:SKU-1001`. A row is deleted when its quantity reaches 0.
- Applying every event, in order, to the seq-0 snapshot gives the current snapshot (tested).

### Acts

`POST /v1/acts/{verb}` with verb `complete`, `flag`, `post-receiving`, or `confirm-load`.

**Idempotency key.** Every act needs `idempotency_key` (string, 1–128 chars) in the body. The `Idempotency-Key` header also works.

- Same key, same request: you get the original outcome. No second effect, no new events. Replies carry the header `Idempotent-Replay: true`.
- Same key, different request: `422 idempotency_key_reuse`.
- A request that fails validation (400) or targets something unknown on a sync act (404) does not use up the key.

**Act object** (the body of a landed sync act, a 202, and `GET /v1/acts/{id}`):

```json
{ "act_id": "ACT-000001", "verb": "confirm-load", "idempotency_key": "s1",
  "status": "sent | landed | refused", "reason": null, "result": null,
  "status_url": "/v1/acts/ACT-000001", "submitted_at": "...", "settled_at": null }
```

`reason` is set when `status` is `refused`. `result` is set when `status` is `landed`.

#### `complete` (sync, `200`)

Completes a task. Body: `{ idempotency_key, task_id, worker_id?, counted_qty? }`.

| Task type | Effect |
|---|---|
| `putaway` | Moves the pallet's stock to `to_bin`. Pallet becomes `put_away`. Refused if the bin would go over capacity. |
| `pick` | Moves stock from `from_bin` to `PK-<order>`. Adds to the order line's `picked_qty`. When the last line is picked, the order becomes `picked` and a `pack` task is created. Refused if the bin is short. |
| `pack` | Creates an outbound pallet and a delivery (`packed`). Moves stock from `PK-<order>` to the pallet. Order becomes `packed`. |
| `count` | `counted_qty` is required. Adjusts stock to the count. If it differs, a `count_variance` exception is raised. |

Result examples: `{ "task_id": "TK-0001", "type": "pick", "order_id": "SO-5001", "qty": 12, ... }`. A task that is not `open` is refused: `409 task_not_open`.

#### `flag` (sync, `200`)

Raises an OS&D / exception flag. Body: `{ idempotency_key, entity, id, kind, reason, severity?, worker_id? }`.

- `entity`: `asn order task bin pallet load delivery item worker door`. The record must exist (else 404).
- `kind`: free text, for example `damage`, `shortage`, `overage`, `quality_hold`, `location_blocked`.
- `severity`: `low`, `medium` (default), or `high`.
- Result: `{ "exception_id": "EX-003" }`. A new row appears in `exceptions`.

#### `post-receiving` (async, `202`)

Receives goods against an ASN. Body: `{ idempotency_key, asn_id, lines: [{ line, qty }], worker_id? }`. Answers `202` with the act object (`status: "sent"`). **Nothing changes until the verdict.**

- Landed: one inbound pallet and one putaway task per line. The ASN becomes `receiving`, or `received` when every line is full (the door is freed). Result: `{ asn_id, asn_status, pallets: [{ pallet_id, line, item_id, qty, putaway_task_id }] }`.
- Refused (with `reason`): unknown ASN, ASN not `arrived`/`receiving`, unknown line, or **over-receipt** (received would exceed expected). A refused act changes nothing.

#### `confirm-load` (async, `202`)

Ships a load. Body: `{ idempotency_key, load_id, delivery_ids?, seal_no? }`. `delivery_ids` adds packed, unassigned deliveries to the load first. Answers `202`.

- Landed: pallet stock leaves the warehouse (ledger type `ship`). Deliveries and orders become `shipped`. The load becomes `shipped`. The door is freed. Result: `{ load_id, delivery_ids, pallets_shipped, units_shipped }`.
- Refused (with `reason`): unknown load, load already shipped, a delivery that does not exist or is on another load, a delivery that is not `packed`, or a load with no deliveries.

**Verdict.** Poll `status_url`. `sent` → `landed` or `refused`. The verdict arrives after `WMS_ASYNC_DELAY_MS`. Repeating a request with the same key while `sent` returns `202`. After the verdict it returns `200` with the settled act.

### Mock control (not part of the integration surface)

| Request | Use |
|---|---|
| `POST /v1/admin/settle` | Give every pending async act its verdict now. Answer: `{ "settled": ["ACT-000001"] }`. |
| `POST /v1/admin/reset` | Reload the seed. Clears events, acts, and keys. |

## Layout

```
src/seed.js        deterministic seed
src/wms.js         store, change feed, acts, reconciliation
src/server.js      HTTP server and routes
data/seed.json     canonical dataset (generated from src/seed.js)
scripts/           seed export and check
test/              node:test suites
```

## Tests

`npm test` runs 31 tests: seed determinism and dataset integrity (9), quantity reconciliation (3), idempotent replay (7), the async verdict arc (6), and API surface, change feed, and persistence (6).
