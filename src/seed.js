'use strict';
// Deterministic seed for the mock warehouse.
// No randomness, no wall-clock: every timestamp is a fixed literal built from
// constants. data/seed.json is the serialized output of buildSeed().

const pad = (n) => String(n).padStart(2, '0');
const t = (day, h, m = 0) => `2026-01-${pad(12 + day)}T${pad(h)}:${pad(m)}:00Z`;
const SEED_AT = t(0, 7);

const binId = (zone, i) => `${zone}-0${1 + Math.floor(i / 5)}-0${1 + (i % 5)}`;
const skuId = (i) => `SKU-${1001 + i}`;

function buildSeed() {
  // ---- item master -------------------------------------------------------
  const itemRows = [
    ['Cotton T-Shirt, Medium', 24, 0.2],
    ['Cotton T-Shirt, Large', 24, 0.22],
    ['Canvas Tote Bag', 20, 0.35],
    ['Stainless Water Bottle 500ml', 12, 0.4],
    ['Ceramic Mug 12oz', 24, 0.45],
    ['Notebook A5 Ruled', 50, 0.25],
    ['Ballpoint Pen Blue (box of 10)', 40, 0.1],
    ['LED Desk Lamp', 6, 1.2],
    ['Office Chair Mat', 4, 4.5],
    ['Monitor Stand', 4, 3.1],
    ['Bamboo Cutting Board', 10, 1.0],
    ['Silicone Spatula Set', 20, 0.3],
  ];
  const putawayZone = (i) => (i < 10 ? 'ZA' : 'ZC');
  const putawayIdx = (i) => (i < 10 ? i : i - 10);
  const items = itemRows.map(([description, case_qty, weight_kg], i) => ({
    id: skuId(i),
    description,
    uom: 'EA',
    case_qty,
    weight_kg,
    putaway_bin: binId(putawayZone(i), putawayIdx(i)),
  }));

  // ---- zones and bins ----------------------------------------------------
  const zones = [
    { id: 'ZA', name: 'Reserve', type: 'reserve' },
    { id: 'ZB', name: 'Forward Pick', type: 'pick' },
    { id: 'ZC', name: 'Overflow and Returns', type: 'overflow' },
  ];
  const capacity = { ZA: 600, ZB: 150, ZC: 300 };
  const bins = [];
  for (const z of zones) {
    for (let i = 0; i < 10; i++) {
      bins.push({
        id: binId(z.id, i),
        zone_id: z.id,
        aisle: `0${1 + Math.floor(i / 5)}`,
        position: `0${1 + (i % 5)}`,
        capacity: capacity[z.id],
        status: 'active',
      });
    }
  }

  // ---- dock doors --------------------------------------------------------
  const doorState = {
    D03: { status: 'occupied', current_ref: { type: 'asn', id: 'ASN-1003' } },
    D04: { status: 'occupied', current_ref: { type: 'asn', id: 'ASN-1004' } },
    D07: { status: 'occupied', current_ref: { type: 'load', id: 'LD-9001' } },
  };
  const doors = [];
  for (let n = 1; n <= 12; n++) {
    const id = `D${pad(n)}`;
    doors.push({
      id,
      name: `Dock Door ${pad(n)}`,
      direction: n <= 6 ? 'inbound' : 'outbound',
      status: 'free',
      current_ref: null,
      ...(doorState[id] || {}),
    });
  }

  // ---- inventory (bins and staging pallets) ------------------------------
  const inventory = [];
  const put = (location_id, item_id, qty) => inventory.push({ location_id, item_id, qty });
  for (let i = 0; i < 8; i++) {
    put(binId('ZB', i), skuId(i), 70 + ((i * 13) % 40)); // forward pick bin
    put(binId('ZA', i), skuId(i), 200 + ((i * 37) % 150)); // reserve bin
  }
  put(binId('ZA', 8), skuId(8), 120);
  put(binId('ZA', 9), skuId(9), 90);
  put(binId('ZC', 0), skuId(10), 80);
  put(binId('ZC', 1), skuId(11), 100);
  for (let i = 2; i < 8; i++) put(binId('ZC', i), skuId(i - 2), 20 + i * 5); // overflow
  put(binId('ZB', 8), skuId(0), 30);
  put(binId('ZB', 9), skuId(1), 30);

  // Staging pallets: 3 inbound awaiting putaway, 5 outbound packed for loading.
  const palletRows = [
    ['PAL-001', 'inbound', 'STG-D04', 'putaway_pending', 'ASN-1004', 1, null, skuId(2), 60],
    ['PAL-002', 'inbound', 'STG-D05', 'putaway_pending', 'ASN-1005', 1, null, skuId(8), 40],
    ['PAL-003', 'inbound', 'STG-D05', 'putaway_pending', 'ASN-1005', 2, null, skuId(10), 24],
    ['PAL-004', 'outbound', 'STG-D07', 'staged_for_load', null, null, 'OD-7001', skuId(0), 8],
    ['PAL-005', 'outbound', 'STG-D07', 'staged_for_load', null, null, 'OD-7001', skuId(1), 6],
    ['PAL-006', 'outbound', 'STG-D07', 'staged_for_load', null, null, 'OD-7002', skuId(4), 12],
    ['PAL-007', 'outbound', 'STG-D08', 'staged_for_load', null, null, 'OD-7003', skuId(5), 10],
    ['PAL-008', 'outbound', 'STG-D08', 'staged_for_load', null, null, 'OD-7003', skuId(6), 4],
  ];
  const pallets = palletRows.map(([id, direction, lane, status, asn_id, asn_line, delivery_id, item, qty]) => {
    put(id, item, qty);
    return { id, direction, lane, status, asn_id, asn_line, delivery_id };
  });

  const ledger = inventory.map((r, i) => ({
    id: `LG-${String(i + 1).padStart(6, '0')}`,
    at: SEED_AT,
    type: 'opening',
    item_id: r.item_id,
    from_location: null,
    to_location: r.location_id,
    qty: r.qty,
    ref: null,
  }));

  // ---- inbound -----------------------------------------------------------
  const asnRows = [
    ['ASN-1001', 'Northwind Supply', 'scheduled', 'D01', 'APT-101', null, [[skuId(3), 200, 0]]],
    ['ASN-1002', 'Pacific Goods', 'scheduled', 'D02', 'APT-102', null, [[skuId(9), 30, 0], [skuId(11), 50, 0]]],
    ['ASN-1003', 'Lakeside Imports', 'arrived', 'D03', 'APT-103', t(0, 6, 30), [[skuId(1), 100, 0], [skuId(4), 60, 0]]],
    ['ASN-1004', 'Harbor Goods Ltd', 'receiving', 'D04', 'APT-104', t(0, 5, 45), [[skuId(2), 120, 60], [skuId(7), 48, 0]]],
    ['ASN-1005', 'Summit Wholesale', 'received', 'D05', 'APT-105', t(0, 5, 0), [[skuId(8), 40, 40], [skuId(10), 24, 24]]],
  ];
  const asns = asnRows.map(([id, supplier, status, door_id, appointment_id, arrived_at, lines]) => ({
    id,
    supplier,
    status,
    door_id,
    appointment_id,
    arrived_at,
    lines: lines.map(([item_id, expected_qty, received_qty], k) => ({ line: k + 1, item_id, expected_qty, received_qty })),
  }));

  const dock_appointments = [
    ['APT-101', 'D01', 'inbound', 'asn', 'ASN-1001', t(0, 14), t(0, 15), 'scheduled'],
    ['APT-102', 'D02', 'inbound', 'asn', 'ASN-1002', t(0, 15), t(0, 16), 'scheduled'],
    ['APT-103', 'D03', 'inbound', 'asn', 'ASN-1003', t(0, 6, 30), t(0, 7, 30), 'arrived'],
    ['APT-104', 'D04', 'inbound', 'asn', 'ASN-1004', t(0, 5, 30), t(0, 7), 'arrived'],
    ['APT-105', 'D05', 'inbound', 'asn', 'ASN-1005', t(0, 4, 30), t(0, 5, 30), 'completed'],
    ['APT-201', 'D07', 'outbound', 'load', 'LD-9001', t(0, 6), t(0, 8), 'arrived'],
    ['APT-202', 'D08', 'outbound', 'load', 'LD-9002', t(0, 13), t(0, 14), 'scheduled'],
  ].map(([id, door_id, direction, ref_type, ref_id, start, end, status]) => ({
    id, door_id, direction, ref_type, ref_id, start, end, status,
  }));

  // ---- outbound ----------------------------------------------------------
  const orderDefs = [
    ['SO-5001', 'Acme Retail', 'released', 'WV-301', null, [[1001, 12, 0], [1003, 6, 0], [1009, 4, 0]]],
    ['SO-5002', 'Bluebird Stores', 'released', 'WV-301', null, [[1002, 8, 0], [1004, 10, 0], [1005, 5, 0], [1011, 3, 0]]],
    ['SO-5003', 'Cedar and Co', 'released', 'WV-301', null, [[1006, 20, 0], [1007, 6, 0], [1008, 9, 0], [1001, 5, 0]]],
    ['SO-5004', 'Delta Outfitters', 'released', 'WV-301', null, [[1002, 4, 0], [1005, 6, 0], [1007, 3, 0], [1008, 2, 0], [1004, 5, 0], [1010, 2, 0]]],
    ['SO-5005', 'Evergreen Market', 'open', 'WV-302', null, [[1001, 10, 0], [1006, 4, 0]]],
    ['SO-5006', 'Foxglove Boutique', 'open', 'WV-302', null, [[1004, 6, 0]]],
    ['SO-5007', 'Granite Supply', 'packed', null, 'OD-7001', [[1001, 8, 8], [1002, 6, 6]]],
    ['SO-5008', 'Harbor Retail', 'packed', null, 'OD-7002', [[1005, 12, 12]]],
    ['SO-5009', 'Iris Home Goods', 'packed', null, 'OD-7003', [[1006, 10, 10], [1007, 4, 4]]],
    ['SO-5010', 'Juniper Gifts', 'open', null, null, [[1012, 10, 0]]],
  ];
  const orders = orderDefs.map(([id, customer, status, wave_id, delivery_id, lines]) => ({
    id,
    customer,
    status,
    wave_id,
    delivery_id,
    lines: lines.map(([sku, qty, picked_qty], k) => ({ line: k + 1, item_id: `SKU-${sku}`, qty, picked_qty })),
  }));
  const waves = [
    { id: 'WV-301', status: 'released', order_ids: ['SO-5001', 'SO-5002', 'SO-5003', 'SO-5004'], released_at: t(0, 6, 45) },
    { id: 'WV-302', status: 'planned', order_ids: ['SO-5005', 'SO-5006'], released_at: null },
  ];
  const deliveries = [
    { id: 'OD-7001', order_id: 'SO-5007', status: 'packed', load_id: 'LD-9001', pallet_ids: ['PAL-004', 'PAL-005'], shipped_at: null },
    { id: 'OD-7002', order_id: 'SO-5008', status: 'packed', load_id: 'LD-9001', pallet_ids: ['PAL-006'], shipped_at: null },
    { id: 'OD-7003', order_id: 'SO-5009', status: 'packed', load_id: 'LD-9002', pallet_ids: ['PAL-007', 'PAL-008'], shipped_at: null },
  ];
  const loads = [
    { id: 'LD-9001', door_id: 'D07', carrier: 'Redline Freight', status: 'loading', appointment_id: 'APT-201', delivery_ids: ['OD-7001', 'OD-7002'], seal_no: null, shipped_at: null },
    { id: 'LD-9002', door_id: 'D08', carrier: 'Blue Ridge Carriers', status: 'planned', appointment_id: 'APT-202', delivery_ids: ['OD-7003'], seal_no: null, shipped_at: null },
  ];

  // ---- labor -------------------------------------------------------------
  const departments = [
    { id: 'RCV', name: 'Receiving' },
    { id: 'PUT', name: 'Putaway' },
    { id: 'PCK', name: 'Picking' },
    { id: 'PAK', name: 'Packing' },
    { id: 'SHP', name: 'Shipping' },
    { id: 'INV', name: 'Inventory Control' },
  ];
  const workerRows = [
    ['W-01', 'Maria Santos', 'RCV', null],
    ['W-02', 'Tom Becker', 'RCV', null],
    ['W-03', 'Priya Nair', 'PUT', 'ZA'],
    ['W-04', 'Luis Ortega', 'PUT', 'ZA'],
    ['W-05', 'Hannah Kim', 'PCK', 'ZA'],
    ['W-06', 'Omar Haddad', 'PCK', 'ZA'],
    ['W-07', 'Grace Liu', 'INV', 'ZA'],
    ['W-08', 'Ben Carter', 'PUT', 'ZA'],
    ['W-09', 'Sofia Rossi', 'PCK', 'ZB'],
    ['W-10', 'Dev Patel', 'PCK', 'ZB'],
    ['W-11', 'Anna Novak', 'PCK', 'ZC'],
    ['W-12', 'Jack Moreau', 'PCK', 'ZC'],
    ['W-13', 'Lena Fischer', 'INV', 'ZC'],
    ['W-14', 'Chris Obi', 'PAK', null],
    ['W-15', 'Mia Tanaka', 'PAK', null],
    ['W-16', 'Sam Walker', 'SHP', null],
    ['W-17', 'Ivy Chen', 'SHP', null],
  ];
  const workers = workerRows.map(([id, name, department_id, zone_id]) => ({
    id, name, department_id, zone_id, shift: 'day', status: 'active',
  }));

  // ---- tasks and cycle counts -------------------------------------------
  const pickBin = (sku) => {
    const i = sku - 1001;
    if (i < 8) return binId('ZB', i);
    if (i < 10) return binId('ZA', i);
    return binId('ZC', 0);
  };
  const tasks = [];
  let zbToggle = 0;
  const nextTk = () => `TK-${String(tasks.length + 1).padStart(4, '0')}`;
  for (const o of orderDefs.slice(0, 4)) {
    const [orderId, , , waveId, , lines] = o;
    lines.forEach(([sku, qty], k) => {
      const from_bin = pickBin(sku);
      const zone_id = from_bin.slice(0, 2);
      let assigned_to = 'W-05';
      if (zone_id === 'ZB') assigned_to = zbToggle++ % 2 === 0 ? 'W-09' : 'W-10';
      if (zone_id === 'ZC') assigned_to = 'W-11';
      tasks.push({
        id: nextTk(), type: 'pick', status: 'open', zone_id, assigned_to,
        wave_id: waveId, order_id: orderId, line: k + 1, item_id: `SKU-${sku}`, qty,
        from_bin, to_location: `PK-${orderId}`,
        created_at: t(0, 6, 45), completed_at: null, completed_by: null,
      });
    });
  }
  const putawayDefs = [['PAL-001', 'W-03'], ['PAL-002', 'W-04'], ['PAL-003', null]];
  for (const [pallet_id, assigned_to] of putawayDefs) {
    const inv = inventory.find((r) => r.location_id === pallet_id);
    const item = items.find((x) => x.id === inv.item_id);
    tasks.push({
      id: nextTk(), type: 'putaway', status: 'open', zone_id: item.putaway_bin.slice(0, 2), assigned_to,
      pallet_id, item_id: inv.item_id, qty: inv.qty, from_location: pallet_id, to_bin: item.putaway_bin,
      created_at: t(0, 6), completed_at: null, completed_by: null,
    });
  }
  const cycle_counts = [
    { id: 'CC-401', bin_id: binId('ZA', 1), item_id: skuId(1), status: 'open', task_id: null, system_qty: null, counted_qty: null, variance: null },
    { id: 'CC-402', bin_id: binId('ZC', 0), item_id: skuId(10), status: 'open', task_id: null, system_qty: null, counted_qty: null, variance: null },
  ];
  for (const cc of cycle_counts) {
    cc.task_id = nextTk();
    tasks.push({
      id: cc.task_id, type: 'count', status: 'open', zone_id: cc.bin_id.slice(0, 2),
      assigned_to: cc.bin_id.startsWith('ZA') ? 'W-07' : 'W-13',
      cycle_count_id: cc.id, bin_id: cc.bin_id, item_id: cc.item_id,
      created_at: t(0, 6, 30), completed_at: null, completed_by: null,
    });
  }

  const exceptions = [
    { id: 'EX-001', kind: 'damage', entity: 'asn', entity_id: 'ASN-1005', severity: 'medium', reason: 'Two cartons crushed on arrival.', status: 'open', raised_at: t(0, 5, 20), raised_by: 'W-01' },
    { id: 'EX-002', kind: 'location_blocked', entity: 'bin', entity_id: binId('ZC', 9), severity: 'low', reason: 'Water leak near this bin. Do not put stock here.', status: 'open', raised_at: t(0, 6, 10), raised_by: 'W-13' },
  ];

  return {
    schema_version: 1,
    warehouse: { id: 'WH-01', name: 'Mock Distribution Center', timezone: 'UTC', seeded_at: SEED_AT },
    labor_overload: {
      zone_id: 'ZB',
      note: 'Zone ZB has 14 open pick tasks and only 2 active workers. Other zones have 1 task or fewer per worker.',
    },
    items,
    zones,
    bins,
    doors,
    dock_appointments,
    inventory,
    pallets,
    ledger,
    asns,
    orders,
    waves,
    deliveries,
    loads,
    tasks,
    cycle_counts,
    exceptions,
    departments,
    workers,
  };
}

function serializeSeed(seed = buildSeed()) {
  return JSON.stringify(seed, null, 2) + '\n';
}

module.exports = { buildSeed, serializeSeed, SEED_AT };
