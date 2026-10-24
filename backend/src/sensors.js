'use strict';

/**
 * Pocket mode: the phone is in a pocket or holder, so there is no camera, only "the car
 * jolted here at this speed". One jolt can be a speed breaker or a door slam, so a jolt only
 * becomes a hazard when several different drivers feel the same spot.
 */

const config = require('./config');
const H = require('./hazards');
const { boundingBox, distanceMeters } = require('./geo');

const { DAY } = H;
const S = config.sensor;
const TZ_MS = config.timeZoneOffsetMinutes * 60000;
/** Calendar day in the city's time zone, so "different days" means what a driver means. */
const localDay = (t) => Math.floor((t + TZ_MS) / DAY);

/** Independent evidence in a cluster: different drivers, and different days (any driver). */
function evidence(cluster) {
  const users = new Set(cluster.map((h) => h.user_id));
  const days = new Set(cluster.map((h) => localDay(h.detected_at)));
  return { users: users.size, days: days.size };
}
const isConfirmed = (e) => e.users >= S.promoteUsers || e.days >= S.promoteDays;

/** 0..100 from how hard the jolt was and how fast the car was going. */
function sensorSeverity(shock, speed) {
  const score = (Math.min(shock || 0, 20) / 20) * 65 + (Math.min(speed || 0, 80) / 80) * 35;
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

function isIgnored(hit, now) {
  const ts = Math.min(hit.timestamp, now);
  if (ts < now - S.maxAgeDays * DAY) return true;
  if (hit.accuracy !== undefined && hit.accuracy !== null && hit.accuracy > S.maxAccuracyMeters) return true;
  if ((hit.speed || 0) < S.minSpeedKmh) return true;
  return false;
}

function asSighting(hit, hazard, score) {
  return {
    clientId: hit.clientId,
    type: hazard.type,
    source: 'sensor',
    latitude: hit.latitude,
    longitude: hit.longitude,
    accuracy: hit.accuracy,
    heading: hit.heading,
    speed: hit.speed,
    confidence: 0,
    shock: hit.shock,
    severityScore: score,
    roadName: hit.roadName,
  };
}

/** Road name for a new rough patch: from the hits themselves, else the nearest named hazard. */
function roadNameFor(db, cluster, lat, lng) {
  const counts = new Map();
  for (const h of cluster) if (h.road_name) counts.set(h.road_name, (counts.get(h.road_name) || 0) + 1);
  if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const near = H.findNearestAnyType(db, lat, lng, 60, { where: "AND road_name IS NOT NULL AND road_name <> ''" });
  return near ? near.road_name : null;
}

function promote(db, cluster, now) {
  const lat = cluster.reduce((a, h) => a + h.lat, 0) / cluster.length;
  const lng = cluster.reduce((a, h) => a + h.lng, 0) / cluster.length;
  const first = cluster.reduce((a, h) => (h.detected_at < a.detected_at ? h : a));
  const users = [...new Set(cluster.map((h) => h.user_id))];
  const ev = evidence(cluster);
  const info = db
    .prepare(
      `INSERT INTO hazards (type, lat, lng, road_name, status, discovered_by, first_reported_at, last_reported_at, updated_at)
       VALUES ('bump', ?, ?, ?, 'reported', ?, ?, ?, ?)`
    )
    .run(lat, lng, roadNameFor(db, cluster, lat, lng), first.user_id, first.detected_at, first.detected_at, now);
  let hazard = db.prepare('SELECT * FROM hazards WHERE id = ?').get(info.lastInsertRowid);
  H.addEvent(db, hazard.id, null, 'created', {
    to: 'reported',
    note:
      ev.users >= S.promoteUsers
        ? `Felt by ${users.length} different drivers in pocket mode.`
        : `Felt in pocket mode on ${ev.days} different days${users.length > 1 ? ` by ${users.length} drivers` : ''}.`,
    at: now,
  });
  for (const hit of cluster) {
    const r = {
      clientId: hit.client_id,
      latitude: hit.lat,
      longitude: hit.lng,
      accuracy: hit.accuracy,
      heading: hit.heading,
      speed: hit.speed,
      shock: hit.shock,
      roadName: hit.road_name,
    };
    db.prepare('DELETE FROM sensor_hits WHERE id = ?').run(hit.id);
    H.insertSighting(db, { id: hit.user_id }, hazard, asSighting(r, hazard, sensorSeverity(hit.shock, hit.speed)), hit.detected_at, now);
  }
  hazard = H.recomputeHazard(db, hazard.id, now);
  for (const u of users) H.awardPoints(db, u, config.points.sensorPromote);
  hazard = require('./accountability').maybeAutoAssign(db, hazard, now);
  return { hazard, users };
}

/**
 * Processes one batch of pocket-mode hits for `user`. Idempotent on clientId.
 * Returns the counters the API sends back.
 */
function ingestSensorHits(db, user, hits, now = Date.now()) {
  const out = { accepted: 0, ignored: 0, confirmed: 0, promoted: 0, pointsAwarded: 0, duplicates: 0 };
  const sorted = hits.slice().sort((a, b) => a.timestamp - b.timestamp);
  const seen = db.prepare('SELECT 1 FROM reports WHERE client_id = ? UNION ALL SELECT 1 FROM sensor_hits WHERE client_id = ? LIMIT 1');
  const insertHit = db.prepare(
    `INSERT INTO sensor_hits (client_id, user_id, lat, lng, accuracy, speed, heading, shock, road_name, hazard_id, detected_at, created_at)
     VALUES (@clientId, @userId, @latitude, @longitude, @accuracy, @speed, @heading, @shock, @roadName, @hazardId, @detectedAt, @now)`
  );

  db.transaction(() => {
    for (const hit of sorted) {
      if (isIgnored(hit, now)) { out.ignored++; continue; }
      out.accepted++;
      if (seen.get(hit.clientId, hit.clientId)) { out.duplicates++; continue; }
      const detectedAt = Math.min(hit.timestamp, now);
      const row = {
        clientId: hit.clientId,
        userId: user.id,
        latitude: hit.latitude,
        longitude: hit.longitude,
        accuracy: hit.accuracy ?? null,
        speed: hit.speed || 0,
        heading: hit.heading ?? null,
        shock: hit.shock || 0,
        roadName: H.cleanRoadName(hit.roadName),
        hazardId: null,
        detectedAt,
        now,
      };

      // 1. A known hazard right here: this jolt confirms it.
      const known = H.findNearestAnyType(db, hit.latitude, hit.longitude, S.radiusMeters, {
        excludeTypes: ['sewer_cover'],
        where: "AND status <> 'rejected'",
      });
      if (known) {
        const before = db.prepare('SELECT 1 FROM reports WHERE hazard_id = ? AND user_id = ? LIMIT 1').get(known.id, user.id);
        H.insertSighting(db, user, known, asSighting(hit, known, sensorSeverity(hit.shock, hit.speed)), detectedAt, now);
        H.afterSighting(db, known.id, user.id, detectedAt, now);
        out.confirmed++;
        if (!before) {
          H.awardPoints(db, user.id, config.points.sensorConfirm);
          out.pointsAwarded += config.points.sensorConfirm;
        }
        continue;
      }

      // 3. The city already rejected this spot (a speed breaker, say): absorb the jolt silently.
      const rejected = H.findNearestAnyType(db, hit.latitude, hit.longitude, S.radiusMeters, {
        excludeTypes: ['sewer_cover'],
        where: "AND status = 'rejected'",
      });
      if (rejected) {
        insertHit.run({ ...row, hazardId: rejected.id });
        continue;
      }

      // 2. Unknown spot: wait for other drivers to feel it too.
      insertHit.run(row);
      const box = boundingBox(hit.latitude, hit.longitude, S.radiusMeters);
      const cluster = db
        .prepare(
          `SELECT * FROM sensor_hits WHERE hazard_id IS NULL AND detected_at >= ?
             AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
        )
        .all(now - S.windowDays * DAY, box.minLat, box.maxLat, box.minLng, box.maxLng)
        .filter((h) => distanceMeters(hit.latitude, hit.longitude, h.lat, h.lng) <= S.radiusMeters);
      if (isConfirmed(evidence(cluster))) {
        const { users } = promote(db, cluster, now);
        out.promoted++;
        if (users.includes(user.id)) out.pointsAwarded += config.points.sensorPromote;
      }
    }
    // Hits that never found company expire.
    db.prepare('DELETE FROM sensor_hits WHERE detected_at < ?').run(now - S.windowDays * DAY);
  })();
  return out;
}

/**
 * Jolts still waiting for more evidence, grouped by spot, for the dashboard. Nothing here is a
 * hazard yet; it shows the city (and the pilot team) that pocket mode is working.
 */
function pendingClusters(db, { days = S.windowDays, now = Date.now() } = {}) {
  const hits = db
    .prepare('SELECT * FROM sensor_hits WHERE hazard_id IS NULL AND detected_at >= ? ORDER BY detected_at ASC')
    .all(now - days * DAY);
  const clusters = [];
  for (const h of hits) {
    let home = null;
    for (const c of clusters) {
      if (distanceMeters(c.lat, c.lng, h.lat, h.lng) <= S.radiusMeters) { home = c; break; }
    }
    if (!home) {
      home = { lat: h.lat, lng: h.lng, hits: [] };
      clusters.push(home);
    }
    home.hits.push(h);
    home.lat = home.hits.reduce((a, x) => a + x.lat, 0) / home.hits.length;
    home.lng = home.hits.reduce((a, x) => a + x.lng, 0) / home.hits.length;
  }
  return clusters
    .map((c) => {
      const e = evidence(c.hits);
      const roads = c.hits.map((x) => x.road_name).filter(Boolean);
      return {
        latitude: Math.round(c.lat * 1e6) / 1e6,
        longitude: Math.round(c.lng * 1e6) / 1e6,
        jolts: c.hits.length,
        drivers: e.users,
        days: e.days,
        maxShock: Math.round(Math.max(...c.hits.map((x) => x.shock || 0)) * 10) / 10,
        avgSpeed: Math.round(c.hits.reduce((a, x) => a + (x.speed || 0), 0) / c.hits.length),
        roadName: roads[0] || null,
        firstAt: c.hits[0].detected_at,
        lastAt: c.hits[c.hits.length - 1].detected_at,
        needs: { drivers: S.promoteUsers, days: S.promoteDays },
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

module.exports = { sensorSeverity, ingestSensorHits, pendingClusters };
