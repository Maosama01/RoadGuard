'use strict';

/**
 * Coverage: which roads were actually driven with RoadGuard running, and when. Without it,
 * "no reports on this road" could mean "the road is fine" or "nobody checked".
 *
 * The map is a grid of ~110 m cells (lat/lng rounded to 0.001 degrees).
 */

const H = require('./hazards');
const A = require('./accountability');

const { DAY, OPEN_STATUSES } = H;
const CELL = 0.001;
const CELL_KM = 0.111; // one cell crossed is roughly this much road

const round3 = (v) => Math.round(v / CELL) / 1000;
function cellOf(lat, lng) {
  const la = round3(lat);
  const ln = round3(lng);
  return { key: `${la.toFixed(3)},${ln.toFixed(3)}`, lat: la, lng: ln };
}

/** Stores one drive and marks the cells it passed through. Idempotent on clientId. */
function ingestDrive(db, user, d, now = Date.now()) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM drives WHERE client_id = ?').get(d.clientId);
    if (existing) return { duplicate: true, cells: existing.cells, distanceMeters: existing.distance_meters };

    const endedAt = Math.min(d.endedAt, now);
    const cells = new Map();
    for (const p of d.path) {
      const [lat, lng, t] = p;
      const ts = Math.min(Number.isFinite(t) && t > 0 ? t : endedAt, now);
      const c = cellOf(lat, lng);
      const prev = cells.get(c.key);
      if (!prev || ts > prev.ts) cells.set(c.key, { ...c, ts });
    }

    const info = db
      .prepare(
        `INSERT INTO drives (client_id, user_id, mode, started_at, ended_at, distance_meters, cells, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(d.clientId, user.id, d.mode, Math.min(d.startedAt, endedAt), endedAt, d.distanceMeters, cells.size, now);
    const driveId = info.lastInsertRowid;
    const insCell = db.prepare('INSERT INTO drive_cells (drive_id, cell_key, lat, lng, scanned_at) VALUES (?, ?, ?, ?, ?)');
    const upsert = db.prepare(
      `INSERT INTO coverage_cells (cell_key, lat, lng, scans, last_scanned_at, last_mode) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(cell_key) DO UPDATE SET
         scans = scans + 1,
         last_mode = CASE WHEN excluded.last_scanned_at >= last_scanned_at THEN excluded.last_mode ELSE last_mode END,
         last_scanned_at = MAX(last_scanned_at, excluded.last_scanned_at)`
    );
    for (const c of cells.values()) {
      insCell.run(driveId, c.key, c.lat, c.lng, c.ts);
      upsert.run(c.key, c.lat, c.lng, c.ts, d.mode);
    }
    return { duplicate: false, cells: cells.size, distanceMeters: d.distanceMeters };
  })();
}

function coverageCells(db, { bbox = null, days = 30, now = Date.now(), limit = 20000 } = {}) {
  const where = ['last_scanned_at >= ?'];
  const params = [now - days * DAY];
  if (bbox) {
    where.push('lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
    params.push(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
  }
  return db
    .prepare(`SELECT lat, lng, scans, last_scanned_at FROM coverage_cells WHERE ${where.join(' AND ')}
              ORDER BY last_scanned_at DESC LIMIT ?`)
    .all(...params, limit)
    .map((c) => ({ lat: c.lat, lng: c.lng, scans: c.scans, lastScannedAt: c.last_scanned_at }));
}

/**
 * Cells a road runs through, estimated from where its hazards were reported: points are
 * ordered along the road's main direction and joined (gaps over 1.5 km are left open), then
 * every cell within one cell of that line counts as the road.
 */
function roadFootprint(points) {
  const keys = new Set();
  const add = (lat, lng) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) keys.add(cellOf(lat + a * CELL, lng + b * CELL).key);
  };
  if (!points.length) return keys;
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const alongLat = Math.max(...lats) - Math.min(...lats) >= Math.max(...lngs) - Math.min(...lngs);
  const sorted = points.slice().sort((p, q) => (alongLat ? p[0] - q[0] : p[1] - q[1]));
  for (let i = 0; i < sorted.length; i++) {
    const [la, ln] = sorted[i];
    add(la, ln);
    const next = sorted[i + 1];
    if (!next) break;
    const dLat = next[0] - la;
    const dLng = next[1] - ln;
    const gapKm = Math.hypot(dLat * 111, dLng * 96);
    if (gapKm > 1.5) continue;
    const steps = Math.ceil(gapKm / 0.05);
    for (let s = 1; s < steps; s++) add(la + (dLat * s) / steps, ln + (dLng * s) / steps);
  }
  return keys;
}

/** Road Health Index: 100 is a perfect road; open hazards subtract weight by type and severity. */
const HEALTH_WEIGHT = { pothole: 12, drain_hole: 12, crack: 5, bump: 6, other: 4, sewer_cover: 4 };
const LEVEL_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function roadHealth(db, { limit = 50, now = Date.now() } = {}) {
  const hazards = db.prepare(`SELECT * FROM hazards WHERE road_name IS NOT NULL AND road_name <> '' AND status <> 'rejected'`).all();
  const reportPts = db
    .prepare(
      `SELECT h.road_name AS road, r.lat, r.lng FROM reports r JOIN hazards h ON h.id = r.hazard_id
       WHERE h.road_name IS NOT NULL AND h.road_name <> ''`
    )
    .all();
  const since = now - 30 * DAY;
  const passes = new Map(
    db.prepare('SELECT cell_key, COUNT(*) n FROM drive_cells WHERE scanned_at >= ? GROUP BY cell_key').all(since).map((r) => [r.cell_key, r.n])
  );
  const lastScan = new Map(db.prepare('SELECT cell_key, last_scanned_at t FROM coverage_cells').all().map((r) => [r.cell_key, r.t]));
  const segments = db.prepare('SELECT * FROM road_segments').all();
  const lk = H.lookups(db);

  const roads = new Map();
  const roadOf = (name) => {
    if (!roads.has(name)) roads.set(name, { road: name, weight: 0, openHazards: 0, potholes: 0, cracks: 0, worst: null, points: [] });
    return roads.get(name);
  };
  for (const h of hazards) {
    const r = roadOf(h.road_name);
    r.points.push([h.lat, h.lng]);
    if (!OPEN_STATUSES.includes(h.status)) continue;
    r.openHazards++;
    if (h.type === 'pothole') r.potholes++;
    if (h.type === 'crack') r.cracks++;
    r.weight += ((h.severity_score || 0) / 100) * (HEALTH_WEIGHT[h.type] || 4);
    if (!r.worst || LEVEL_RANK[h.severity_level] > LEVEL_RANK[r.worst]) r.worst = h.severity_level;
  }
  for (const p of reportPts) if (roads.has(p.road)) roads.get(p.road).points.push([p.lat, p.lng]);

  const items = [...roads.values()].map((r) => {
    const cells = roadFootprint(r.points);
    let n = 0;
    let last = null;
    for (const k of cells) {
      n += passes.get(k) || 0;
      const t = lastScan.get(k);
      if (t && (!last || t > last)) last = t;
    }
    const seg = A.segmentForRoad(segments, r.road);
    const c = seg ? lk.contractor(seg.contractor_id) : null;
    return {
      road: r.road,
      healthScore: Math.round(100 - Math.min(100, r.weight)),
      openHazards: r.openHazards,
      potholes: r.potholes,
      cracks: r.cracks,
      worstSeverity: r.worst,
      kmScanned30d: Math.round(n * CELL_KM * 10) / 10,
      lastScannedAt: last,
      contractor: c ? c.name : null,
    };
  });
  items.sort((a, b) => a.healthScore - b.healthScore || b.openHazards - a.openHazards || a.road.localeCompare(b.road));
  return items.slice(0, limit);
}

module.exports = { CELL, CELL_KM, cellOf, ingestDrive, coverageCells, roadFootprint, roadHealth, HEALTH_WEIGHT };
