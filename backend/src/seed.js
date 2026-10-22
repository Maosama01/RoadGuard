'use strict';

/**
 * Fills the database with realistic DEMO data around Dehradun so the dashboard and app have
 * something to show on first run. Every demo account uses the @demo.roadguard email domain.
 *   npm run seed            (only when the database has no hazards)
 *   npm run seed -- --force (adds demo data anyway)
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');
const H = require('./hazards');
const A = require('./accountability');
const C = require('./coverage');
const S = require('./sensors');
const { ensureStaff } = require('./createAdmin');

const ROADS = [
  { name: 'Rajpur Road', from: [30.3256, 78.0437], to: [30.3720, 78.0780] },
  { name: 'Chakrata Road', from: [30.3248, 78.0405], to: [30.3330, 77.9930] },
  { name: 'Haridwar Road', from: [30.3190, 78.0450], to: [30.2930, 78.0720] },
  { name: 'GMS Road', from: [30.3280, 78.0030], to: [30.3050, 78.0200] },
  { name: 'Saharanpur Road', from: [30.3150, 78.0300], to: [30.2900, 77.9950] },
  { name: 'Bidholi Road (UPES)', from: [30.3500, 77.9600], to: [30.4160, 77.9670] },
  { name: 'Sahastradhara Road', from: [30.3330, 78.0600], to: [30.3700, 78.1050] },
  { name: 'Prem Nagar Bazaar', from: [30.3330, 77.9600], to: [30.3360, 77.9450] },
];
const TEAMS = ['Ward 12 Crew', 'PWD North', 'Night Patch Unit'];

// Clearly fictional contractors, officers and tender numbers (DEMO/...).
const CONTRACTORS = [
  { name: 'Shivalik Roadworks (demo)', phone: '+91 90000 00101', email: 'shivalik@demo.roadguard' },
  { name: 'Doon Valley Infra (demo)', phone: '+91 90000 00102', email: 'doonvalley@demo.roadguard' },
  { name: 'Rispana Constructions (demo)', phone: '+91 90000 00103', email: 'rispana@demo.roadguard' },
];
// warranty: days from now (negative = expired). bbox limits a segment to part of a road.
const SEGMENTS = [
  { road: 'Rajpur Road', c: 0, ward: 'Ward 12 (demo)', officer: 'Assistant Engineer, PWD North (demo)', contact: 'ae.north@demo.roadguard', tender: 'DEMO/DDN/PWD/2026/014', sla: 7, warranty: 160 },
  { road: 'Rajpur Road', c: 1, ward: 'Ward 9 (demo)', officer: 'Junior Engineer, PWD North (demo)', contact: 'je.rajpur@demo.roadguard', tender: 'DEMO/DDN/PWD/2025/203', sla: 10, warranty: null, bbox: [30.352, 78.055, 30.375, 78.080] },
  { road: 'Chakrata Road', c: 1, ward: 'Ward 7 (demo)', officer: 'Assistant Engineer, MDDA (demo)', contact: 'ae.mdda@demo.roadguard', tender: 'DEMO/DDN/MDDA/2026/031', sla: 7, warranty: -30 },
  { road: 'Haridwar Road', c: 2, ward: 'Ward 21 (demo)', officer: 'Executive Engineer, NH Division (demo)', contact: 'ee.nh@demo.roadguard', tender: 'DEMO/DDN/NH/2026/007', sla: 5, warranty: 400 },
  { road: 'GMS Road', c: 2, ward: 'Ward 18 (demo)', officer: 'Assistant Engineer, PWD South (demo)', contact: 'ae.south@demo.roadguard', tender: 'DEMO/DDN/PWD/2026/022', sla: 7, warranty: null },
  { road: 'Saharanpur Road', c: 0, ward: 'Ward 24 (demo)', officer: 'Assistant Engineer, PWD South (demo)', contact: 'ae.south@demo.roadguard', tender: 'DEMO/DDN/PWD/2025/188', sla: 14, warranty: null },
  { road: 'Bidholi Road', c: 1, ward: 'Ward 3 (demo)', officer: 'Assistant Engineer, PMGSY (demo)', contact: 'ae.pmgsy@demo.roadguard', tender: 'DEMO/DDN/PMGSY/2026/005', sla: 10, warranty: 300 },
  { road: 'Sahastradhara Road', c: 0, ward: 'Ward 15 (demo)', officer: 'Assistant Engineer, PWD North (demo)', contact: 'ae.north@demo.roadguard', tender: 'DEMO/DDN/PWD/2026/041', sla: 7, warranty: null },
];

/** Illustrations (not photos) for the before/after demo, clearly labelled. */
function demoImage(kind, i) {
  const holes = [[150, 140, 70, 36], [190, 120, 54, 30], [130, 150, 80, 34]][i % 3];
  const [cx, cy, rx, ry] = holes;
  const mark = kind === 'before'
    ? `<ellipse cx="${cx}" cy="${cy}" rx="${rx + 6}" ry="${ry + 5}" fill="#2b3038"/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#0e1013"/><ellipse cx="${cx - 8}" cy="${cy + 6}" rx="${rx * 0.5}" ry="${ry * 0.4}" fill="#3a3f46" opacity=".6"/>`
    : `<rect x="${cx - rx - 14}" y="${cy - ry - 12}" width="${rx * 2 + 28}" height="${ry * 2 + 24}" rx="4" fill="#15181c"/><rect x="${cx - rx - 14}" y="${cy - ry - 12}" width="${rx * 2 + 28}" height="${ry * 2 + 24}" rx="4" fill="none" stroke="#2e333a" stroke-width="3"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="800" height="600">
<rect width="400" height="300" fill="#262a30"/>
<rect x="0" y="236" width="400" height="6" fill="#F2C230" opacity=".9"/>
<g fill="#F2C230">${[0, 1, 2, 3].map((k) => `<rect x="${k * 110 + 10}" y="262" width="60" height="6"/>`).join('')}</g>
${mark}
<rect x="278" y="10" width="112" height="24" rx="12" fill="#1C2026" opacity=".85"/>
<text x="334" y="27" font-family="Barlow, sans-serif" font-size="13" fill="#fff" text-anchor="middle">Demo image</text>
</svg>`;
}

function writeDemoImage(kind, i) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const file = `demo-${kind}-${i}.svg`;
  fs.writeFileSync(path.join(config.uploadDir, file), demoImage(kind, i));
  return file;
}

function seedAccountability(db, now) {
  const DAY = 86400000;
  const ids = CONTRACTORS.map((c) => {
    const r = A.findOrCreateContractor(db, c.name, now - 60 * DAY);
    db.prepare('UPDATE contractors SET phone = ?, email = ? WHERE id = ?').run(c.phone, c.email, r.contractor.id);
    return r.contractor.id;
  });
  if (db.prepare('SELECT COUNT(*) n FROM road_segments').get().n) return ids;
  for (const s of SEGMENTS) {
    A.insertSegment(db, {
      road_pattern: s.road,
      ward: s.ward,
      contractor_id: ids[s.c],
      officer_name: s.officer,
      officer_contact: s.contact,
      tender_id: s.tender,
      sla_days: s.sla,
      warranty_until: s.warranty === null ? null : now + s.warranty * DAY,
      min_lat: s.bbox ? s.bbox[0] : null,
      min_lng: s.bbox ? s.bbox[1] : null,
      max_lat: s.bbox ? s.bbox[2] : null,
      max_lng: s.bbox ? s.bbox[3] : null,
      now: now - 60 * DAY,
    });
  }
  return ids;
}

/** Straight-line demo drive along a road, one point every ~40 m. */
function drivePath(road, start, speedKmh, reverse) {
  const [a, b] = reverse ? [road.to, road.from] : [road.from, road.to];
  const km = Math.hypot((b[0] - a[0]) * 111, (b[1] - a[1]) * 96);
  const n = Math.max(2, Math.round((km * 1000) / 40));
  const msPerPoint = (40 / 1000 / speedKmh) * 3600000;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, Math.round(start + i * msPerPoint)]);
  }
  return { path: pts, km, endedAt: pts[pts.length - 1][2] };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function seed(db, { force = false } = {}) {
  const existing = db.prepare('SELECT COUNT(*) n FROM hazards').get().n;
  if (existing && !force) return { skipped: true, existing };

  const rand = rng(42);
  const now = Date.now();
  const DAY = 86400000;

  const admin = ensureStaff(db, { email: 'admin@demo.roadguard', password: 'roadguard123', name: 'Demo City Admin', role: 'admin' });
  ensureStaff(db, { email: 'crew@demo.roadguard', password: 'roadguard123', name: 'Ward 12 Supervisor', role: 'authority' });
  const adminId = admin.id || db.prepare('SELECT id FROM users WHERE email = ?').get('admin@demo.roadguard').id;

  const names = ['Aarav Mehta', 'Diya Rawat', 'Kabir Negi', 'Ishita Bisht', 'Rohan Thapa', 'Meera Joshi', 'Arjun Panwar', 'Sara Khan'];
  const hash = bcrypt.hashSync('roadguard123', 10);
  const users = names.map((name, i) => {
    const email = `${name.split(' ')[0].toLowerCase()}@demo.roadguard`;
    const found = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (found) return found;
    const info = db
      .prepare(`INSERT INTO users (name, email, password_hash, role, city, created_at) VALUES (?, ?, ?, 'citizen', 'Dehradun', ?)`)
      .run(name, email, hash, now - (40 - i) * DAY);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  });

  seedAccountability(db, now);

  let created = 0;
  let repairs = 0;
  const repaired = [];
  for (let i = 0; i < 46; i++) {
    const road = ROADS[i % ROADS.length];
    const t = rand();
    const lat = road.from[0] + (road.to[0] - road.from[0]) * t + (rand() - 0.5) * 0.0004;
    const lng = road.from[1] + (road.to[1] - road.from[1]) * t + (rand() - 0.5) * 0.0004;
    const type = rand() < 0.82 ? 'pothole' : 'drain_hole';
    const baseSeverity = 25 + rand() * 70;
    const sightings = 1 + Math.floor(rand() ** 1.6 * 9);
    const firstAt = now - Math.floor(rand() * 20 * DAY) - DAY;

    let hazard = null;
    for (let s = 0; s < sightings; s++) {
      const user = users[Math.floor(rand() * users.length)];
      let at = firstAt + Math.floor(s * rand() * 2.5 * DAY);
      if (at > now - 60000) at = Math.max(firstAt, now - 60000 - Math.floor(rand() * 4 * DAY));
      const result = H.ingestReport(
        db,
        user,
        {
          clientId: `demo-${i}-${s}`,
          type,
          source: rand() < 0.9 ? 'auto' : 'manual',
          latitude: lat + (rand() - 0.5) * 0.00008,
          longitude: lng + (rand() - 0.5) * 0.00008,
          accuracy: 4 + rand() * 12,
          speed: 15 + rand() * 45,
          confidence: 0.58 + rand() * 0.4,
          shock: rand() < 0.75 ? 6 + rand() * 12 : 0,
          severityScore: Math.min(99, Math.max(10, baseSeverity + (rand() - 0.5) * 18)),
          roadName: road.name,
          timestamp: at,
        },
        at
      );
      hazard = result.hazard;
    }
    created++;

    // Give the city's workflow some history.
    const roll = rand();
    const later = (d) => Math.min(now - 30000, hazard.last_reported_at + d * DAY);
    if (roll < 0.22 && hazard.contractor_id) {
      // The contractor fixed it and sent proof: before and after.
      const at = later(1 + rand() * 4);
      const before = writeDemoImage('before', repairs);
      const after = writeDemoImage('after', repairs);
      repairs++;
      db.prepare('UPDATE hazards SET cover_image = ?, repair_image = ? WHERE id = ?').run(before, after, hazard.id);
      hazard = H.setStatus(db, { ...hazard, repair_image: after }, 'resolved', adminId, {
        type: 'repaired', resolvedBy: 'contractor', note: 'Pothole cut square, filled with hot mix and rolled.', now: at,
      });
      repaired.push({ hazard, at });
    } else if (roll < 0.22) {
      hazard = H.setStatus(db, hazard, 'resolved', adminId, { note: 'Patched and compacted. Closed without repair photo.', resolvedBy: 'authority', now: later(1 + rand() * 3) });
    } else if (roll < 0.34 && hazard.status === 'assigned') {
      hazard = H.setStatus(db, hazard, 'in_progress', adminId, { note: 'Crew on site.', now: later(0.5) });
    } else if (hazard.status === 'assigned') {
      // Already sent to the road's contractor automatically.
    } else if (roll < 0.34) {
      db.prepare('UPDATE hazards SET assigned_team = ? WHERE id = ?').run(TEAMS[i % TEAMS.length], hazard.id);
      hazard = H.setStatus(db, hazard, 'in_progress', adminId, { note: 'Crew on site.', now: later(0.5) });
    } else if (roll < 0.48) {
      db.prepare('UPDATE hazards SET assigned_team = ? WHERE id = ?').run(TEAMS[i % TEAMS.length], hazard.id);
      hazard = H.setStatus(db, hazard, 'assigned', adminId, { note: `Assigned to ${TEAMS[i % TEAMS.length]}`, now: later(0.3) });
    } else if (roll < 0.52) {
      hazard = H.setStatus(db, hazard, 'rejected', adminId, { note: 'Speed breaker, not a pothole.', now: later(0.2) });
    } else if (roll < 0.58) {
      db.prepare('UPDATE hazards SET clean_passes = ? WHERE id = ?').run(5 + Math.floor(rand() * 6), hazard.id);
    }
  }

  // Cracked surfaces seen by the camera (precursors to potholes).
  const crackSpots = [[ROADS[0], 0.62], [ROADS[3], 0.35], [ROADS[4], 0.7], [ROADS[5], 0.2]];
  crackSpots.forEach(([road, t], k) => {
    const lat = road.from[0] + (road.to[0] - road.from[0]) * t + 0.00012;
    const lng = road.from[1] + (road.to[1] - road.from[1]) * t;
    for (let s = 0; s < 1 + (k % 2); s++) {
      const at = now - (3 + k * 2 - s) * DAY;
      H.ingestReport(db, users[(k + s * 3) % users.length], {
        clientId: `demo-crack-${k}-${s}`, type: 'crack', source: 'auto',
        latitude: lat + s * 0.00003, longitude: lng, accuracy: 6, speed: 30 + k * 4, confidence: 0.66 + s * 0.1,
        shock: 2.5, severityScore: 32 + k * 6 + s * 4, roadName: road.name, timestamp: at,
      }, at);
    }
  });

  // A repair that did not hold: spotted again, so it counts against the contractor.
  if (repaired.length) {
    const { hazard: h, at } = repaired[0];
    const again = Math.min(now - 2 * DAY, at + 6 * DAY);
    H.ingestReport(db, users[3], {
      clientId: 'demo-reopen-0', type: h.type, source: 'auto', latitude: h.lat, longitude: h.lng, accuracy: 5,
      speed: 34, confidence: 0.81, shock: 11, severityScore: 64, roadName: h.road_name, timestamp: again,
    }, again);
  }

  // Deadlines pass day by day, so escalations land on the right dates in each history.
  for (let t = now - 25 * DAY; t <= now; t += DAY / 2) A.escalate(db, t);
  A.escalate(db, now);

  // Drives: demo drivers covering most roads over the last few weeks. Sahastradhara Road was
  // last driven over a month ago, so it shows up as "not checked recently".
  let drives = 0;
  users.forEach((u, ui) => {
    for (let k = 0; k < 5; k++) {
      const road = ROADS[(ui + k * 3) % ROADS.length];
      const stale = road.name === 'Sahastradhara Road';
      const start = now - (stale ? 34 + k : 1 + ((ui * 5 + k * 7) % 26)) * DAY - Math.floor(rand() * 8) * 3600000;
      const speed = 22 + rand() * 25;
      const d = drivePath(road, start, speed, k % 2 === 1);
      const r = C.ingestDrive(db, u, {
        clientId: `demo-drive-${ui}-${k}`, mode: rand() < 0.6 ? 'camera' : 'pocket', startedAt: start, endedAt: d.endedAt,
        distanceMeters: Math.round(d.km * 1000), path: d.path,
      }, now);
      if (!r.duplicate) drives++;
    }
  });

  // Rough patches felt by three different drivers in pocket mode, then promoted to hazards.
  let bumps = 0;
  [[ROADS[3], 0.52], [ROADS[2], 0.31], [ROADS[3], 0.15]].forEach(([road, t0], k) => {
    for (let attempt = 0; attempt < 6 && bumps <= k; attempt++) {
      const t = t0 + attempt * 0.04;
      const lat = road.from[0] + (road.to[0] - road.from[0]) * t - 0.00018;
      const lng = road.from[1] + (road.to[1] - road.from[1]) * t;
      if (H.findNearestAnyType(db, lat, lng, 25)) continue;
      for (let ui = 0; ui < 3; ui++) {
        const r = S.ingestSensorHits(db, users[(k * 3 + ui + 1) % users.length], [{
          clientId: `demo-hit-${k}-${attempt}-${ui}`, latitude: lat + ui * 0.00002, longitude: lng - ui * 0.00002,
          accuracy: 5 + ui, speed: 32 + ui * 6 + k * 8, heading: 120, shock: 8 + ui * 1.5 + k * 3, timestamp: now - (4 - ui) * DAY,
          roadName: road.name,
        }], now);
        bumps += r.promoted;
      }
    }
  });

  // Refresh priorities with real "now" (age matters).
  const rows = db.prepare('SELECT * FROM hazards').all();
  const upd = db.prepare('UPDATE hazards SET priority = ? WHERE id = ?');
  rows.forEach((h) => upd.run(H.computePriority(h, now), h.id));

  const counts = db
    .prepare(
      `SELECT SUM(contractor_id IS NOT NULL) assigned, SUM(escalation_level > 0 AND status IN ('reported','verified','assigned','in_progress')) overdue,
              SUM(under_warranty = 1) warranty FROM hazards`
    )
    .get();
  return { skipped: false, created, users: users.length, drives, bumps, repairs, ...counts };
}

if (require.main === module) {
  const db = require('./db').open();
  const r = seed(db, { force: process.argv.includes('--force') });
  if (r.skipped) {
    console.log(`Database already has ${r.existing} hazards. Use "npm run seed -- --force" to add demo data anyway.`);
  } else {
    console.log(`Demo data added: ${r.created} hazards from ${r.users} demo drivers around Dehradun.`);
    console.log(`  ${r.assigned} sent to demo contractors, ${r.overdue} overdue, ${r.warranty} under warranty, ${r.repairs} repaired with photos.`);
    console.log(`  ${r.drives} demo drives for the coverage map, ${r.bumps} rough patches from pocket mode.`);
    console.log('Dashboard login: admin@demo.roadguard / roadguard123');
    console.log('App demo login:  aarav@demo.roadguard / roadguard123');
  }
}

module.exports = { seed };
