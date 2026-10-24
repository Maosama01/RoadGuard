'use strict';

// Regressions found while testing real drives around UPES (October 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-fix-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'test.db');

const request = require('supertest');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { ensureStaff } = require('../src/createAdmin');
const H = require('../src/hazards');

const db = open(process.env.DB_FILE);
const app = createApp(db, { logging: false });
const BASE = { lat: 30.3678, lng: 77.9826 };
const north = (m) => m / 111320;

async function guest(deviceId) {
  const res = await request(app).post('/api/auth/guest').send({ deviceId });
  assert.equal(res.status, 200);
  return res.body.token;
}
const send = (token, body) =>
  request(app)
    .post('/api/reports')
    .set('Authorization', `Bearer ${token}`)
    .send({ latitude: BASE.lat, longitude: BASE.lng, confidence: 0.5, severityScore: 50, speed: 18, accuracy: 4, timestamp: Date.now(), ...body });

test('Plus Codes and "Unnamed Road" are never stored as road names', async () => {
  for (const bad of ['CX7C+2JQ', '9X9J+5P8', 'Unnamed Road', 'unknown', '42']) assert.equal(H.cleanRoadName(bad), null, bad);
  assert.equal(H.cleanRoadName('  Chakrata   Road '), 'Chakrata Road');
  const t = await guest('device-plus-code');
  const res = await send(t, { roadName: '9X9J+5P8', latitude: 30.1, longitude: 77.1 });
  assert.equal(res.status, 201);
  assert.equal(res.body.hazard.roadName, null);
});

test('old rows with unusable names are cleaned on start', () => {
  const id = db
    .prepare(`INSERT INTO hazards (type, lat, lng, road_name, status, first_reported_at, last_reported_at, updated_at)
              VALUES ('pothole', 1, 1, 'CX7C+2Q5', 'reported', 1, 1, 1)`)
    .run().lastInsertRowid;
  assert.ok(H.cleanStoredRoadNames(db) >= 1);
  assert.equal(db.prepare('SELECT road_name FROM hazards WHERE id = ?').get(id).road_name, null);
});

test('quick repeated taps on one pothole make one hazard, not three', async () => {
  const t = await guest('device-tapper');
  const a = await send(t, { source: 'manual', roadName: 'Bidholi Road' });
  const b = await send(t, { source: 'manual', roadName: 'Bidholi Road', latitude: BASE.lat + north(18) });
  const c = await send(t, { source: 'manual', roadName: 'Bidholi Road', latitude: BASE.lat + north(36) });
  assert.equal(a.body.isNewHazard, true);
  assert.equal(b.body.hazardId, a.body.hazardId);
  assert.equal(c.body.hazardId, a.body.hazardId);
  assert.equal(c.body.pointsAwarded, 0, 'no extra points for tapping the same pothole again');
});

test('taps by different drivers 100 m apart stay separate hazards', async () => {
  const t1 = await guest('device-far-1');
  const t2 = await guest('device-far-2');
  const a = await send(t1, { source: 'manual', latitude: 30.2, longitude: 77.5 });
  const b = await send(t2, { source: 'manual', latitude: 30.2 + north(100), longitude: 77.5 });
  assert.notEqual(a.body.hazardId, b.body.hazardId);
});

test('merge radius grows with GPS error but stays bounded', () => {
  assert.equal(H.mergeRadiusFor({ accuracy: 4, source: 'auto' }), 15);
  assert.equal(H.mergeRadiusFor({ accuracy: 15, source: 'auto' }), 22.5);
  assert.equal(H.mergeRadiusFor({ accuracy: 300, source: 'auto' }), 30);
  assert.equal(H.mergeRadiusFor({ accuracy: 4, source: 'manual' }), 25);
});

test('saving an empty crew name does not log a fake "Unassigned" event', async () => {
  ensureStaff(db, { email: 'ops@test.local', password: 'secret123', name: 'Ops', role: 'authority' });
  const login = await request(app).post('/api/auth/login').send({ email: 'ops@test.local', password: 'secret123' });
  const staff = login.body.token;
  const t = await guest('device-crew');
  const r = await send(t, { latitude: 30.05, longitude: 77.05 });
  const id = r.body.hazardId;
  const res = await request(app).patch(`/api/hazards/${id}`).set('Authorization', `Bearer ${staff}`).send({ assignedTeam: '' });
  assert.equal(res.status, 200);
  const n = db.prepare(`SELECT COUNT(*) n FROM hazard_events WHERE hazard_id = ? AND type = 'assigned'`).get(id).n;
  assert.equal(n, 0);
});

test('search treats % and _ literally, and bad limits are clamped', async () => {
  const pct = await request(app).get('/api/hazards?status=all&q=%25');
  assert.equal(pct.status, 200);
  assert.equal(pct.body.total, 0);
  const neg = await request(app).get('/api/hazards?status=all&limit=-5');
  assert.equal(neg.status, 200);
  assert.ok(neg.body.items.length <= 1);
});

test('"today" in stats starts at midnight India time, not UTC', async () => {
  const res = await request(app).get('/api/stats/overview?days=7');
  assert.equal(res.status, 200);
  const last = res.body.trend[res.body.trend.length - 1].date;
  const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  assert.equal(last, istToday);
});

test('an unnamed road still gets a useful title from its area', async () => {
  const t = await guest('device-area');
  const res = await send(t, { latitude: 30.6, longitude: 77.6, roadName: 'Unnamed Road', area: 'Bidholi' });
  assert.equal(res.status, 201);
  assert.equal(res.body.hazard.roadName, null);
  assert.equal(res.body.hazard.area, 'Bidholi');
  const page = await request(app).get(`/h/${res.body.hazardId}`);
  assert.match(page.text, /Near Bidholi/);
});

test('an old token is quietly replaced so active drivers never get signed out', async () => {
  const jwt = require('jsonwebtoken');
  const config = require('../src/config');
  const t = await guest('device-old-token');
  const { sub, role } = jwt.decode(t);
  const old = jwt.sign({ sub, role, iat: Math.floor(Date.now() / 1000) - 10 * 24 * 3600 }, config.jwtSecret, { expiresIn: '30d' });
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${old}`);
  assert.equal(res.status, 200);
  const fresh = res.headers['x-roadguard-token'];
  assert.ok(fresh, 'refresh header sent');
  assert.equal(jwt.decode(fresh).sub, sub);
  const recent = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${t}`);
  assert.equal(recent.headers['x-roadguard-token'], undefined, 'no churn for a fresh token');
});

test('an expired guest can get its same account back from its device id', async () => {
  const a = await guest('device-expired');
  const b = await guest('device-expired');
  const jwt = require('jsonwebtoken');
  assert.equal(jwt.decode(a).sub, jwt.decode(b).sub);
});

// ------------------------------------------------------------------ pocket mode, one driver
const DAY_MS = 86400000;
function hitAt(lat, lng, at, extra = {}) {
  return { clientId: `hit-${lat}-${lng}-${at}-${Math.random()}`, latitude: lat, longitude: lng, accuracy: 8, speed: 30, shock: 9, timestamp: at, ...extra };
}

test('one driver feeling the same spot on 3 different days makes a rough patch; one day does not', async () => {
  const t = await guest('device-commuter');
  const lat = 30.71, lng = 77.71;
  const now = Date.now();
  // Three jolts on the same morning: still one day of evidence.
  let r = await request(app).post('/api/sensor-hits').set('Authorization', `Bearer ${t}`)
    .send({ hits: [hitAt(lat, lng, now - 3 * DAY_MS), hitAt(lat, lng + 0.00002, now - 3 * DAY_MS + 60000), hitAt(lat, lng, now - 3 * DAY_MS + 120000)] });
  assert.equal(r.body.promoted, 0);
  r = await request(app).post('/api/sensor-hits').set('Authorization', `Bearer ${t}`).send({ hits: [hitAt(lat + 0.00003, lng, now - 2 * DAY_MS)] });
  assert.equal(r.body.promoted, 0, 'two days is not enough');

  // The dashboard can see what is waiting.
  ensureStaff(db, { email: 'pocket@test.local', password: 'secret123', name: 'Ops', role: 'authority' });
  const staff = (await request(app).post('/api/auth/login').send({ email: 'pocket@test.local', password: 'secret123' })).body.token;
  const pending = await request(app).get('/api/sensor-hits/pending').set('Authorization', `Bearer ${staff}`);
  assert.equal(pending.status, 200);
  const spot = pending.body.items.find((c) => Math.abs(c.latitude - lat) < 0.0005);
  assert.ok(spot, 'waiting jolts are listed');
  assert.equal(spot.jolts, 4);
  assert.equal(spot.drivers, 1);
  assert.equal(spot.days, 2);
  const anon = await request(app).get('/api/sensor-hits/pending');
  assert.equal(anon.status, 401, 'drivers and the public do not see raw jolts');

  r = await request(app).post('/api/sensor-hits').set('Authorization', `Bearer ${t}`).send({ hits: [hitAt(lat, lng, now - DAY_MS)] });
  assert.equal(r.body.promoted, 1, 'third day promotes');
  const h = db.prepare(`SELECT * FROM hazards WHERE type = 'bump' AND lat BETWEEN ? AND ?`).get(lat - 0.001, lat + 0.001);
  assert.ok(h);
  const note = db.prepare(`SELECT note FROM hazard_events WHERE hazard_id = ? AND type = 'created'`).get(h.id).note;
  assert.match(note, /3 different days/);
});
