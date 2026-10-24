'use strict';

/**
 * Hazard intelligence.
 *
 * Every report is one sighting from one phone. Sightings of the same type that land within
 * `mergeRadiusMeters` of an existing hazard are merged into it, so authorities see one pothole
 * with 14 confirmations instead of 14 rows. Aggregates (position, severity, priority) are always
 * recomputed from the underlying reports, so they never drift.
 */

const config = require('./config');
const { distanceMeters, boundingBox } = require('./geo');

const STATUSES = ['reported', 'verified', 'assigned', 'in_progress', 'resolved', 'rejected'];
const OPEN_STATUSES = ['reported', 'verified', 'assigned', 'in_progress'];
const TYPES = ['pothole', 'drain_hole', 'sewer_cover', 'crack', 'bump', 'other'];
const TYPE_LABELS = {
  pothole: 'Pothole',
  drain_hole: 'Open drain',
  sewer_cover: 'Sewer cover',
  crack: 'Cracked surface',
  bump: 'Rough patch',
  other: 'Road hazard',
};
const DAY = 86400000;

/**
 * Phone geocoders often return a Plus Code ("CX7C+2JQ"), "Unnamed Road" or a house number
 * instead of a street. Those make useless titles and never match a contractor's road, so they
 * are stored as no name at all.
 */
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}(\b|$)/i;
function cleanRoadName(name) {
  if (name === null || name === undefined) return null;
  const n = String(name).replace(/\s+/g, ' ').trim();
  if (!n) return null;
  if (PLUS_CODE.test(n)) return null;
  if (/^(unnamed road|unnamed|unknown|null|undefined|road|n\/a|na)$/i.test(n)) return null;
  if (/^[\d\s,./-]+$/.test(n)) return null; // just a house or plot number
  return n;
}

/** One-off repair for names saved before cleanRoadName existed. Returns rows changed. */
function cleanStoredRoadNames(db) {
  let changed = 0;
  for (const table of ['hazards', 'reports', 'sensor_hits']) {
    const names = db.prepare(`SELECT DISTINCT road_name AS n FROM ${table} WHERE road_name IS NOT NULL`).all();
    const upd = db.prepare(`UPDATE ${table} SET road_name = ? WHERE road_name = ?`);
    for (const { n } of names) {
      const clean = cleanRoadName(n);
      if (clean !== n) changed += upd.run(clean, n).changes;
    }
  }
  return changed;
}

// accountability.js requires this module, so load it lazily to avoid a require cycle.
const accountability = () => require('./accountability');

/** Same thresholds the app uses (SeverityCalculator.kt) so both sides agree. */
function severityLevel(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

/**
 * 0..100. Blends how bad it is, how many independent people hit it, how fast traffic is
 * there (faster = more dangerous), how long it has been left open and whether the
 * contractor's deadline has passed (+10 per escalation level).
 */
function computePriority(h, now = Date.now()) {
  if (!OPEN_STATUSES.includes(h.status)) return 0;
  const severity = (h.severity_score || 0) * 0.55;
  const crowd = Math.min(h.unique_reporters || 0, 10) * 2.5;
  const speed = (Math.min(h.avg_speed || 0, 80) / 80) * 10;
  const ageDays = Math.max(0, (now - h.first_reported_at) / DAY);
  const age = (Math.min(ageDays, 30) / 30) * 10;
  const escalation = 10 * (h.escalation_level || 0);
  return Math.round(Math.min(100, severity + crowd + speed + age + escalation) * 10) / 10;
}

function levelFor(points) {
  const levels = config.levels;
  let idx = 0;
  for (let i = 0; i < levels.length; i++) if (points >= levels[i].min) idx = i;
  const next = levels[idx + 1] || null;
  return {
    level: levels[idx].name,
    levelIndex: idx,
    nextLevel: next ? next.name : null,
    nextLevelPoints: next ? next.min : null,
    levelFloorPoints: levels[idx].min,
  };
}

function addEvent(db, hazardId, actorId, type, extra = {}) {
  db.prepare(
    `INSERT INTO hazard_events (hazard_id, actor_id, type, from_status, to_status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(hazardId, actorId || null, type, extra.from || null, extra.to || null, extra.note || null, extra.at || Date.now());
}

function awardPoints(db, userId, points) {
  if (!userId || !points) return;
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(points, userId);
}

/** Finds the closest open-or-closed hazard of the same type within the merge radius. */
function findNearbyHazard(db, type, lat, lng, radius = config.hazard.mergeRadiusMeters) {
  const box = boundingBox(lat, lng, radius);
  const candidates = db
    .prepare(
      `SELECT * FROM hazards
       WHERE type = ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
    )
    .all(type, box.minLat, box.maxLat, box.minLng, box.maxLng);
  let best = null;
  let bestDist = Infinity;
  for (const h of candidates) {
    const d = distanceMeters(lat, lng, h.lat, h.lng);
    if (d <= radius && d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Closest hazard of any type (except the listed ones) within `radius`, regardless of status.
 * Used by pocket mode, which cannot tell a pothole from an open drain.
 */
function findNearestAnyType(db, lat, lng, radius, { excludeTypes = [], where = '' } = {}) {
  const box = boundingBox(lat, lng, radius);
  const candidates = db
    .prepare(`SELECT * FROM hazards WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ${where}`)
    .all(box.minLat, box.maxLat, box.minLng, box.maxLng)
    .filter((h) => !excludeTypes.includes(h.type));
  let best = null;
  let bestDist = Infinity;
  for (const h of candidates) {
    const d = distanceMeters(lat, lng, h.lat, h.lng);
    if (d <= radius && d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

/** Recomputes all aggregates of a hazard from its reports and votes. */
function recomputeHazard(db, hazardId, now = Date.now()) {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS uniq, AVG(confidence) AS conf,
              MAX(shock) AS shock, AVG(speed) AS speed, MAX(detected_at) AS last, MIN(detected_at) AS first,
              SUM(lat / MAX(COALESCE(accuracy, 10), 3)) AS wlat,
              SUM(lng / MAX(COALESCE(accuracy, 10), 3)) AS wlng,
              SUM(1.0 / MAX(COALESCE(accuracy, 10), 3)) AS w
       FROM reports WHERE hazard_id = ?`
    )
    .get(hazardId);
  if (!agg || !agg.n) return null;

  // Severity = mean of the three worst sightings: robust to one soft hit, honest about a bad one.
  const sev = db
    .prepare(
      `SELECT AVG(s) AS score FROM (
         SELECT severity_score AS s FROM reports WHERE hazard_id = ? ORDER BY s DESC LIMIT 3)`
    )
    .get(hazardId).score || 0;

  const cover = db
    .prepare(
      `SELECT image FROM reports WHERE hazard_id = ? AND image IS NOT NULL
       ORDER BY confidence DESC, detected_at DESC LIMIT 1`
    )
    .get(hazardId);

  const road = db
    .prepare(
      `SELECT road_name, COUNT(*) c FROM reports
       WHERE hazard_id = ? AND road_name IS NOT NULL AND road_name <> ''
       GROUP BY road_name ORDER BY c DESC`
    )
    .all(hazardId)
    .find((r) => cleanRoadName(r.road_name));

  const area = db
    .prepare(
      `SELECT area, COUNT(*) c FROM reports WHERE hazard_id = ? AND area IS NOT NULL AND area <> ''
       GROUP BY area ORDER BY c DESC LIMIT 1`
    )
    .get(hazardId);

  const h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(hazardId);
  const updated = {
    ...h,
    lat: agg.wlat / agg.w,
    lng: agg.wlng / agg.w,
    report_count: agg.n,
    unique_reporters: agg.uniq,
    avg_confidence: agg.conf || 0,
    max_shock: agg.shock || 0,
    avg_speed: agg.speed || 0,
    severity_score: Math.round(sev * 10) / 10,
    severity_level: severityLevel(sev),
    cover_image: cover ? cover.image : h.cover_image,
    road_name: road ? road.road_name : cleanRoadName(h.road_name),
    area: area ? area.area : h.area,
    last_reported_at: Math.max(h.last_reported_at || 0, agg.last),
    first_reported_at: Math.min(h.first_reported_at || agg.first, agg.first),
  };
  updated.priority = computePriority(updated, now);

  db.prepare(
    `UPDATE hazards SET lat=@lat, lng=@lng, report_count=@report_count, unique_reporters=@unique_reporters,
       avg_confidence=@avg_confidence, max_shock=@max_shock, avg_speed=@avg_speed,
       severity_score=@severity_score, severity_level=@severity_level, cover_image=@cover_image,
       road_name=@road_name, area=@area, last_reported_at=@last_reported_at, first_reported_at=@first_reported_at,
       priority=@priority, updated_at=${now}
     WHERE id=@id`
  ).run(updated);
  return updated;
}

function setStatus(db, hazard, toStatus, actorId, { note, type, resolvedBy, now = Date.now() } = {}) {
  const from = hazard.status;
  if (from === toStatus) return hazard;
  const firstResolution =
    toStatus === 'resolved' &&
    !db.prepare(`SELECT 1 FROM hazard_events WHERE hazard_id = ? AND to_status = 'resolved' LIMIT 1`).get(hazard.id);

  db.prepare(
    `UPDATE hazards SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?`
  ).run(
    toStatus,
    toStatus === 'resolved' ? now : null,
    toStatus === 'resolved' ? resolvedBy || 'authority' : null,
    now,
    hazard.id
  );
  // Back on the list after being closed: the old deadline no longer applies. The normal
  // auto-assignment rules below send it back to the contractor with a fresh one.
  if (!OPEN_STATUSES.includes(from) && OPEN_STATUSES.includes(toStatus)) {
    db.prepare('UPDATE hazards SET due_at = NULL, escalation_level = 0, last_escalated_at = NULL WHERE id = ?').run(hazard.id);
  }
  addEvent(db, hazard.id, actorId, type || 'status_change', { from, to: toStatus, note, at: now });

  // The person who first found it gets rewarded when it's fixed, once.
  if (firstResolution && hazard.discovered_by) awardPoints(db, hazard.discovered_by, config.points.hazardFixed);

  const fresh = db.prepare('SELECT * FROM hazards WHERE id = ?').get(hazard.id);
  const priority = computePriority(fresh, now);
  db.prepare('UPDATE hazards SET priority = ? WHERE id = ?').run(priority, hazard.id);
  const result = { ...fresh, priority };
  if (toStatus === 'reported' || toStatus === 'verified') return accountability().maybeAutoAssign(db, result, now);
  return result;
}

/** Inserts one sighting row for `hazard` and recomputes its aggregates. */
function insertSighting(db, user, hazard, r, detectedAt, now) {
  const info = db
    .prepare(
      `INSERT INTO reports (client_id, hazard_id, user_id, type, source, lat, lng, accuracy, heading, speed,
                            confidence, shock, severity_score, severity_level, road_name, area, image, note,
                            detected_at, created_at)
       VALUES (@clientId, @hazardId, @userId, @type, @source, @latitude, @longitude, @accuracy, @heading, @speed,
               @confidence, @shock, @severityScore, @severityLevel, @roadName, @area, @image, @note, @detectedAt, @now)`
    )
    .run({
      clientId: r.clientId || null,
      hazardId: hazard.id,
      userId: user.id,
      type: r.type || hazard.type,
      source: r.source,
      latitude: r.latitude,
      longitude: r.longitude,
      accuracy: r.accuracy ?? null,
      heading: r.heading ?? null,
      speed: r.speed || 0,
      confidence: r.confidence || 0,
      shock: r.shock || 0,
      severityScore: r.severityScore,
      severityLevel: severityLevel(r.severityScore),
      roadName: cleanRoadName(r.roadName),
      area: cleanRoadName(r.area),
      image: r.image || null,
      note: r.note || null,
      detectedAt,
      now,
    });
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * What a new sighting does to a hazard's lifecycle: resets clean passes, reopens a fixed
 * hazard, auto-verifies once enough different drivers saw it, and routes it to a contractor.
 */
function afterSighting(db, hazardId, actorId, detectedAt, now) {
  // A fresh sighting resets "nobody felt anything here" evidence.
  db.prepare('UPDATE hazards SET clean_passes = 0 WHERE id = ?').run(hazardId);
  let hazard = recomputeHazard(db, hazardId, now);

  if (hazard.status === 'resolved' && hazard.resolved_at && detectedAt > hazard.resolved_at + config.hazard.reopenGraceMs) {
    db.prepare('UPDATE hazards SET reopen_count = reopen_count + 1 WHERE id = ?').run(hazard.id);
    hazard = setStatus(db, { ...hazard, reopen_count: hazard.reopen_count + 1 }, 'reported', actorId, {
      type: 'reopened',
      note: 'Spotted again after it was marked fixed.',
      now,
    });
  }
  if (hazard.status === 'reported' && hazard.unique_reporters >= config.hazard.autoVerifyReporters) {
    hazard = setStatus(db, hazard, 'verified', null, {
      type: 'auto_verified',
      note: `Confirmed by ${hazard.unique_reporters} different drivers.`,
      now,
    });
  }
  return accountability().maybeAutoAssign(db, hazard, now);
}

/**
 * How far apart two sightings can be and still be the same hazard. GPS error and the second or
 * two it takes to react (5 to 15 m at city speeds) both widen it; a manual tap is always late.
 */
function mergeRadiusFor(r) {
  const base = config.hazard.mergeRadiusMeters;
  const acc = Number.isFinite(r.accuracy) ? r.accuracy : 10;
  const radius = Math.min(30, Math.max(base, acc * 1.5));
  return r.source === 'manual' ? radius + 10 : radius;
}

/**
 * A driver tapping "Report" again within a minute, close to their last report, is pointing at
 * the same pothole (or one right next to it), not finding a new one.
 */
function sameTapBurst(db, user, r, now) {
  if (r.source !== 'manual') return null;
  const last = db
    .prepare(
      `SELECT r.lat AS lat, r.lng AS lng, r.hazard_id AS hazardId FROM reports r JOIN hazards h ON h.id = r.hazard_id
       WHERE r.user_id = ? AND r.source = 'manual' AND r.created_at > ? AND h.type = ?
       ORDER BY r.created_at DESC LIMIT 1`
    )
    .get(user.id, now - 60000, r.type);
  if (!last || distanceMeters(last.lat, last.lng, r.latitude, r.longitude) > 50) return null;
  return db.prepare('SELECT * FROM hazards WHERE id = ?').get(last.hazardId);
}

/**
 * Ingests one sighting. Idempotent on clientId: the app retries uploads from its offline queue,
 * so the same sighting may arrive twice.
 */
function ingestReport(db, user, r, now = Date.now()) {
  return db.transaction(() => {
    if (r.clientId) {
      const existing = db.prepare('SELECT * FROM reports WHERE client_id = ?').get(r.clientId);
      if (existing) {
        const hazard = db.prepare('SELECT * FROM hazards WHERE id = ?').get(existing.hazard_id);
        return { report: existing, hazard, isNewHazard: false, pointsAwarded: 0, duplicate: true };
      }
    }

    const detectedAt = Math.min(r.timestamp || now, now);
    let hazard = sameTapBurst(db, user, r, now) || findNearbyHazard(db, r.type, r.latitude, r.longitude, mergeRadiusFor(r));
    let isNewHazard = false;

    if (!hazard) {
      const info = db
        .prepare(
          `INSERT INTO hazards (type, lat, lng, road_name, status, discovered_by, first_reported_at,
                                last_reported_at, updated_at)
           VALUES (?, ?, ?, ?, 'reported', ?, ?, ?, ?)`
        )
        .run(r.type, r.latitude, r.longitude, cleanRoadName(r.roadName), user.id, detectedAt, detectedAt, now);
      hazard = db.prepare('SELECT * FROM hazards WHERE id = ?').get(info.lastInsertRowid);
      isNewHazard = true;
      addEvent(db, hazard.id, user.id, 'created', { to: 'reported', at: now });
    }

    const alreadyReportedByUser = !isNewHazard &&
      !!db.prepare('SELECT 1 FROM reports WHERE hazard_id = ? AND user_id = ? LIMIT 1').get(hazard.id, user.id);

    const report = insertSighting(db, user, hazard, r, detectedAt, now);
    hazard = afterSighting(db, hazard.id, user.id, detectedAt, now);

    let pointsAwarded = 0;
    if (isNewHazard) pointsAwarded = config.points.newHazard;
    else if (!alreadyReportedByUser) pointsAwarded = config.points.confirmHazard;
    awardPoints(db, user.id, pointsAwarded);

    return { report, hazard, isNewHazard, pointsAwarded, duplicate: false };
  })();
}

/** "Still there", "It's fixed", or a passive clean pass from the drive-mode app. */
function castVote(db, hazardId, user, vote, now = Date.now()) {
  return db.transaction(() => {
    let hazard = db.prepare('SELECT * FROM hazards WHERE id = ?').get(hazardId);
    if (!hazard) return null;

    const prior = db
      .prepare(`SELECT 1 FROM hazard_votes WHERE hazard_id = ? AND user_id = ? AND vote = ? AND created_at > ? LIMIT 1`)
      .get(hazardId, user.id, vote, now - 6 * 3600 * 1000);
    if (prior && vote !== 'pass') return { hazard, pointsAwarded: 0, duplicate: true };

    db.prepare('INSERT INTO hazard_votes (hazard_id, user_id, vote, created_at) VALUES (?, ?, ?, ?)').run(
      hazardId, user.id, vote, now
    );

    let pointsAwarded = 0;
    if (vote === 'pass') {
      db.prepare('UPDATE hazards SET clean_passes = clean_passes + 1, updated_at = ? WHERE id = ?').run(now, hazardId);
    } else {
      pointsAwarded = config.points.vote;
      awardPoints(db, user.id, pointsAwarded);
      addEvent(db, hazardId, user.id, vote === 'fixed' ? 'vote_fixed' : 'vote_present', { at: now });
    }

    if (vote === 'present') {
      db.prepare('UPDATE hazards SET clean_passes = 0, updated_at = ? WHERE id = ?').run(now, hazardId);
    }

    hazard = db.prepare('SELECT * FROM hazards WHERE id = ?').get(hazardId);

    // "It's back": a driver says a fixed hazard has returned.
    if (vote === 'present' && hazard.status === 'resolved') {
      db.prepare('UPDATE hazards SET reopen_count = reopen_count + 1 WHERE id = ?').run(hazardId);
      hazard = setStatus(db, { ...hazard, reopen_count: hazard.reopen_count + 1 }, 'reported', user.id, {
        type: 'reopened',
        note: 'A driver says it has come back.',
        now,
      });
    }

    if (vote === 'fixed' && OPEN_STATUSES.includes(hazard.status)) {
      // Only count "fixed" votes newer than the latest evidence that it still exists.
      const lastPresent = db
        .prepare(`SELECT MAX(created_at) t FROM hazard_votes WHERE hazard_id = ? AND vote = 'present'`)
        .get(hazardId).t || 0;
      const since = Math.max(hazard.last_reported_at, lastPresent);
      const fixedVoters = db
        .prepare(
          `SELECT COUNT(DISTINCT user_id) n FROM hazard_votes WHERE hazard_id = ? AND vote = 'fixed' AND created_at > ?`
        )
        .get(hazardId, since).n;
      if (fixedVoters >= config.hazard.communityResolveVotes) {
        hazard = setStatus(db, hazard, 'resolved', null, {
          type: 'community_resolved',
          resolvedBy: 'community',
          note: `${fixedVoters} drivers reported it fixed.`,
          now,
        });
      }
    }
    return { hazard, pointsAwarded, duplicate: false };
  })();
}

function imageUrl(base, file) {
  return file ? `${base}/uploads/${file}` : null;
}

/**
 * Per-request memo for the contractor and road segment each hazard points at.
 * Pass the same object to every serializeHazard call in one response.
 */
function lookups(db) {
  const contractors = new Map();
  const segments = new Map();
  const getC = db.prepare('SELECT * FROM contractors WHERE id = ?');
  const getS = db.prepare('SELECT * FROM road_segments WHERE id = ?');
  return {
    contractor(id) {
      if (!id) return null;
      if (!contractors.has(id)) contractors.set(id, getC.get(id) || null);
      return contractors.get(id);
    },
    segment(id) {
      if (!id) return null;
      if (!segments.has(id)) segments.set(id, getS.get(id) || null);
      return segments.get(id);
    },
  };
}

/** Whole days past the deadline (at least 1 once it has passed), 0 when not overdue or closed. */
function overdueDays(h, now = Date.now()) {
  if (!h.due_at || !OPEN_STATUSES.includes(h.status) || now <= h.due_at) return 0;
  return Math.max(1, Math.floor((now - h.due_at) / DAY));
}

function serializeHazard(h, base, extra = {}, lk = null) {
  const c = lk ? lk.contractor(h.contractor_id) : null;
  const seg = lk ? lk.segment(h.segment_id) : null;
  return {
    id: h.id,
    type: h.type,
    latitude: h.lat,
    longitude: h.lng,
    roadName: h.road_name,
    area: h.area,
    status: h.status,
    severityScore: h.severity_score,
    severityLevel: h.severity_level,
    avgConfidence: Math.round((h.avg_confidence || 0) * 1000) / 1000,
    maxShock: h.max_shock,
    avgSpeed: Math.round((h.avg_speed || 0) * 10) / 10,
    reportCount: h.report_count,
    uniqueReporters: h.unique_reporters,
    cleanPasses: h.clean_passes,
    likelyFixed: OPEN_STATUSES.includes(h.status) && h.clean_passes >= config.hazard.likelyFixedPasses,
    reopenCount: h.reopen_count,
    priority: h.priority,
    imageUrl: imageUrl(base, h.cover_image),
    assignedTeam: h.assigned_team,
    firstReportedAt: h.first_reported_at,
    lastReportedAt: h.last_reported_at,
    resolvedAt: h.resolved_at,
    resolvedBy: h.resolved_by,
    updatedAt: h.updated_at,
    contractor: c ? { id: c.id, name: c.name, phone: c.phone } : null,
    segment: seg
      ? {
          id: seg.id,
          tenderId: seg.tender_id,
          officerName: seg.officer_name,
          officerContact: seg.officer_contact,
          ward: seg.ward,
          slaDays: seg.sla_days,
          warrantyUntil: seg.warranty_until,
        }
      : null,
    dueAt: h.due_at ?? null,
    overdueDays: overdueDays(h),
    escalationLevel: h.escalation_level || 0,
    underWarranty: !!h.under_warranty,
    repairImageUrl: imageUrl(base, h.repair_image),
    publicUrl: `${base}/h/${h.id}`,
    ...extra,
  };
}

function serializeReport(r, base, hazard) {
  return {
    id: r.id,
    clientId: r.client_id,
    hazardId: r.hazard_id,
    type: r.type,
    source: r.source,
    latitude: r.lat,
    longitude: r.lng,
    accuracy: r.accuracy,
    speed: r.speed,
    confidence: r.confidence,
    shock: r.shock,
    severityScore: r.severity_score,
    severityLevel: r.severity_level,
    severity: r.severity_level,
    roadName: r.road_name || (hazard && hazard.road_name) || null,
    imageUrl: imageUrl(base, r.image),
    note: r.note,
    timestamp: r.detected_at,
    createdAt: r.created_at,
    hazardStatus: hazard ? hazard.status : undefined,
    hazardReportCount: hazard ? hazard.report_count : undefined,
  };
}

module.exports = {
  DAY,
  cleanRoadName,
  cleanStoredRoadNames,
  mergeRadiusFor,
  STATUSES,
  OPEN_STATUSES,
  TYPES,
  TYPE_LABELS,
  severityLevel,
  computePriority,
  levelFor,
  findNearbyHazard,
  findNearestAnyType,
  recomputeHazard,
  insertSighting,
  afterSighting,
  ingestReport,
  castVote,
  setStatus,
  addEvent,
  awardPoints,
  lookups,
  overdueDays,
  imageUrl,
  serializeHazard,
  serializeReport,
};
