'use strict';

/**
 * RoadGuard v3: pocket mode, coverage, accountability, public pages, road health, migration.
 * Runs in its own process with its own data directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-v3-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'v3.db');

const request = require('supertest');
const Database = require('better-sqlite3');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureStaff } = require('../src/createAdmin');
const A = require('../src/accountability');
const { sensorSeverity, ingestSensorHits } = require('../src/sensors');

const db = open(process.env.DB_FILE);
const app = createApp(db, { logging: false });
const DAY = 86400000;

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

// Each scenario gets its own spot, kilometres apart, so nothing merges by accident.
const ORIGIN = { lat: 30.2, lng: 78.1 };
const spot = (km) => ({ lat: ORIGIN.lat + km / 111.32, lng: ORIGIN.lng });
const metres = (m) => m / 111320;

async function guest(deviceId) {
  const res = await request(app).post('/api/auth/guest').send({ deviceId });
  assert.equal(res.status, 200);
  return { token: res.body.token, id: res.body.user.id };
}

let staffToken;
async function staff() {
  if (staffToken) return staffToken;
  ensureStaff(db, { email: 'ops@v3.gov', password: 'opspass123', name: 'Ops', role: 'authority' });
  staffToken = (await request(app).post('/api/auth/login').send({ email: 'ops@v3.gov', password: 'opspass123' })).body.token;
  return staffToken;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

function report(token, at, extra = {}) {
  return request(app)
    .post('/api/reports')
    .set(auth(token))
    .send({ latitude: at.lat, longitude: at.lng, confidence: 0.9, severityScore: 70, shock: 9, speed: 35, accuracy: 5, timestamp: Date.now(), ...extra });
}

let hitSeq = 0;
function hit(at, extra = {}) {
  hitSeq++;
  return { clientId: `hit-${hitSeq}-${Date.now()}`, latitude: at.lat, longitude: at.lng, accuracy: 6, speed: 40, heading: 90, shock: 10, timestamp: Date.now() - 60000, ...extra };
}
const sendHits = (token, hits) => request(app).post('/api/sensor-hits').set(auth(token)).send({ hits });
const points = (uid) => db.prepare('SELECT points FROM users WHERE id = ?').get(uid).points;
const hazardsNear = (at, m = 20) =>
  db
    .prepare('SELECT * FROM hazards WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
    .all(at.lat - metres(m), at.lat + metres(m), at.lng - metres(m) * 1.2, at.lng + metres(m) * 1.2);

async function segment(body) {
  const res = await request(app).post('/api/segments').set(auth(await staff())).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.segment;
}
async function contractor(name) {
  const res = await request(app).post('/api/contractors').set(auth(await staff())).send({ name, phone: '+91 90000 11111' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.contractor;
}
const detail = async (id) => (await request(app).get(`/api/hazards/${id}`)).body;

// ------------------------------------------------------------------ types

test('crack is reportable (with aliases); bump only comes from pocket mode', async () => {
  const u = await guest('v3-types-0001');
  const crack = await report(u.token, spot(1), { type: 'Cracked surface', severityScore: 35, roadName: 'Type Test Road' });
  assert.equal(crack.status, 201);
  assert.equal(crack.body.hazard.type, 'crack');
  assert.ok(crack.body.hazard.publicUrl.endsWith(`/h/${crack.body.hazardId}`));
  const bump = await report(u.token, spot(1.5), { type: 'bump' });
  assert.equal(bump.status, 400);
  assert.match(bump.body.message, /pocket mode/);
  const list = await request(app).get('/api/hazards?type=crack&status=all');
  assert.ok(list.body.items.some((h) => h.id === crack.body.hazardId));
});

// ------------------------------------------------------------------ pocket mode

test('sensor severity formula', () => {
  assert.equal(sensorSeverity(20, 80), 100);
  assert.equal(sensorSeverity(10, 40), 50);
  assert.equal(sensorSeverity(40, 200), 100);
  assert.equal(sensorSeverity(0, 0), 0);
  assert.equal(sensorSeverity(5, 20), 25);
});

test('two drivers make no hazard; the third distinct driver promotes a rough patch', async () => {
  const at = spot(10);
  const [u1, u2, u3] = [await guest('v3-bump-u1'), await guest('v3-bump-u2'), await guest('v3-bump-u3')];
  // The same driver twice is still one driver.
  let r = await sendHits(u1.token, [hit(at), hit({ lat: at.lat + metres(3), lng: at.lng })]);
  assert.equal(r.status, 200);
  const pick = (b) => ({ accepted: b.accepted, ignored: b.ignored, confirmed: b.confirmed, promoted: b.promoted, pointsAwarded: b.pointsAwarded });
  assert.deepEqual(pick(r.body), { accepted: 2, ignored: 0, confirmed: 0, promoted: 0, pointsAwarded: 0 });
  r = await sendHits(u2.token, [hit({ lat: at.lat + metres(8), lng: at.lng }, { shock: 14, speed: 60 })]);
  assert.equal(r.body.promoted, 0);
  assert.equal(hazardsNear(at).length, 0, 'two drivers are not enough');

  const p1 = points(u1.id);
  r = await sendHits(u3.token, [hit({ lat: at.lat - metres(5), lng: at.lng })]);
  assert.deepEqual(pick(r.body), { accepted: 1, ignored: 0, confirmed: 0, promoted: 1, pointsAwarded: 5 });
  assert.equal(points(u1.id), p1 + 5, 'every contributing driver earns the promotion bonus');

  const found = hazardsNear(at);
  assert.equal(found.length, 1);
  const h = found[0];
  assert.equal(h.type, 'bump');
  assert.equal(h.status, 'reported');
  assert.equal(h.report_count, 4);
  assert.equal(h.unique_reporters, 3);
  const reps = db.prepare('SELECT * FROM reports WHERE hazard_id = ?').all(h.id);
  assert.ok(reps.every((x) => x.source === 'sensor' && x.confidence === 0));
  assert.ok(reps.some((x) => x.severity_score === sensorSeverity(14, 60)));
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM sensor_hits WHERE lat BETWEEN ? AND ?').get(at.lat - 0.001, at.lat + 0.001).n,
    0,
    'promoted hits leave the waiting table'
  );
  const d = await detail(h.id);
  assert.equal(d.timeline[0].type, 'created');
  assert.match(d.timeline[0].note, /3 different drivers in pocket mode/);
});

test('a jolt next to a known hazard confirms it (points once per driver) and can reopen it', async () => {
  const at = spot(12);
  const cam = await guest('v3-confirm-cam');
  const created = await report(cam.token, at, { roadName: 'Confirm Test Road' });
  const id = created.body.hazardId;
  const pocket = await guest('v3-confirm-pocket');
  let r = await sendHits(pocket.token, [hit({ lat: at.lat + metres(6), lng: at.lng })]);
  assert.equal(r.body.confirmed, 1);
  assert.equal(r.body.pointsAwarded, 1);
  r = await sendHits(pocket.token, [hit({ lat: at.lat + metres(4), lng: at.lng })]);
  assert.equal(r.body.confirmed, 1);
  assert.equal(r.body.pointsAwarded, 0, 'only once per hazard per driver');
  let d = await detail(id);
  assert.equal(d.hazard.reportCount, 3);
  assert.equal(d.hazard.type, 'pothole', 'pocket mode does not change the type');
  assert.equal(d.reports.filter((x) => x.source === 'sensor').length, 2);

  // Fixed two hours ago, then a pocket-mode jolt: reopened, like a camera sighting.
  const t = await staff();
  await request(app).patch(`/api/hazards/${id}`).set(auth(t)).send({ status: 'resolved' });
  db.prepare('UPDATE hazards SET resolved_at = ?, clean_passes = 3 WHERE id = ?').run(Date.now() - 2 * 3600000, id);
  r = await sendHits(pocket.token, [hit(at)]);
  assert.equal(r.body.confirmed, 1);
  d = await detail(id);
  assert.equal(d.hazard.status, 'reported');
  assert.equal(d.hazard.reopenCount, 1);
  assert.equal(d.hazard.cleanPasses, 0, 'a sighting resets clean passes');
});

test('a rejected hazard absorbs jolts silently and no rough patch appears', async () => {
  const at = spot(14);
  const cam = await guest('v3-reject-cam');
  const created = await report(cam.token, at);
  const id = created.body.hazardId;
  await request(app).patch(`/api/hazards/${id}`).set(auth(await staff())).send({ status: 'rejected', note: 'Speed breaker' });
  for (let i = 0; i < 4; i++) {
    const u = await guest(`v3-reject-u${i}`);
    const r = await sendHits(u.token, [hit({ lat: at.lat + metres(5), lng: at.lng })]);
    assert.equal(r.body.accepted, 1);
    assert.equal(r.body.confirmed, 0);
    assert.equal(r.body.promoted, 0);
    assert.equal(r.body.pointsAwarded, 0);
  }
  const d = await detail(id);
  assert.equal(d.hazard.status, 'rejected');
  assert.equal(d.hazard.reportCount, 1);
  assert.equal(hazardsNear(at).length, 1);
});

test('sensor hits are idempotent on clientId and junk hits are ignored', async () => {
  const at = spot(16);
  const u = await guest('v3-idem-0001');
  const h1 = hit(at);
  const first = await sendHits(u.token, [h1]);
  assert.equal(first.body.accepted, 1);
  const again = await sendHits(u.token, [h1]);
  assert.equal(again.body.accepted, 1);
  assert.equal(again.body.duplicates, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sensor_hits WHERE client_id = ?').get(h1.clientId).n, 1);

  const junk = await sendHits(u.token, [
    hit(at, { speed: 6 }),
    hit(at, { accuracy: 45 }),
    hit(at, { timestamp: Date.now() - 15 * DAY }),
    hit(spot(16.5)),
  ]);
  assert.equal(junk.body.ignored, 3);
  assert.equal(junk.body.accepted, 1);

  // Promoted hits keep their clientId on the report, so a retry after promotion is still a duplicate.
  const at2 = spot(18);
  const sent = [];
  for (let i = 0; i < 3; i++) {
    const g = await guest(`v3-idem-p${i}`);
    const hh = hit(at2);
    sent.push([g, hh]);
    await sendHits(g.token, [hh]);
  }
  const [g0, hh0] = sent[0];
  const retry = await sendHits(g0.token, [hh0]);
  assert.equal(retry.body.duplicates, 1);
  assert.equal(retry.body.promoted, 0);
  assert.equal(hazardsNear(at2)[0].report_count, 3);

  assert.equal((await request(app).post('/api/sensor-hits').send({ hits: [hit(at)] })).status, 401);
  const tooMany = await sendHits(u.token, Array.from({ length: 201 }, () => hit(at)));
  assert.equal(tooMany.status, 400);
});

// ------------------------------------------------------------------ drives and coverage

test('drives mark coverage cells once per drive, idempotently; stats count km', async () => {
  const u = await guest('v3-drive-0001');
  const start = Date.now() - 3600000;
  // ~40 m apart along a meridian: 12 points cover a handful of 0.001 degree cells.
  const pathPts = Array.from({ length: 12 }, (_, i) => [30.4001 + i * 0.00036, 78.2001, start + i * 5000]);
  pathPts.push([30.4001, 78.2001, start + 70000]); // back into the first cell: still one scan for this drive
  const body = { clientId: 'drive-aaaa-0001', mode: 'pocket', startedAt: start, endedAt: start + 80000, distanceMeters: 440, path: pathPts };
  const r1 = await request(app).post('/api/drives').set(auth(u.token)).send(body);
  assert.equal(r1.status, 201);
  const key = ([la, ln]) => `${(Math.round(la * 1000) / 1000).toFixed(3)},${(Math.round(ln * 1000) / 1000).toFixed(3)}`;
  const cellCount = new Set(pathPts.map(key)).size;
  assert.ok(cellCount >= 4);
  assert.equal(r1.body.cells, cellCount);
  assert.equal(r1.body.distanceMeters, 440);

  const r2 = await request(app).post('/api/drives').set(auth(u.token)).send(body);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicate, true);
  assert.equal(r2.body.cells, cellCount);

  const bbox = '78.19,30.39,78.21,30.42';
  let cov = await request(app).get(`/api/coverage?bbox=${bbox}&days=30`);
  assert.equal(cov.body.cells.length, cellCount);
  assert.ok(cov.body.cells.every((c) => c.scans === 1 && c.lastScannedAt >= start));
  assert.deepEqual(Object.keys(cov.body.cells[0]).sort(), ['lastScannedAt', 'lat', 'lng', 'scans']);

  await request(app).post('/api/drives').set(auth(u.token)).send({ ...body, clientId: 'drive-aaaa-0002', mode: 'camera' });
  cov = await request(app).get(`/api/coverage?bbox=${bbox}`);
  assert.ok(cov.body.cells.every((c) => c.scans === 2));
  assert.equal(db.prepare("SELECT last_mode FROM coverage_cells WHERE cell_key = '30.400,78.200'").get().last_mode, 'camera');

  // An old drive elsewhere is not "scanned in the last 30 days".
  const old = Date.now() - 40 * DAY;
  await request(app).post('/api/drives').set(auth(u.token)).send({
    clientId: 'drive-old-00001', mode: 'camera', startedAt: old, endedAt: old + 60000, distanceMeters: 1000, path: [[30.5, 78.3, old]],
  });
  assert.equal((await request(app).get('/api/coverage?bbox=78.29,30.49,78.31,30.51&days=30')).body.cells.length, 0);
  assert.equal((await request(app).get('/api/coverage?bbox=78.29,30.49,78.31,30.51&days=60')).body.cells.length, 1);

  const me = await request(app).get('/api/stats/me').set(auth(u.token));
  assert.equal(me.body.stats.drives, 3);
  assert.equal(me.body.stats.kmScanned, 1.9);
  const ov = await request(app).get('/api/stats/overview');
  assert.ok(ov.body.totals.kmScanned30d >= 0.8);
  assert.equal(ov.body.kmScanned30d, ov.body.totals.kmScanned30d);

  const bad = await request(app).post('/api/drives').set(auth(u.token)).send({ ...body, clientId: 'drive-bad-0001', endedAt: start - 1 });
  assert.equal(bad.status, 400);
  assert.equal((await request(app).post('/api/drives').send(body)).status, 401);
  assert.equal((await request(app).get('/api/coverage?bbox=nonsense')).status, 400);
});

// ------------------------------------------------------------------ accountability

test('segment matching: bounding box beats none, longer pattern beats shorter', async () => {
  const [x, y, z] = [await contractor('Match X'), await contractor('Match Y'), await contractor('Match Z')];
  const p = spot(30);
  await segment({ roadPattern: 'Mallroad', contractorId: x.id });
  await segment({ roadPattern: 'Mallroad East', contractorId: y.id });
  await segment({
    roadPattern: 'Mallroad', contractorId: z.id,
    minLat: p.lat - 0.002, minLng: p.lng - 0.002, maxLat: p.lat + 0.002, maxLng: p.lng + 0.002,
  });
  const seg = (road, at) => A.matchSegment(db, { road_name: road, lat: at.lat, lng: at.lng });
  assert.equal(seg('Mallroad East', p).contractor_id, z.id, 'inside the box: the boxed segment wins');
  assert.equal(seg('Mallroad East', spot(31)).contractor_id, y.id, 'outside the box: longer pattern wins');
  assert.equal(seg('Old mallroad', spot(31)).contractor_id, x.id, 'case-insensitive substring');
  assert.equal(seg('Elsewhere Lane', p), null);
  assert.equal(seg(null, p), null);
});

test('auto-assignment on verification with SLA; critical gets half; low waits for verification', async () => {
  const c = await contractor('Assign Co');
  await segment({ roadPattern: 'Assign Test Road', contractorId: c.id, slaDays: 6, tenderId: 'T/ASSIGN/1', officerName: 'AE Assign' });
  const at = spot(40);
  let last;
  for (let i = 0; i < 3; i++) {
    const u = await guest(`v3-assign-${i}`);
    last = await report(u.token, at, { roadName: 'Assign Test Road', severityScore: 50 });
  }
  const h = last.body.hazard;
  assert.equal(h.status, 'assigned');
  assert.equal(h.contractor.name, 'Assign Co');
  assert.equal(h.segment.tenderId, 'T/ASSIGN/1');
  assert.equal(h.segment.officerName, 'AE Assign');
  assert.equal(h.segment.slaDays, 6);
  assert.equal(h.assignedTeam, 'Assign Co');
  assert.ok(Math.abs(h.dueAt - (Date.now() + 6 * DAY)) < 60000);
  assert.equal(h.overdueDays, 0);
  assert.equal(h.escalationLevel, 0);
  assert.equal(h.underWarranty, false);
  assert.equal(h.repairImageUrl, null);
  const d = await detail(h.id);
  const ev = d.timeline.find((e) => e.type === 'auto_assigned');
  assert.match(ev.note, /^Sent to Assign Co under tender T\/ASSIGN\/1\. Due \d{1,2} \w{3} \d{4}\.$/);
  assert.deepEqual(d.timeline.map((e) => e.type), ['created', 'auto_verified', 'auto_assigned']);

  const u = await guest('v3-assign-crit');
  const crit = await report(u.token, spot(41), { roadName: 'Assign Test Road', severityScore: 92 });
  assert.equal(crit.body.hazard.status, 'assigned', 'critical is sent straight away');
  assert.ok(Math.abs(crit.body.hazard.dueAt - (Date.now() + 3 * DAY)) < 60000, 'critical: half the SLA');

  const low = await report(u.token, spot(42), { roadName: 'Assign Test Road', severityScore: 25 });
  assert.equal(low.body.hazard.status, 'reported');
  assert.equal(low.body.hazard.contractor, null);
  assert.equal(low.body.hazard.dueAt, null);
  // ...until someone at the city verifies it.
  const v = await request(app).patch(`/api/hazards/${low.body.hazardId}`).set(auth(await staff())).send({ status: 'verified' });
  assert.equal(v.body.hazard.status, 'assigned');
  assert.equal(v.body.hazard.contractor.id, c.id);
  assert.ok(Math.abs(v.body.hazard.dueAt - (Date.now() + 6 * DAY)) < 60000);

  const list = await request(app).get(`/api/hazards?contractor=${c.id}&status=all`);
  assert.equal(list.body.total, 3);
});

test('warranty flag only while the warranty is valid', async () => {
  const c = await contractor('Warranty Co');
  await segment({ roadPattern: 'Warranty Live Road', contractorId: c.id, warrantyUntil: '2099-12-31', tenderId: 'T/W/1' });
  await segment({ roadPattern: 'Warranty Expired Road', contractorId: c.id, warrantyUntil: '2020-01-31' });
  const u = await guest('v3-warranty-1');
  const live = await report(u.token, spot(50), { roadName: 'Warranty Live Road', severityScore: 75 });
  assert.equal(live.body.hazard.underWarranty, true);
  assert.ok(live.body.hazard.segment.warrantyUntil > Date.UTC(2099, 11, 30));
  const note = (await detail(live.body.hazardId)).timeline.find((e) => e.type === 'auto_assigned').note;
  assert.match(note, /Under warranty: repair at no cost\.$/);
  const expired = await report(u.token, spot(51), { roadName: 'Warranty Expired Road', severityScore: 75 });
  assert.equal(expired.body.hazard.status, 'assigned');
  assert.equal(expired.body.hazard.underWarranty, false);
  const list = await request(app).get('/api/hazards?warranty=1');
  assert.ok(list.body.items.some((x) => x.id === live.body.hazardId));
  assert.ok(!list.body.items.some((x) => x.id === expired.body.hazardId));
  const bad = await request(app).post('/api/segments').set(auth(await staff())).send({ roadPattern: 'X Road', warrantyUntil: '31/12/2030' });
  assert.equal(bad.status, 400);
});

test('escalation levels rise as the deadline slips (time travel), with events and priority', async () => {
  const c = await contractor('Slow Co');
  await segment({ roadPattern: 'Escalation Road', contractorId: c.id, slaDays: 6, officerName: 'Executive Engineer Rao' });
  const u = await guest('v3-esc-1');
  const created = await report(u.token, spot(60), { roadName: 'Escalation Road', severityScore: 70 });
  const id = created.body.hazardId;
  const p0 = created.body.hazard.priority;
  const list = async () => (await request(app).get('/api/hazards?status=all&limit=1000')).body.items.find((h) => h.id === id);

  db.prepare('UPDATE hazards SET due_at = ? WHERE id = ?').run(Date.now() - 3600000, id);
  let h = await list();
  assert.equal(h.escalationLevel, 1);
  assert.equal(h.overdueDays, 1);
  assert.ok(h.priority >= Math.min(100, p0 + 10) - 0.2, `priority ${h.priority} should rise from ${p0}`);
  let d = await detail(id);
  let esc = d.timeline.filter((e) => e.type === 'escalated');
  assert.equal(esc.length, 1);
  assert.equal(esc[0].note, 'Overdue by 1 day. Escalated to Executive Engineer Rao.');
  assert.equal(esc[0].actor, 'RoadGuard');

  db.prepare('UPDATE hazards SET due_at = ? WHERE id = ?').run(Date.now() - 6 * DAY - 3600000, id);
  h = await list();
  assert.equal(h.escalationLevel, 2);
  assert.equal(h.overdueDays, 6);

  db.prepare('UPDATE hazards SET due_at = ? WHERE id = ?').run(Date.now() - 40 * DAY, id);
  h = await list();
  assert.equal(h.escalationLevel, 3, 'capped at 3');
  await list();
  d = await detail(id);
  esc = d.timeline.filter((e) => e.type === 'escalated');
  assert.equal(esc.length, 3, 'one event per increase, none when nothing changes');
  assert.equal(esc[2].note, 'Overdue by 40 days. Escalated to Executive Engineer Rao.');

  const overdue = await request(app).get('/api/hazards?overdue=1');
  assert.ok(overdue.body.items.some((x) => x.id === id));
  assert.ok(overdue.body.items.every((x) => x.overdueDays > 0));
  const ov = await request(app).get('/api/stats/overview');
  assert.ok(ov.body.totals.overdue >= 1);

  assert.equal(A.escalationLevelFor(Date.now() - 1000, 7, Date.now()), 1);
  assert.equal(A.escalationLevelFor(Date.now() + 1000, 7, Date.now()), 0);
  // Without an officer on the segment.
  const c2 = await contractor('Quiet Co');
  await segment({ roadPattern: 'Officerless Road', contractorId: c2.id });
  const h2 = (await report(u.token, spot(61), { roadName: 'Officerless Road', severityScore: 70 })).body.hazardId;
  db.prepare('UPDATE hazards SET due_at = ? WHERE id = ?').run(Date.now() - 1000, h2);
  A.escalate(db);
  assert.equal((await detail(h2)).timeline.at(-1).note, 'Overdue by 1 day. Escalated to the ward officer.');
});

test('repair photo: staff only, image required; closes the hazard; a reopen counts against the contractor', async () => {
  const c = await contractor('Repair Co');
  await segment({ roadPattern: 'Repair Road', contractorId: c.id, slaDays: 5 });
  const u = await guest('v3-repair-1');
  const created = await report(u.token, spot(70), { roadName: 'Repair Road', severityScore: 72 });
  const id = created.body.hazardId;
  assert.equal(created.body.hazard.status, 'assigned');
  const jpeg = (r) => r.attach('image', JPEG, { filename: 'after.jpg', contentType: 'image/jpeg' });

  assert.equal((await jpeg(request(app).post(`/api/hazards/${id}/repair`))).status, 401);
  assert.equal((await jpeg(request(app).post(`/api/hazards/${id}/repair`).set(auth(u.token)))).status, 403);
  const t = await staff();
  const noImage = await request(app).post(`/api/hazards/${id}/repair`).set(auth(t)).field('note', 'done');
  assert.equal(noImage.status, 400);
  assert.match(noImage.body.message, /image/);
  const wrongType = await request(app)
    .post(`/api/hazards/${id}/repair`)
    .set(auth(t))
    .attach('image', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });
  assert.equal(wrongType.status, 400);
  assert.equal((await jpeg(request(app).post('/api/hazards/999999/repair').set(auth(t)))).status, 404);

  const ok = await jpeg(request(app).post(`/api/hazards/${id}/repair`).set(auth(t)).field('note', 'Cut, filled and rolled.'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.hazard.status, 'resolved');
  assert.equal(ok.body.hazard.resolvedBy, 'contractor');
  assert.ok(ok.body.hazard.repairImageUrl);
  assert.equal((await request(app).get(new URL(ok.body.hazard.repairImageUrl).pathname)).status, 200);
  const ev = (await detail(id)).timeline.at(-1);
  assert.equal(ev.type, 'repaired');
  assert.equal(ev.note, 'Cut, filled and rolled.');

  // Spotted again later: reopened, and sent back to the same contractor with a new deadline.
  db.prepare('UPDATE hazards SET resolved_at = ? WHERE id = ?').run(Date.now() - 3 * 3600000, id);
  db.prepare("UPDATE hazard_events SET created_at = ? WHERE hazard_id = ? AND type = 'repaired'").run(Date.now() - 3 * 3600000, id);
  const again = await report((await guest('v3-repair-2')).token, spot(70), { roadName: 'Repair Road', severityScore: 72 });
  assert.equal(again.body.hazard.reopenCount, 1);
  assert.equal(again.body.hazard.status, 'assigned');
  assert.equal(again.body.hazard.contractor.id, c.id);
  assert.ok(again.body.hazard.dueAt > Date.now() + 4 * DAY);
  assert.equal(again.body.hazard.escalationLevel, 0);
  assert.match((await detail(id)).timeline.at(-1).note, /^Sent back to Repair Co\./);
  const card = (await request(app).get('/api/contractors')).body.items.find((x) => x.id === c.id);
  assert.equal(card.reopenedAfterRepair, 1);

  // Closing without a photo is allowed for staff, but recorded.
  const other = await report(u.token, spot(71), { roadName: 'Repair Road', severityScore: 72 });
  await request(app).patch(`/api/hazards/${other.body.hazardId}`).set(auth(t)).send({ status: 'resolved', note: 'Patched.' });
  assert.equal((await detail(other.body.hazardId)).timeline.at(-1).note, 'Patched. Closed without repair photo.');
});

test('contractor scorecards: assigned, open, fixed, overdue, avg fix days, on-time rate', async () => {
  const c = await contractor('Score Co');
  await segment({ roadPattern: 'Score Road', contractorId: c.id, slaDays: 5 });
  const u = await guest('v3-score-1');
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await report(u.token, spot(80 + i), { roadName: 'Score Road', severityScore: 70 })).body.hazardId);
  const t = await staff();
  const repair = (id) => request(app).post(`/api/hazards/${id}/repair`).set(auth(t)).attach('image', JPEG, { filename: 'r.jpg', contentType: 'image/jpeg' });
  const now = Date.now();
  // 0: fixed on time after 2 days. 1: fixed late after 4 days. 2: open and overdue. 3: open, not yet due.
  await repair(ids[0]);
  db.prepare('UPDATE hazards SET assigned_at = resolved_at - ? WHERE id = ?').run(2 * DAY, ids[0]);
  db.prepare('UPDATE hazards SET due_at = ? WHERE id = ?').run(now - DAY, ids[1]);
  await repair(ids[1]);
  db.prepare('UPDATE hazards SET assigned_at = resolved_at - ? WHERE id = ?').run(4 * DAY, ids[1]);
  db.prepare('UPDATE hazards SET due_at = ? WHERE id = ?').run(now - 2 * DAY, ids[2]);
  // Rejected hazards do not count as assigned work.
  const rej = (await report(u.token, spot(85), { roadName: 'Score Road', severityScore: 70 })).body.hazardId;
  await request(app).patch(`/api/hazards/${rej}`).set(auth(t)).send({ status: 'rejected' });

  const res = await request(app).get('/api/contractors');
  assert.equal(res.status, 200);
  const card = res.body.items.find((x) => x.id === c.id);
  const pick = (x) => ({
    assigned: x.assigned, open: x.open, fixed: x.fixed, overdue: x.overdue, avgFixDays: x.avgFixDays,
    reopenedAfterRepair: x.reopenedAfterRepair, onTimeRate: x.onTimeRate,
  });
  assert.deepEqual(pick(card), { assigned: 4, open: 2, fixed: 2, overdue: 1, avgFixDays: 3, reopenedAfterRepair: 0, onTimeRate: 33 });
  assert.equal(card.email, undefined, 'the public list hides contractor email');
  const asStaff = (await request(app).get('/api/contractors').set(auth(t))).body.items.find((x) => x.id === c.id);
  assert.ok('email' in asStaff);
  assert.equal(asStaff.segments, 1);

  const fresh = (await request(app).get('/api/contractors')).body.items.find((x) => x.name === 'Match X');
  assert.equal(fresh.onTimeRate, null, 'no judged work yet');
  assert.equal(fresh.avgFixDays, null);

  assert.equal((await request(app).post('/api/contractors').set(auth(t)).send({ name: 'score co' })).status, 409);
  const renamed = await request(app).patch(`/api/contractors/${c.id}`).set(auth(t)).send({ name: 'Score Company' });
  assert.equal(renamed.body.contractor.name, 'Score Company');
  assert.equal((await detail(ids[3])).hazard.assignedTeam, 'Score Company');
  assert.equal((await request(app).post('/api/contractors').set(auth(u.token)).send({ name: 'Nope' })).status, 403);
});

test('segments CRUD is staff-only and validates input', async () => {
  const t = await staff();
  const u = await guest('v3-seg-crud');
  assert.equal((await request(app).get('/api/segments')).status, 401);
  assert.equal((await request(app).get('/api/segments').set(auth(u.token))).status, 403);
  const s = await segment({ roadPattern: 'Crud Road', contractorName: 'Crud Builders', ward: 'Ward 1', slaDays: 9 });
  assert.equal(s.contractor.name, 'Crud Builders');
  assert.equal(s.slaDays, 9);
  const patched = await request(app).patch(`/api/segments/${s.id}`).set(auth(t)).send({ ward: 'Ward 2', warrantyUntil: '2030-06-30' });
  assert.equal(patched.body.segment.ward, 'Ward 2');
  assert.equal(patched.body.segment.slaDays, 9, 'untouched fields stay');
  assert.equal(A.formatDate(patched.body.segment.warrantyUntil), '30 Jun 2030', 'valid to the end of that day, India time');
  const half = await request(app).patch(`/api/segments/${s.id}`).set(auth(t)).send({ minLat: 30 });
  assert.equal(half.status, 400);
  assert.match(half.body.message, /minLat/);
  assert.equal((await request(app).post('/api/segments').set(auth(t)).send({ roadPattern: 'Z' })).status, 400);
  assert.equal((await request(app).post('/api/segments').set(auth(t)).send({ roadPattern: 'Zed Road', contractorId: 99999 })).status, 400);
  const list = await request(app).get('/api/segments').set(auth(t));
  assert.ok(list.body.items.some((x) => x.id === s.id && x.roadPattern === 'Crud Road' && x.openHazards === 0));
  assert.equal((await request(app).delete(`/api/segments/${s.id}`).set(auth(t))).status, 200);
  assert.equal((await request(app).delete(`/api/segments/${s.id}`).set(auth(t))).status, 404);
});

test('CSV parser: quoted fields, doubled quotes, newlines, CRLF and line numbers', () => {
  const rows = A.parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\nplain,,last\n');
  assert.deepEqual(rows.map((r) => r.cells), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'two\nlines'], ['plain', '', 'last']]);
  assert.deepEqual(rows.map((r) => r.line), [1, 2, 5]);
  assert.throws(() => A.parseCsv('a,b\n"open,1\n'), /never closed/);
  assert.deepEqual(A.parseCsv('x,y').map((r) => r.cells), [['x', 'y']]);
  assert.deepEqual(A.parseCsv('"",""\n').map((r) => r.cells), [['', '']]);
});

test('CSV import: quoted fields, contractors created, errors by line, re-import updates, assignment re-runs', async () => {
  const t = await staff();
  const u = await guest('v3-csv-1');
  // A serious hazard waiting on a road nobody has mapped yet.
  const waiting = await report(u.token, spot(90), { roadName: 'Import Test Road', severityScore: 75 });
  assert.equal(waiting.body.hazard.status, 'reported');

  const csv = [
    'road_pattern,ward,contractor,officer_name,officer_contact,tender_id,sla_days,warranty_until',
    '"Import Test Road","Ward 5, North","Quote ""Q"" Infra","Assistant Engineer, PWD",ae@example.gov,DDN/IMP/1,4,2099-01-31',
    'Second Import Road,Ward 6,"Quote ""Q"" Infra",,,DDN/IMP/2,,',
    'Bad Sla Road,,,,,,seven,',
    'Bad Date Road,,,,,,,31-01-2030',
    ',Ward 9,Someone,,,,,',
    '"Multi',
    'line Road",Ward 7,Plain Builders,,,DDN/IMP/3,10,',
  ].join('\r\n');
  const res = await request(app).post('/api/segments/import').set(auth(t)).send({ csv });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 3);
  assert.equal(res.body.contractorsCreated, 2);
  assert.deepEqual(res.body.errors.map((e) => e.line), [4, 5, 6]);
  assert.match(res.body.errors[0].message, /sla_days/);
  assert.match(res.body.errors[1].message, /warranty_until/);
  assert.match(res.body.errors[2].message, /road_pattern/);
  assert.equal(res.body.assigned, 1);

  const segs = (await request(app).get('/api/segments').set(auth(t))).body.items;
  const imp = segs.find((s) => s.roadPattern === 'Import Test Road');
  assert.equal(imp.ward, 'Ward 5, North');
  assert.equal(imp.contractor.name, 'Quote "Q" Infra');
  assert.equal(imp.officerName, 'Assistant Engineer, PWD');
  assert.equal(imp.slaDays, 4);
  assert.equal(segs.find((s) => s.roadPattern === 'Second Import Road').slaDays, 7, 'default SLA');
  assert.ok(segs.find((s) => s.roadPattern === 'Multi line Road'), 'line breaks inside a quoted name become spaces');

  const d = await detail(waiting.body.hazardId);
  assert.equal(d.hazard.status, 'assigned');
  assert.equal(d.hazard.underWarranty, true);
  assert.equal(d.hazard.segment.ward, 'Ward 5, North');

  const again = await request(app).post('/api/segments/import').set(auth(t)).send({ csv });
  assert.equal(again.body.updated, 3);
  assert.equal(again.body.contractorsCreated, 0);
  const segs2 = (await request(app).get('/api/segments').set(auth(t))).body.items;
  assert.equal(segs2.length, segs.length, 'no duplicates on re-import');

  const noHeader = await request(app).post('/api/segments/import').set(auth(t)).send({ csv: 'Rajpur,Ward 1\n' });
  assert.equal(noHeader.body.imported, 0);
  assert.match(noHeader.body.errors[0].message, /header/);
  const unclosed = await request(app).post('/api/segments/import').set(auth(t)).send({ csv: 'road_pattern\n"Open road\n' });
  assert.match(unclosed.body.errors[0].message, /never closed/);
  const tpl = await request(app).get('/api/segments/template.csv');
  assert.equal(tpl.status, 200);
  assert.match(tpl.text, /^road_pattern,ward,contractor,officer_name,officer_contact,tender_id,sla_days,warranty_until\n/);
  assert.equal(A.parseCsv(tpl.text)[1].cells.length, 8);
  assert.equal((await request(app).post('/api/segments/import').set(auth(u.token)).send({ csv })).status, 403);
});

test('complaint letter in English and Hindi carries tender, officer, warranty, overdue days and links', async () => {
  const c = await contractor('Letter Infra');
  await segment({
    roadPattern: 'Letter Road', contractorId: c.id, tenderId: 'DDN/LTR/2026/9', officerName: 'Er. Meena Rawat',
    officerContact: 'ae@ddn.example', ward: 'Ward 11', warrantyUntil: '2099-03-31', slaDays: 5,
  });
  const u = await guest('v3-letter-1');
  const r = await report(u.token, spot(100), { roadName: 'Letter Road', severityScore: 77 });
  const id = r.body.hazardId;
  db.prepare('UPDATE hazards SET due_at = ? WHERE id = ?').run(Date.now() - 3 * DAY - 3600000, id);

  const en = await request(app).get(`/api/hazards/${id}/complaint`);
  assert.equal(en.status, 200);
  for (const s of ['DDN/LTR/2026/9', 'Er. Meena Rawat', 'Letter Infra', 'Ward 11', `/h/${id}`, 'https://www.google.com/maps/search/?api=1&query=', 'warranty', '3 days overdue', 'Respected Sir/Madam']) {
    assert.ok(en.body.body.includes(s), `English letter should mention ${s}`);
  }
  assert.deepEqual(en.body.to, { officerName: 'Er. Meena Rawat', officerContact: 'ae@ddn.example', contractor: 'Letter Infra' });
  assert.ok(en.body.publicUrl.endsWith(`/h/${id}`));
  assert.match(en.body.subject, /^Pothole on Letter Road needs repair/);
  assert.ok(!/—/.test(en.body.body), 'no em dashes');

  const hi = await request(app).get(`/api/hazards/${id}/complaint?lang=hi`);
  assert.equal(hi.status, 200);
  assert.match(hi.body.body, /[ऀ-ॿ]{3,}/);
  for (const s of ['DDN/LTR/2026/9', 'Er. Meena Rawat', 'Letter Infra', `/h/${id}`, 'सेवा में', 'विषय', 'निविदा', 'वारंटी', 'ठेकेदार', '3 दिन', 'भवदीय']) {
    assert.ok(hi.body.body.includes(s), `Hindi letter should mention ${s}`);
  }
  assert.match(hi.body.subject, /गड्ढे की मरम्मत/);
  assert.equal(new URL(hi.body.publicUrl).pathname, `/h/${id}`);

  assert.equal((await request(app).get('/api/hazards/999999/complaint')).status, 404);
  // A hazard on an unmapped road still gets a usable letter.
  const plain = await report(u.token, spot(101), { severityScore: 40 });
  const p = await request(app).get(`/api/hazards/${plain.body.hazardId}/complaint`);
  assert.match(p.body.body, /^To,\nThe Ward Officer\n/);
  assert.equal(p.body.to.contractor, null);
});

// ------------------------------------------------------------------ public page

test('public hazard page renders, escapes user content, has Open Graph tags; 404 page', async () => {
  const u = await guest('v3-public-1');
  const evil = '<script>alert(1)</script> "Bad" Road';
  const r = await report(u.token, spot(110), { roadName: evil, severityScore: 66 });
  const id = r.body.hazardId;
  await request(app).patch(`/api/hazards/${id}`).set(auth(await staff())).send({ note: '<img src=x onerror=alert(2)>' });

  const page = await request(app).get(`/h/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.ok(!page.text.includes('<script>alert(1)'), 'road name is escaped');
  assert.ok(!page.text.includes('<img src=x'), 'notes are escaped');
  assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;Bad&quot; Road'));
  assert.ok(!/<script/i.test(page.text), 'no scripts at all');
  assert.match(page.text, /<meta property="og:title" content="Pothole on &lt;script&gt;/);
  assert.match(page.text, /<meta property="og:image" content="http[^"]+\/site\/og-default\.png">/);
  assert.match(page.text, /<meta property="og:description"/);
  assert.match(page.text, /Get the RoadGuard app/);
  assert.match(page.text, /Reported<\/span>/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);

  assert.equal((await request(app).get('/site/hazard.css')).status, 200);
  assert.equal((await request(app).get('/site/og-default.png')).status, 200);
  assert.equal((await request(app).get('/vendor/fonts/barlow/barlow-latin-400-normal.woff2')).status, 200);

  const missing = await request(app).get('/h/987654');
  assert.equal(missing.status, 404);
  assert.match(missing.text, /could not find this hazard/);
  assert.equal((await request(app).get('/h/abc')).status, 404);
});

test('public page shows contractor, due date, warranty and before/after photos', async () => {
  const c = await contractor('Page Builders');
  await segment({ roadPattern: 'Page Road', contractorId: c.id, tenderId: 'DDN/PAGE/1', warrantyUntil: '2099-01-01' });
  const u = await guest('v3-page-2');
  const r = await request(app)
    .post('/api/reports')
    .set(auth(u.token))
    .field('latitude', String(spot(120).lat))
    .field('longitude', String(spot(120).lng))
    .field('confidence', '0.9')
    .field('severityScore', '82')
    .field('roadName', 'Page Road')
    .attach('image', JPEG, { filename: 'b.jpg', contentType: 'image/jpeg' });
  const id = r.body.hazardId;
  let page = await request(app).get(`/h/${id}`);
  for (const s of ['Page Builders', 'DDN/PAGE/1', 'Under warranty', 'Due', 'Sent to Page Builders']) assert.ok(page.text.includes(s), s);
  assert.match(page.text, /<meta property="og:image" content="http[^"]+\/uploads\//);
  await request(app).post(`/api/hazards/${id}/repair`).set(auth(await staff())).attach('image', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
  page = await request(app).get(`/h/${id}`);
  assert.match(page.text, /Before<\/figcaption>/);
  assert.match(page.text, /After<\/figcaption>/);
  assert.match(page.text, /Fixed on/);
});

// ------------------------------------------------------------------ road health

test('road health index: weights by type and severity, worst roads first', async () => {
  const u = await guest('v3-health-1');
  await report(u.token, spot(130), { roadName: 'Health Alpha Road', severityScore: 70 });
  await report(u.token, spot(131), { roadName: 'Health Alpha Road', severityScore: 70, type: 'drain_hole' });
  await report(u.token, spot(132), { roadName: 'Health Beta Road', severityScore: 40, type: 'crack' });
  const fixed = await report(u.token, spot(133), { roadName: 'Health Beta Road', severityScore: 90 });
  await request(app).patch(`/api/hazards/${fixed.body.hazardId}`).set(auth(await staff())).send({ status: 'resolved' });

  const res = await request(app).get('/api/stats/roads?limit=500');
  assert.equal(res.status, 200);
  const items = res.body.items;
  const a = items.find((x) => x.road === 'Health Alpha Road');
  const b = items.find((x) => x.road === 'Health Beta Road');
  assert.equal(a.healthScore, 83); // 100 - (0.7*12 + 0.7*12)
  assert.equal(b.healthScore, 98); // 100 - 0.4*5; the fixed one does not count
  assert.equal(a.openHazards, 2);
  assert.equal(a.potholes, 1);
  assert.equal(b.cracks, 1);
  assert.equal(a.worstSeverity, 'HIGH');
  assert.equal(b.worstSeverity, 'MEDIUM');
  assert.ok(items.indexOf(a) < items.indexOf(b), 'worst first');
  const scores = items.map((x) => x.healthScore);
  assert.deepEqual(scores, [...scores].sort((x, y) => x - y));
  assert.deepEqual(
    Object.keys(a).sort(),
    ['contractor', 'cracks', 'healthScore', 'kmScanned30d', 'lastScannedAt', 'openHazards', 'potholes', 'road', 'worstSeverity'].sort()
  );
  assert.equal(a.kmScanned30d, 0);
  assert.equal(a.lastScannedAt, null);
  assert.equal(items.find((x) => x.road === 'Assign Test Road').contractor, 'Assign Co');

  // A drive along Alpha counts as scanning it.
  const at = spot(130);
  const now = Date.now();
  await request(app).post('/api/drives').set(auth(u.token)).send({
    clientId: 'drive-health-01', mode: 'camera', startedAt: now - 100000, endedAt: now - 1000, distanceMeters: 1100,
    path: Array.from({ length: 25 }, (_, i) => [at.lat + i * 0.0004, at.lng, now - 100000 + i * 4000]),
  });
  const after = (await request(app).get('/api/stats/roads?limit=500')).body.items.find((x) => x.road === 'Health Alpha Road');
  assert.ok(after.kmScanned30d > 0.5, `km scanned ${after.kmScanned30d}`);
  assert.ok(after.lastScannedAt > now - 200000);
  assert.equal((await request(app).get('/api/stats/roads?limit=0')).status, 400);
});

// ------------------------------------------------------------------ migration

// The schema exactly as shipped before v3 (src/db.js before this change).
const OLD_SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen','authority','admin')),
  is_guest      INTEGER NOT NULL DEFAULT 0,
  device_id     TEXT UNIQUE,
  city          TEXT,
  team          TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS hazards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type              TEXT NOT NULL DEFAULT 'pothole',
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  road_name         TEXT,
  area              TEXT,
  status            TEXT NOT NULL DEFAULT 'reported'
                    CHECK (status IN ('reported','verified','assigned','in_progress','resolved','rejected')),
  severity_score    REAL NOT NULL DEFAULT 0,
  severity_level    TEXT NOT NULL DEFAULT 'LOW',
  avg_confidence    REAL NOT NULL DEFAULT 0,
  max_shock         REAL NOT NULL DEFAULT 0,
  avg_speed         REAL NOT NULL DEFAULT 0,
  report_count      INTEGER NOT NULL DEFAULT 0,
  unique_reporters  INTEGER NOT NULL DEFAULT 0,
  clean_passes      INTEGER NOT NULL DEFAULT 0,
  reopen_count      INTEGER NOT NULL DEFAULT 0,
  priority          REAL NOT NULL DEFAULT 0,
  cover_image       TEXT,
  discovered_by     INTEGER REFERENCES users(id),
  assigned_team     TEXT,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hazards_geo ON hazards(lat, lng);
CREATE INDEX IF NOT EXISTS idx_hazards_status ON hazards(status);
CREATE INDEX IF NOT EXISTS idx_hazards_priority ON hazards(priority DESC);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       TEXT UNIQUE,
  hazard_id       INTEGER NOT NULL REFERENCES hazards(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL DEFAULT 'pothole',
  source          TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  accuracy        REAL,
  heading         REAL,
  speed           REAL NOT NULL DEFAULT 0,
  confidence      REAL NOT NULL DEFAULT 0,
  shock           REAL NOT NULL DEFAULT 0,
  severity_score  REAL NOT NULL DEFAULT 0,
  severity_level  TEXT NOT NULL DEFAULT 'LOW',
  road_name       TEXT,
  image           TEXT,
  note            TEXT,
  detected_at     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_hazard ON reports(hazard_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);

CREATE TABLE IF NOT EXISTS hazard_votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hazard_id  INTEGER NOT NULL REFERENCES hazards(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  vote       TEXT NOT NULL CHECK (vote IN ('present','fixed','pass')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_hazard ON hazard_votes(hazard_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hazard_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hazard_id   INTEGER NOT NULL REFERENCES hazards(id),
  actor_id    INTEGER REFERENCES users(id),
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_hazard ON hazard_events(hazard_id, created_at);
`;

test('an old (v2) database file is migrated in place without losing data', () => {
  const file = path.join(tmp, 'old.db');
  const old = new Database(file);
  old.pragma('journal_mode = WAL');
  old.exec(OLD_SCHEMA_V2);
  const now = Date.now();
  old.prepare("INSERT INTO users (name, email, role, created_at, points) VALUES ('Old Driver', 'old@x.in', 'citizen', ?, 13)").run(now);
  old.prepare(
    `INSERT INTO hazards (type, lat, lng, road_name, status, severity_score, severity_level, report_count, unique_reporters,
       discovered_by, first_reported_at, last_reported_at, updated_at, assigned_team)
     VALUES ('pothole', 30.1, 78.1, 'Old Road', 'assigned', 66, 'HIGH', 1, 1, 1, ?, ?, ?, 'Old Crew')`
  ).run(now, now, now);
  old.prepare(
    `INSERT INTO reports (client_id, hazard_id, user_id, type, source, lat, lng, confidence, severity_score, detected_at, created_at)
     VALUES ('old-client-1', 1, 1, 'pothole', 'manual', 30.1, 78.1, 0.8, 66, ?, ?)`
  ).run(now, now);
  old.prepare("INSERT INTO hazard_events (hazard_id, type, to_status, created_at) VALUES (1, 'created', 'reported', ?)").run(now);
  old.prepare("INSERT INTO hazard_votes (hazard_id, user_id, vote, created_at) VALUES (1, 1, 'present', ?)").run(now);
  assert.throws(
    () => old.prepare("INSERT INTO reports (hazard_id, user_id, source, lat, lng, detected_at, created_at) VALUES (1, 1, 'sensor', 1, 1, 1, 1)").run(),
    /CHECK constraint/
  );
  assert.equal(old.pragma('user_version', { simple: true }), 0);
  old.close();

  const db2 = open(file);
  assert.equal(db2.migration.migrated, true);
  assert.equal(db2.pragma('user_version', { simple: true }), 3);
  const h = db2.prepare('SELECT * FROM hazards WHERE id = 1').get();
  assert.equal(h.road_name, 'Old Road');
  assert.equal(h.assigned_team, 'Old Crew');
  assert.equal(h.severity_score, 66);
  assert.equal(h.escalation_level, 0);
  assert.equal(h.under_warranty, 0);
  assert.equal(h.due_at, null);
  assert.equal(db2.prepare('SELECT source FROM reports WHERE client_id = ?').get('old-client-1').source, 'manual');
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM hazard_events').get().n, 1);
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM hazard_votes').get().n, 1);
  assert.equal(db2.prepare('SELECT points FROM users WHERE id = 1').get().points, 13);
  // The new CHECK allows sensor sightings, and the new tables and indexes exist.
  db2.prepare("INSERT INTO reports (hazard_id, user_id, source, lat, lng, detected_at, created_at) VALUES (1, 1, 'sensor', 30.1, 78.1, 1, 1)").run();
  for (const t of ['contractors', 'road_segments', 'sensor_hits', 'drives', 'coverage_cells', 'drive_cells']) {
    assert.ok(db2.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  }
  for (const i of ['idx_hazards_geo', 'idx_reports_hazard', 'idx_hazards_due']) {
    assert.ok(db2.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(i), i);
  }
  assert.ok(!db2.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%_v3'").get(), 'no leftover temp tables');
  assert.deepEqual(db2.pragma('foreign_key_check'), []);
  assert.equal(db2.pragma('foreign_keys', { simple: true }), 1);
  // Row ids continue after the copied rows.
  const next = db2.prepare('INSERT INTO hazards (lat, lng, first_reported_at, last_reported_at, updated_at) VALUES (1, 1, 1, 1, 1)').run().lastInsertRowid;
  assert.equal(next, 2);
  // And the app logic runs on it.
  const r = ingestSensorHits(db2, { id: 1 }, [{ clientId: 'migrated-hit', latitude: 30.1, longitude: 78.1, accuracy: 5, speed: 30, shock: 9, timestamp: Date.now() }]);
  assert.equal(r.confirmed, 1);
  db2.close();

  const db3 = open(file);
  assert.equal(db3.migration.migrated, false, 'a second open is a no-op');
  assert.equal(db3.prepare('SELECT COUNT(*) n FROM reports').get().n, 3);
  db3.close();
});

test('a fresh database starts at the current schema version', () => {
  const db4 = open(path.join(tmp, 'fresh.db'));
  assert.equal(db4.pragma('user_version', { simple: true }), 3);
  assert.equal(db4.migration.migrated, false);
  db4.close();
});
