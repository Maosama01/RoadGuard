'use strict';

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z, parse, optionalNumber } = require('../validate');
const { makeUpload, removeUpload, uploadErrors } = require('../uploads');
const { requireAuth } = require('../auth');
const H = require('../hazards');

const TYPE_ALIASES = { open_drain: 'drain_hole', cracked_surface: 'crack', alligator_crack: 'crack', cracks: 'crack' };

function normalizeType(value) {
  const v = String(value || 'pothole').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const t = TYPE_ALIASES[v] || v;
  return H.TYPES.includes(t) ? t : 'other';
}

const reportSchema = z
  .object({
    clientId: z.string().trim().min(6).max(64).optional(),
    type: z.string().optional(),
    source: z.enum(['auto', 'manual']).optional(),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    accuracy: optionalNumber(z.coerce.number().min(0).max(5000)),
    heading: optionalNumber(z.coerce.number().min(0).max(360)),
    speed: optionalNumber(z.coerce.number().min(0).max(300)),
    confidence: z.coerce.number().min(0).max(1),
    shock: optionalNumber(z.coerce.number().min(0).max(200)),
    severityScore: z.coerce.number().min(0).max(100),
    roadName: z.string().trim().max(160).optional(),
    /** Neighbourhood or locality, for when the phone cannot name the street. */
    area: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
    timestamp: optionalNumber(z.coerce.number().int().positive()),
  })
  .passthrough();

module.exports = function reportRoutes(db, baseUrlOf) {
  const router = express.Router();
  const upload = makeUpload();

  const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 120,
    // Runs after requireAuth, so every request here has a user.
    keyGenerator: (req) => `u${req.user.id}`,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Too many reports in a short time. They will retry automatically.' },
  });

  /** Accepts multipart/form-data (with an `image` file) or plain JSON. */
  router.post('/', requireAuth, limiter, upload.single('image'), (req, res) => {
    const raw = { ...req.body };
    if (raw.lat !== undefined && raw.latitude === undefined) raw.latitude = raw.lat;
    if (raw.lng !== undefined && raw.longitude === undefined) raw.longitude = raw.lng;
    const body = parse(reportSchema, raw, res);
    if (!body) return removeUpload(req.file);

    const maxAgeMs = 14 * 24 * 3600 * 1000;
    if (body.timestamp && body.timestamp < Date.now() - maxAgeMs) {
      removeUpload(req.file);
      return res.status(422).json({ success: false, message: 'This sighting is older than 14 days and was discarded.' });
    }

    const type = normalizeType(body.type);
    if (type === 'bump') {
      removeUpload(req.file);
      return res.status(400).json({
        success: false,
        message: 'type: rough patches come from pocket mode only. Send them to /api/sensor-hits.',
      });
    }

    const result = H.ingestReport(db, req.user, {
      ...body,
      type,
      source: body.source || 'auto',
      image: req.file ? path.basename(req.file.path) : null,
    });
    if (result.duplicate) removeUpload(req.file);

    const base = baseUrlOf(req);
    const message = result.duplicate
      ? 'Already received.'
      : result.isNewHazard
        ? 'New hazard reported. Thank you!'
        : `Confirmed an existing hazard (${result.hazard.report_count} sightings).`;

    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      message,
      reportId: String(result.report.id),
      hazardId: result.hazard.id,
      isNewHazard: result.isNewHazard,
      duplicate: result.duplicate,
      pointsAwarded: result.pointsAwarded,
      hazard: H.serializeHazard(result.hazard, base, {}, H.lookups(db)),
    });
  });

  router.get('/mine', requireAuth, (req, res) => {
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 30, 1), 100);
    const offset = Math.max(Math.floor(Number(req.query.offset)) || 0, 0);
    const rows = db
      .prepare(
        `SELECT r.*, h.status AS h_status, h.report_count AS h_count, h.road_name AS h_road
         FROM reports r JOIN hazards h ON h.id = r.hazard_id
         WHERE r.user_id = ? ORDER BY r.detected_at DESC LIMIT ? OFFSET ?`
      )
      .all(req.user.id, limit, offset);
    const total = db.prepare('SELECT COUNT(*) n FROM reports WHERE user_id = ?').get(req.user.id).n;
    const base = baseUrlOf(req);
    res.json({
      success: true,
      total,
      items: rows.map((r) =>
        H.serializeReport(r, base, { status: r.h_status, report_count: r.h_count, road_name: r.h_road })
      ),
    });
  });

  router.use(uploadErrors);

  return router;
};
