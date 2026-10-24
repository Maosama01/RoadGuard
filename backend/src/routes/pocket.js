'use strict';

/** Pocket mode and coverage: /api/sensor-hits, /api/drives, /api/coverage */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z, parse, optionalNumber } = require('../validate');
const { requireAuth, requireRole } = require('../auth');
const { parseBbox } = require('../geo');
const { ingestSensorHits, pendingClusters } = require('../sensors');
const { ingestDrive, coverageCells } = require('../coverage');

const hitSchema = z.object({
  clientId: z.string().trim().min(6).max(64),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracy: optionalNumber(z.coerce.number().min(0).max(5000)),
  speed: z.coerce.number().min(0).max(300),
  heading: optionalNumber(z.coerce.number().min(0).max(360)),
  shock: z.coerce.number().min(0).max(200),
  timestamp: z.coerce.number().int().positive(),
  roadName: z.string().trim().max(160).optional(),
});

const driveSchema = z
  .object({
    clientId: z.string().trim().min(6).max(64),
    mode: z.enum(['camera', 'pocket']),
    startedAt: z.coerce.number().int().positive(),
    endedAt: z.coerce.number().int().positive(),
    distanceMeters: z.coerce.number().min(0).max(2000000),
    path: z
      .array(
        z
          .array(z.number())
          .min(2)
          .max(3)
          .refine((p) => Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180, 'each point must be [latitude, longitude, timestamp]')
      )
      .max(2000),
  })
  .refine((d) => d.endedAt >= d.startedAt, { message: 'endedAt must not be before startedAt', path: ['endedAt'] });

module.exports = function pocketRoutes(db) {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 120,
    keyGenerator: (req) => `u${req.user.id}`,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Too many uploads in a short time. They will retry automatically.' },
  });

  router.post('/sensor-hits', requireAuth, limiter, (req, res) => {
    const body = parse(z.object({ hits: z.array(hitSchema).min(1).max(200) }), req.body, res);
    if (!body) return;
    const result = ingestSensorHits(db, req.user, body.hits);
    res.json({ success: true, ...result });
  });

  /** Dashboard: pocket-mode jolts not yet confirmed as a rough patch, grouped by spot. */
  router.get('/sensor-hits/pending', requireRole('authority', 'admin'), (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(30).default(30) }), req.query, res);
    if (!q) return;
    res.json({ success: true, items: pendingClusters(db, { days: q.days }) });
  });

  router.post('/drives', requireAuth, limiter, (req, res) => {
    const body = parse(driveSchema, req.body, res);
    if (!body) return;
    const result = ingestDrive(db, req.user, body);
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      duplicate: result.duplicate,
      cells: result.cells,
      distanceMeters: result.distanceMeters,
    });
  });

  router.get('/coverage', (req, res) => {
    const q = parse(
      z.object({ days: z.coerce.number().int().min(1).max(365).default(30), bbox: z.string().optional() }),
      req.query,
      res
    );
    if (!q) return;
    const bbox = q.bbox ? parseBbox(q.bbox) : null;
    if (q.bbox && !bbox) return res.status(400).json({ success: false, message: 'bbox: use minLng,minLat,maxLng,maxLat' });
    res.json({ success: true, cells: coverageCells(db, { bbox, days: q.days }) });
  });

  return router;
};
