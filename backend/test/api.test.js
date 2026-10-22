'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'test.db');

const request = require('supertest');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureStaff } = require('../src/createAdmin');
const { seed } = require('../src/seed');
const H = require('../src/hazards');

const db = open(process.env.DB_FILE);
const app = createApp(db, { logging: false });

// A tiny valid JPEG (1x1).
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

const BASE = { lat: 30.3165, lng: 78.0322 };
const offset = (m) => m / 111320; // metres -> degrees latitude

async function guest(deviceId) {
  const res = await request(app).post('/api/auth/guest').send({ deviceId });
  assert.equal(res.status, 200);
  return res.body.token;
}

function report(token, extra = {}) {
  return request(app)
    .post('/api/reports')
    .set('Authorization', `Bearer ${token}`)
    .send({
      latitude: BASE.lat,
      longitude: BASE.lng,
      confidence: 0.9,
      severityScore: 70,
      shock: 9,
      speed: 35,
      accuracy: 5,
      roadName: 'Rajpur Road',
      timestamp: Date.now(),
      ...extra,
    });
}

test('health', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('register, login, me; duplicate email rejected', async () => {
  const reg = await request(app).post('/api/auth/register').send({ name: 'Tanishq', email: 'T@Example.com', password: 'secret12' });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.token);
  assert.equal(reg.body.user.email, 't@example.com');

  const dup = await request(app).post('/api/auth/register').send({ name: 'Other', email: 't@example.com', password: 'secret12' });
  assert.equal(dup.status, 409);

  const bad = await request(app).post('/api/auth/login').send({ email: 't@example.com', password: 'wrong' });
  assert.equal(bad.status, 401);

  const ok = await request(app).post('/api/auth/login').send({ email: 't@example.com', password: 'secret12' });
  assert.equal(ok.status, 200);
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${ok.body.token}`);
  assert.equal(me.body.user.name, 'Tanishq');
});

test('reports require auth and validate input', async () => {
  const anon = await request(app).post('/api/reports').send({ latitude: 1, longitude: 1 });
  assert.equal(anon.status, 401);
  const token = await guest('device-validate-0001');
  const bad = await report(token, { latitude: 500 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /latitude/);
});

test('nearby sightings merge into one hazard; far ones do not; types stay separate', async () => {
  const a = await guest('device-merge-aaaa');
  const first = await report(a, { clientId: 'merge-1' });
  assert.equal(first.status, 201);
  assert.equal(first.body.isNewHazard, true);
  assert.equal(first.body.pointsAwarded, 10);

  const near = await report(a, { clientId: 'merge-2', latitude: BASE.lat + offset(6) });
  assert.equal(near.body.isNewHazard, false);
  assert.equal(near.body.hazardId, first.body.hazardId);
  assert.equal(near.body.pointsAwarded, 0, 'same user confirming again earns nothing');

  const far = await report(a, { clientId: 'merge-3', latitude: BASE.lat + offset(60) });
  assert.equal(far.body.isNewHazard, true);

  const drain = await report(a, { clientId: 'merge-4', type: 'Drain Hole' });
  assert.equal(drain.body.isNewHazard, true);
  assert.equal(drain.body.hazard.type, 'drain_hole');
});

test('uploads are idempotent on clientId', async () => {
  const t = await guest('device-idem-0001');
  const one = await report(t, { clientId: 'idem-xyz', latitude: BASE.lat + offset(500) });
  const two = await report(t, { clientId: 'idem-xyz', latitude: BASE.lat + offset(500) });
  assert.equal(two.status, 200);
  assert.equal(two.body.duplicate, true);
  assert.equal(two.body.reportId, one.body.reportId);
  assert.equal(two.body.hazard.reportCount, 1);
});

test('three different drivers auto-verify; severity uses worst sightings', async () => {
  const lat = BASE.lat + offset(1000);
  let last;
  for (let i = 0; i < 3; i++) {
    const t = await guest(`device-verify-${i}000`);
    last = await report(t, { latitude: lat, severityScore: [30, 85, 90][i] });
  }
  assert.equal(last.body.hazard.status, 'verified');
  assert.equal(last.body.hazard.uniqueReporters, 3);
  assert.equal(last.body.hazard.severityLevel, 'HIGH'); // mean(90,85,30)=68.3
  assert.equal(last.body.pointsAwarded, 3);
});

test('multipart upload with photo, served back from /uploads', async () => {
  const t = await guest('device-photo-0001');
  const res = await request(app)
    .post('/api/reports')
    .set('Authorization', `Bearer ${t}`)
    .field('latitude', String(BASE.lat + offset(2000)))
    .field('longitude', String(BASE.lng))
    .field('confidence', '0.8')
    .field('severityScore', '55')
    .field('timestamp', String(Date.now()))
    .attach('image', JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 201);
  assert.ok(res.body.hazard.imageUrl);
  const img = await request(app).get(new URL(res.body.hazard.imageUrl).pathname);
  assert.equal(img.status, 200);
});

test('community "fixed" votes resolve, discoverer rewarded, new sighting reopens', async () => {
  const lat = BASE.lat + offset(3000);
  const discoverer = await guest('device-fix-disc');
  const created = await report(discoverer, { latitude: lat, timestamp: Date.now() - 3 * 3600 * 1000 });
  const id = created.body.hazardId;

  for (let i = 0; i < 3; i++) {
    const v = await guest(`device-fix-vote${i}`);
    const r = await request(app).post(`/api/hazards/${id}/vote`).set('Authorization', `Bearer ${v}`).send({ vote: 'fixed' });
    assert.equal(r.status, 200);
  }
  const detail = await request(app).get(`/api/hazards/${id}`);
  assert.equal(detail.body.hazard.status, 'resolved');
  assert.equal(detail.body.hazard.resolvedBy, 'community');

  const me = await request(app).get('/api/stats/me').set('Authorization', `Bearer ${discoverer}`);
  assert.equal(me.body.stats.points, 10 + 20);
  assert.equal(me.body.stats.hazardsFixed, 1);

  // Spotted again two hours later -> reopened.
  db.prepare('UPDATE hazards SET resolved_at = ? WHERE id = ?').run(Date.now() - 2 * 3600 * 1000, id);
  const again = await report(discoverer, { latitude: lat });
  assert.equal(again.body.hazard.status, 'reported');
  assert.equal(again.body.hazard.reopenCount, 1);
});

test('a driver saying a fixed hazard is back reopens it', async () => {
  const lat = BASE.lat + offset(3500);
  const t = await guest('device-back-0001');
  const created = await report(t, { latitude: lat });
  const id = created.body.hazardId;
  ensureStaff(db, { email: 'fixer@test.gov', password: 'fixerpass1', name: 'Fixer', role: 'authority' });
  const staff = (await request(app).post('/api/auth/login').send({ email: 'fixer@test.gov', password: 'fixerpass1' })).body.token;
  await request(app).patch(`/api/hazards/${id}`).set('Authorization', `Bearer ${staff}`).send({ status: 'resolved' });
  const other = await guest('device-back-0002');
  const r = await request(app).post(`/api/hazards/${id}/vote`).set('Authorization', `Bearer ${other}`).send({ vote: 'present' });
  assert.equal(r.body.hazard.status, 'reported');
  assert.equal(r.body.hazard.reopenCount, 1);
});

test('clean passes flag likely fixed and reset on a sighting', async () => {
  const lat = BASE.lat + offset(4000);
  const t = await guest('device-pass-0001');
  const created = await report(t, { latitude: lat });
  const id = created.body.hazardId;
  let r;
  for (let i = 0; i < 5; i++) {
    r = await request(app).post(`/api/hazards/${id}/vote`).set('Authorization', `Bearer ${t}`).send({ vote: 'pass' });
  }
  assert.equal(r.body.hazard.likelyFixed, true);
  const again = await report(t, { latitude: lat });
  assert.equal(again.body.hazard.likelyFixed, false);
});

test('authority workflow is role-protected and recorded in the timeline', async () => {
  const t = await guest('device-auth-0001');
  const created = await report(t, { latitude: BASE.lat + offset(5000) });
  const id = created.body.hazardId;

  const denied = await request(app).patch(`/api/hazards/${id}`).set('Authorization', `Bearer ${t}`).send({ status: 'resolved' });
  assert.equal(denied.status, 403);

  ensureStaff(db, { email: 'crew@test.gov', password: 'crewpass1', name: 'Crew', role: 'authority' });
  const login = await request(app).post('/api/auth/login').send({ email: 'crew@test.gov', password: 'crewpass1' });
  const staff = login.body.token;

  const assign = await request(app).patch(`/api/hazards/${id}`).set('Authorization', `Bearer ${staff}`).send({ assignedTeam: 'Ward 4' });
  assert.equal(assign.body.hazard.status, 'assigned');
  assert.equal(assign.body.hazard.assignedTeam, 'Ward 4');

  const done = await request(app).patch(`/api/hazards/${id}`).set('Authorization', `Bearer ${staff}`).send({ status: 'resolved', note: 'Filled' });
  assert.equal(done.body.hazard.status, 'resolved');
  assert.equal(done.body.hazard.priority, 0);

  const detail = await request(app).get(`/api/hazards/${id}`);
  const types = detail.body.timeline.map((e) => e.type);
  assert.deepEqual(types, ['created', 'assigned', 'status_change', 'status_change']);
  assert.equal(detail.body.timeline[1].actor, 'City team', 'public sees no staff names');

  const csv = await request(app).get('/api/hazards/export.csv').set('Authorization', `Bearer ${staff}`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^id,type,status/);
});

test('nearby returns only open hazards, nearest first', async () => {
  const res = await request(app).get(`/api/hazards/nearby?lat=${BASE.lat}&lng=${BASE.lng}&radius=1500`);
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 2);
  const d = res.body.items.map((i) => i.distanceMeters);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  assert.ok(res.body.items.every((i) => H.OPEN_STATUSES.includes(i.status)));
});

test('my reports, overview stats, leaderboard, heatmap', async () => {
  const t = await guest('device-merge-aaaa');
  const mine = await request(app).get('/api/reports/mine').set('Authorization', `Bearer ${t}`);
  assert.equal(mine.body.total, 4);
  assert.ok(mine.body.items[0].hazardStatus);

  const ov = await request(app).get('/api/stats/overview');
  assert.equal(ov.body.trend.length, 14);
  assert.ok(ov.body.totals.open > 0);
  assert.ok(ov.body.trend.at(-1).reports > 0, 'today has reports');

  const lb = await request(app).get('/api/stats/leaderboard');
  assert.ok(lb.body.items.length > 0);

  const heat = await request(app).get('/api/hazards/heatmap');
  assert.ok(heat.body.points.length > 0);
  assert.equal(heat.body.points[0].length, 3);
});

test('guest upgrades to a full account and keeps points', async () => {
  const t = await guest('device-upgrade-01');
  await report(t, { latitude: BASE.lat + offset(7000) });
  const reg = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${t}`)
    .send({ name: 'Riya', email: 'riya@example.com', password: 'secret12' });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.user.isGuest, false);
  assert.equal(reg.body.user.points, 10);
});

test('priority rises with severity, crowd and age', () => {
  const now = Date.now();
  const base = { status: 'verified', severity_score: 50, unique_reporters: 1, avg_speed: 20, first_reported_at: now };
  const p0 = H.computePriority(base, now);
  assert.ok(H.computePriority({ ...base, severity_score: 90 }, now) > p0);
  assert.ok(H.computePriority({ ...base, unique_reporters: 8 }, now) > p0);
  assert.ok(H.computePriority({ ...base, first_reported_at: now - 20 * 86400000 }, now) > p0);
  assert.equal(H.computePriority({ ...base, status: 'resolved' }, now), 0);
});

test('demo seed runs cleanly on a fresh database', () => {
  const db2 = open(path.join(tmp, 'seed.db'));
  const r = seed(db2);
  assert.equal(r.skipped, false);
  const n = db2.prepare('SELECT COUNT(*) n FROM hazards').get().n;
  assert.ok(n >= 30, `expected many hazards, got ${n}`);
  const statuses = db2.prepare('SELECT DISTINCT status FROM hazards').all().map((x) => x.status);
  assert.ok(statuses.includes('resolved') && statuses.includes('verified'));
});
