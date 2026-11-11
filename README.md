# WMS-WitMock

A standalone, generic, modern warehouse management system (SAP EWM / Manhattan Active class), built as a **mock host system for testing**. An integration layer connects to it through the REST/JSON API below. It has no AI, no voice, and no concepts from any other system.

- Node 20+ (tested on 22). **No dependencies.** Plain `node:http`.
- Store: one JSON file (`var/state.json`), written after every change. In-memory when no file is set. If the file cannot be read (cut off, not JSON, or the wrong shape), the server moves it aside as `<file>.corrupt-<timestamp>`, logs a loud warning, and starts from the seed.
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
| 404 | Unknown route, unknown act verb, or (sync acts) unknown task/entity (`not_found`, `unknown_act`). See the existence rule under Acts. |
| 405 | Wrong HTTP method |
| 409 | Sync act refused by a business rule (`task_not_open`, `insufficient_stock`, `bin_over_capacity`, `bin_not_active`, `dangling_reference`, ...) |
| 413 | Body over 1 MB (`body_too_large`). The server sends this answer first, then closes the connection. |
| 422 | Idempotency key reused with a different request (`idempotency_key_reuse`) |
| 500 | The mock itself failed while applying an act (`internal_error`). The act is refused and nothing it did is kept. A sync act answers 500. An async act is stored as refused with this code. Other 500s are unexpected server errors. |

### Reads

| Request | Answer |
|---|---|
| `GET /v1/snapshot` | The full warehouse. Top-level keys: `generation`, `as_of_seq`, `at`, `schema_version` (whole number, now `1`, the version of the dataset layout), `warehouse`, `labor_overload`, `labor_load`, and one array per collection: `items zones bins doors dock_appointments inventory pallets ledger asns orders waves deliveries loads tasks cycle_counts exceptions departments workers`. At seq 0 the data equals `data/seed.json`. |
| `GET /v1/changes?after=<seq>&limit=<n>` | `{ "generation": 1, "events": [...], "next_seq": 12, "has_more": false }`. `after` default 0. `limit` is 1 to 1000, default 100. `next_seq` is the last event you got, and it never goes above the server's current seq. An `after` past the end gives `events: []` and `next_seq` equal to the server's seq. |
| `GET /v1/acts/{act_id}` | The act object (see below). |
| `GET /v1/reconcile` | Quantity check: `{ ok, mismatches[], negative[], items[{item_id,on_hand_qty,ledger_qty}] }`. `ok` is true when on-hand stock equals the ledger replay for every location and item. |

**Sync pattern:**

1. Read `GET /v1/snapshot`. Keep `generation` and `as_of_seq`.
2. Read `GET /v1/changes?after=<cursor>`, starting with `cursor = as_of_seq`.
3. If the response `generation` is not the one you kept, the world was replaced (a reset). Throw away what you hold and go back to step 1. Do not apply those events.
4. Otherwise apply the events in order, set `cursor = next_seq`, and repeat from step 2 (at once while `has_more` is true).

`generation` is a whole number. It starts at 1 and goes up by 1 on every `POST /v1/admin/reset`. It is saved in the store file, so it survives a restart. If the store file is deleted, or is corrupt and the mock cannot read the old number from it, the next boot starts again at 1 (or at the old number plus 1 when it can be read). As a second guard, treat an `as_of_seq` that is lower than your cursor as a reason to resync too.

**Act lifecycles and refusals are not in the change feed.** Only warehouse data changes appear there. An act's verdict (`sent`, `landed`, `refused`) comes only from polling its `status_url`. A refused act changes nothing, so it leaves no events.

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
- **Which key wins.** If the body has an `idempotency_key` field at all, it is the key and the header is ignored. This holds even when the body value is null or not a string: you get `400 missing_idempotency_key`. The header is used only when the body has no such field.
- **What "the same request" means.** The verb plus the whole body, except `idempotency_key` itself. Extra fields count. An explicit `null` is not the same as an absent field. Key order does not matter.
- **A spent key is checked before validation.** Reusing a key with a different request answers `422` even if the new request would also be invalid.

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

Rules the mock enforces on `complete`: `task_id` and `worker_id` are strings of 1 to 64 characters. An unknown task or worker is `404 not_found`. `counted_qty` is allowed only on `count` tasks (and is required there). Refusals include `task_not_open`, `insufficient_stock`, `bin_over_capacity`, `bin_not_active` (the putaway bin's status is not `active`; the seed has none, and no act changes a bin's status, so this appears only if the store is edited by hand), and `dangling_reference` (a record the task points to, such as its pallet, bin, order, or cycle count, is missing from the store).

Result examples: `{ "task_id": "TK-0001", "type": "pick", "order_id": "SO-5001", "qty": 12, ... }`. A task that is not `open` is refused: `409 task_not_open`.

#### `flag` (sync, `200`)

Raises an OS&D / exception flag. Body: `{ idempotency_key, entity, id, kind, reason, severity?, worker_id? }`.

- `entity`: `asn order task bin pallet load delivery item worker door`. The record must exist (else 404).
- `kind`: free text, 1 to 64 characters, for example `damage`, `shortage`, `overage`, `quality_hold`, `location_blocked`.
- `id`: 1 to 64 characters. `reason`: a non-empty string.
- `severity`: `low`, `medium` (default), or `high`. Any other value is `400 invalid_request`.
- Result: `{ "exception_id": "EX-003" }`. A new row appears in `exceptions`.

#### `post-receiving` (async, `202`)

Receives goods against an ASN. Body: `{ idempotency_key, asn_id, lines: [{ line, qty }], worker_id? }`. Answers `202` with the act object (`status: "sent"`). **Nothing changes until the verdict.**

- Landed: one inbound pallet and one putaway task per line. The ASN becomes `receiving`, or `received` when every line is full (the door is freed). Result: `{ asn_id, asn_status, pallets: [{ pallet_id, line, item_id, qty, putaway_task_id }] }`.
- Refused (with `reason`): unknown ASN (`unknown_asn`), ASN not `arrived`/`receiving` (`asn_not_receivable`), unknown line (`unknown_line`), **over-receipt** (`over_receipt`, received would exceed expected), unknown `worker_id` (`unknown_worker`), or a missing door or dock appointment row (`dangling_reference`). A refused act changes nothing.
- Validation (400, checked when you submit): `asn_id` 1 to 64 characters. `lines` is a non-empty array. Each line needs `line` and `qty`, whole numbers of 1 or more. The same `line` twice in one request is refused (`400 invalid_request`).
- `worker_id` is not checked when you submit. An unknown one is refused at the verdict (`unknown_worker`). This differs from `complete` and `flag`, where an unknown worker is a 404 at once.

#### `confirm-load` (async, `202`)

Ships a load. Body: `{ idempotency_key, load_id, delivery_ids?, seal_no? }`. `delivery_ids` adds packed, unassigned deliveries to the load first. Answers `202`.

- Landed: pallet stock leaves the warehouse (ledger type `ship`). Deliveries and orders become `shipped`. The load becomes `shipped`. The door is freed. Result: `{ load_id, delivery_ids, pallets_shipped, units_shipped }`.
- Refused (with `reason`): unknown load (`unknown_load`), load already shipped (`load_already_shipped`), a wrong door (`wrong_door`), a delivery that does not exist (`unknown_delivery`) or is on another load (`delivery_on_other_load`), a delivery that is not `packed` (`delivery_not_packed`), a load with no deliveries (`empty_load`), or a missing door or dock appointment row (`dangling_reference`). A refused act changes nothing.

**Verdict.** Poll `status_url`. `sent` → `landed` or `refused`. The verdict arrives after `WMS_ASYNC_DELAY_MS`. The delay is counted from the moment the act is scheduled. If the server restarts while an act is `sent`, the act is scheduled again at boot and its clock starts over. Repeating a request with the same key while `sent` returns `202`. After the verdict it returns `200` with the settled act.

Whatever goes wrong while a verdict is applied, the act ends as `landed` or `refused`. It never stays `sent`. An unexpected failure in the mock is stored as `refused` with code `internal_error`, and all changes made by that attempt are undone.

**Unknown ids: sync and async differ.** A sync act (`complete`, `flag`) checks that its task, worker, or target exists when you submit. If not, you get `404 not_found` and the key is not used up. An async act (`post-receiving`, `confirm-load`) does not check the ASN or load when you submit. It answers `202`, uses up the key, and is refused at the verdict (`unknown_asn`, `unknown_load`).

### Mock control (not part of the integration surface)

| Request | Use |
|---|---|
| `POST /v1/admin/settle` | Give every pending async act its verdict now. Answer: `{ "settled": ["ACT-000001"] }`. |
| `POST /v1/admin/reset` | Reload the seed. Clears events, acts, and keys, cancels pending verdict timers, and adds 1 to `generation`. Act ids start again at `ACT-000001`. |

## Known limits of the mock

- One process per state file. Two servers on the same file will overwrite each other.
- The event log is never trimmed. It grows for the life of the store file. Reset or delete the file to start small.
- Acts and idempotency keys are kept forever (until a reset).

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

`npm test` runs 45 tests: seed determinism and dataset integrity (9), quantity reconciliation (3), idempotent replay (7), the async verdict arc (6), API surface, change feed, and persistence (6), and edge cases (14): settle safety and dangling references, the 413 answer, reset and timers, cursor and generation, corrupt state file, and shared auth and verb handling.
