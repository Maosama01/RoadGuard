'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR = path.resolve(path.join(__dirname, '..'), process.env.DATA_DIR || './data');

const config = {
  port: Number(process.env.PORT || 5000),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: '30d',
  dataDir: DATA_DIR,
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, 'roadguard.db'),
  uploadDir: path.join(DATA_DIR, 'uploads'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  // Optional link for "Get the RoadGuard app" on public hazard pages (e.g. a Play Store URL).
  appUrl: process.env.APP_URL || '',
  // Dates in notes and complaint letters. IST has no daylight saving, so a fixed offset is exact.
  timeZone: process.env.TIME_ZONE || 'Asia/Kolkata',
  timeZoneOffsetMinutes: Number(process.env.TIME_ZONE_OFFSET_MINUTES || 330),
  admin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Admin',
  },

  // ---- Hazard intelligence tuning ----
  hazard: {
    // Reports of the same type closer than this are treated as the same physical hazard.
    mergeRadiusMeters: 15,
    // Distinct reporters needed before a hazard is auto-verified.
    autoVerifyReporters: 3,
    // Distinct "it's fixed" votes needed (since the last sighting) to close a hazard.
    communityResolveVotes: 3,
    // Clean passes (drove over the spot, no shock) after which the dashboard flags "likely fixed".
    likelyFixedPasses: 5,
    // A resolved hazard that gets a new sighting this long after resolution is reopened.
    reopenGraceMs: 60 * 60 * 1000,
  },

  // ---- Pocket mode (accelerometer + GPS only) ----
  sensor: {
    // Hits closer than this to a hazard confirm it; hits this close to each other corroborate.
    radiusMeters: 15,
    // A spot becomes a "Rough patch" once this many different drivers feel it...
    promoteUsers: Number(process.env.SENSOR_PROMOTE_USERS || 3),
    // ...or once it has been felt on this many different days (one daily commuter is real
    // evidence too; a single speed breaker or door slam on one day is not).
    promoteDays: Number(process.env.SENSOR_PROMOTE_DAYS || 3),
    windowDays: 30,
    maxAgeDays: 14,
    maxAccuracyMeters: 30,
    minSpeedKmh: 10,
  },

  points: {
    newHazard: 10,
    confirmHazard: 3,
    vote: 1,
    hazardFixed: 20,
    sensorConfirm: 1,
    sensorPromote: 5,
  },

  levels: [
    { name: 'Scout', min: 0 },
    { name: 'Spotter', min: 50 },
    { name: 'Ranger', min: 150 },
    { name: 'Guardian', min: 400 },
    { name: 'Road Legend', min: 1000 },
  ],
};

if (config.jwtSecret === 'dev-only-secret-change-me' && process.env.NODE_ENV === 'production') {
  throw new Error('Set JWT_SECRET in .env before running in production.');
}

module.exports = config;
