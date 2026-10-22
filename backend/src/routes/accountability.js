'use strict';

/** Contractors and road segments: /api/contractors, /api/segments */
const express = require('express');
const { z, parse, optionalNumber } = require('../validate');
const { requireRole } = require('../auth');
const H = require('../hazards');
const A = require('../accountability');

const staff = requireRole('authority', 'admin');
const isStaff = (req) => !!req.user && ['authority', 'admin'].includes(req.user.role);

const contractorSchema = z.object({
  name: z.string().trim().min(2, 'Enter the contractor name').max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
});

const nullableText = (max) => z.string().trim().max(max).nullable().optional();
const segmentSchema = z.object({
  roadPattern: z.string().trim().min(2, 'Enter the road name or part of it').max(120),
  ward: nullableText(80),
  contractorId: z.coerce.number().int().positive().nullable().optional(),
  contractorName: nullableText(120),
  officerName: nullableText(120),
  officerContact: nullableText(120),
  tenderId: nullableText(80),
  slaDays: optionalNumber(z.coerce.number().int().min(1).max(365)),
  // ms since epoch, or a "YYYY-MM-DD" date, or null to clear.
  warrantyUntil: z.union([z.number().int().positive(), z.string().trim(), z.null()]).optional(),
  minLat: z.number().min(-90).max(90).nullable().optional(),
  minLng: z.number().min(-180).max(180).nullable().optional(),
  maxLat: z.number().min(-90).max(90).nullable().optional(),
  maxLng: z.number().min(-180).max(180).nullable().optional(),
});

module.exports = function accountabilityRoutes(db) {
  const router = express.Router();

  // ---------------------------------------------------------------- contractors
  router.get('/contractors', (req, res) => {
    A.escalate(db);
    const items = A.scorecards(db).map((c) => (isStaff(req) ? c : { ...c, email: undefined }));
    res.json({ success: true, items });
  });

  router.post('/contractors', staff, (req, res) => {
    const body = parse(contractorSchema, req.body, res);
    if (!body) return;
    if (db.prepare('SELECT 1 FROM contractors WHERE name = ? COLLATE NOCASE').get(body.name)) {
      return res.status(409).json({ success: false, message: 'A contractor with this name already exists.' });
    }
    const info = db
      .prepare('INSERT INTO contractors (name, phone, email, created_at) VALUES (?, ?, ?, ?)')
      .run(body.name, body.phone || null, body.email || null, Date.now());
    const card = A.scorecards(db).find((c) => c.id === Number(info.lastInsertRowid));
    res.status(201).json({ success: true, contractor: card });
  });

  router.patch('/contractors/:id', staff, (req, res) => {
    const body = parse(contractorSchema.partial(), req.body, res);
    if (!body) return;
    const c = db.prepare('SELECT * FROM contractors WHERE id = ?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ success: false, message: 'Contractor not found.' });
    if (body.name && db.prepare('SELECT 1 FROM contractors WHERE name = ? COLLATE NOCASE AND id <> ?').get(body.name, c.id)) {
      return res.status(409).json({ success: false, message: 'A contractor with this name already exists.' });
    }
    db.transaction(() => {
      db.prepare('UPDATE contractors SET name = ?, phone = ?, email = ? WHERE id = ?').run(
        body.name || c.name,
        body.phone === undefined ? c.phone : body.phone || null,
        body.email === undefined ? c.email : body.email || null,
        c.id
      );
      // Keep the crew label on open hazards in step with a renamed contractor.
      if (body.name && body.name !== c.name) {
        db.prepare('UPDATE hazards SET assigned_team = ? WHERE contractor_id = ? AND assigned_team = ?').run(body.name, c.id, c.name);
      }
    })();
    res.json({ success: true, contractor: A.scorecards(db).find((x) => x.id === c.id) });
  });

  // ---------------------------------------------------------------- segments
  function toRow(body, existing = {}) {
    const pick = (k, col) => (body[k] === undefined ? existing[col] ?? null : body[k]);
    const rec = {
      road_pattern: pick('roadPattern', 'road_pattern'),
      ward: pick('ward', 'ward'),
      officer_name: pick('officerName', 'officer_name'),
      officer_contact: pick('officerContact', 'officer_contact'),
      tender_id: pick('tenderId', 'tender_id'),
      sla_days: body.slaDays === undefined ? existing.sla_days ?? 7 : body.slaDays,
      min_lat: pick('minLat', 'min_lat'),
      min_lng: pick('minLng', 'min_lng'),
      max_lat: pick('maxLat', 'max_lat'),
      max_lng: pick('maxLng', 'max_lng'),
    };
    let warranty = existing.warranty_until ?? null;
    if (body.warrantyUntil !== undefined) {
      if (body.warrantyUntil === null || body.warrantyUntil === '') warranty = null;
      else if (typeof body.warrantyUntil === 'number') warranty = body.warrantyUntil;
      else {
        warranty = A.parseDay(body.warrantyUntil);
        if (warranty === null) return { error: 'warrantyUntil: use a date like 2027-03-31' };
      }
    }
    const { value, error } = A.cleanSegment({ ...rec, sla_days: String(rec.sla_days) });
    if (error) return { error: error.replace(/_([a-z])/g, (_m, ch) => ch.toUpperCase()) };
    value.warranty_until = warranty;

    let contractorId = body.contractorId === undefined ? existing.contractor_id ?? null : body.contractorId;
    if (body.contractorName) contractorId = A.findOrCreateContractor(db, body.contractorName).contractor.id;
    if (contractorId && !db.prepare('SELECT 1 FROM contractors WHERE id = ?').get(contractorId)) {
      return { error: 'contractorId: no such contractor' };
    }
    value.contractor_id = contractorId || null;
    return { value };
  }

  router.get('/segments', staff, (req, res) => {
    const rows = db.prepare('SELECT * FROM road_segments ORDER BY road_pattern COLLATE NOCASE, id').all();
    const lk = H.lookups(db);
    const counts = new Map(
      db
        .prepare(`SELECT segment_id id, COUNT(*) n FROM hazards WHERE segment_id IS NOT NULL AND status IN (${H.OPEN_STATUSES.map(() => '?').join(',')}) GROUP BY segment_id`)
        .all(...H.OPEN_STATUSES)
        .map((r) => [r.id, r.n])
    );
    res.json({ success: true, items: rows.map((s) => ({ ...A.serializeSegment(s, lk), openHazards: counts.get(s.id) || 0 })) });
  });

  router.get('/segments/template.csv', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="roadguard-road-segments.csv"');
    res.send(A.CSV_TEMPLATE);
  });

  router.post('/segments', staff, (req, res) => {
    const body = parse(segmentSchema, req.body, res);
    if (!body) return;
    const { value, error } = toRow(body);
    if (error) return res.status(400).json({ success: false, message: error });
    const id = A.insertSegment(db, value);
    const assigned = A.assignAllEligible(db);
    const seg = db.prepare('SELECT * FROM road_segments WHERE id = ?').get(id);
    res.status(201).json({ success: true, segment: A.serializeSegment(seg, H.lookups(db)), assigned });
  });

  router.post('/segments/import', staff, (req, res) => {
    const body = parse(z.object({ csv: z.string().min(1, 'Paste the CSV text').max(900000) }), req.body, res);
    if (!body) return;
    res.json({ success: true, ...A.importSegments(db, body.csv) });
  });

  router.patch('/segments/:id', staff, (req, res) => {
    const existing = db.prepare('SELECT * FROM road_segments WHERE id = ?').get(Number(req.params.id));
    if (!existing) return res.status(404).json({ success: false, message: 'Road segment not found.' });
    const body = parse(segmentSchema.partial(), req.body, res);
    if (!body) return;
    const { value, error } = toRow(body, existing);
    if (error) return res.status(400).json({ success: false, message: error });
    db.prepare(
      `UPDATE road_segments SET road_pattern=@road_pattern, ward=@ward, contractor_id=@contractor_id, officer_name=@officer_name,
         officer_contact=@officer_contact, tender_id=@tender_id, sla_days=@sla_days, warranty_until=@warranty_until,
         min_lat=@min_lat, min_lng=@min_lng, max_lat=@max_lat, max_lng=@max_lng
       WHERE id=@id`
    ).run({ ...value, id: existing.id });
    const assigned = A.assignAllEligible(db);
    const seg = db.prepare('SELECT * FROM road_segments WHERE id = ?').get(existing.id);
    res.json({ success: true, segment: A.serializeSegment(seg, H.lookups(db)), assigned });
  });

  router.delete('/segments/:id', staff, (req, res) => {
    const info = db.prepare('DELETE FROM road_segments WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ success: false, message: 'Road segment not found.' });
    res.json({ success: true });
  });

  return router;
};
