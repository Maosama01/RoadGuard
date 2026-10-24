'use strict';

const path = require('path');
const express = require('express');
const { z, parse } = require('../validate');
const { requireAuth, requireRole } = require('../auth');
const { boundingBox, parseBbox, distanceMeters } = require('../geo');
const { makeUpload, removeUpload, uploadErrors } = require('../uploads');
const H = require('../hazards');
const A = require('../accountability');

const SORTS = {
  priority: 'priority DESC, severity_score DESC',
  recent: 'last_reported_at DESC',
  severity: 'severity_score DESC',
  reports: 'unique_reporters DESC, report_count DESC',
  oldest: 'first_reported_at ASC',
};

function listFilter(query) {
  const where = [];
  const params = [];
  const status = String(query.status || '').trim();
  if (status === 'open') {
    where.push(`status IN (${H.OPEN_STATUSES.map(() => '?').join(',')})`);
    params.push(...H.OPEN_STATUSES);
  } else if (status && status !== 'all') {
    const list = status.split(',').filter((s) => H.STATUSES.includes(s));
    if (list.length) {
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (query.type) {
    const list = String(query.type).split(',').filter((t) => H.TYPES.includes(t));
    if (list.length) {
      where.push(`type IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (query.severity) {
    const list = String(query.severity).toUpperCase().split(',').filter((s) => ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(s));
    if (list.length) {
      where.push(`severity_level IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  const bbox = parseBbox(query.bbox);
  if (bbox) {
    where.push('lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
    params.push(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
  }
  if (query.q) {
    const q = String(query.q).trim();
    // "%" and "_" typed by a person are literal characters, not wildcards.
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(road_name LIKE ? ESCAPE '\\' OR area LIKE ? ESCAPE '\\' OR CAST(id AS TEXT) = ?)");
    params.push(like, like, q.replace(/^#/, ''));
  }
  if (query.likelyFixed === '1') where.push('clean_passes >= 5');
  if (query.contractor) {
    const id = Number(query.contractor);
    if (Number.isInteger(id) && id > 0) {
      where.push('contractor_id = ?');
      params.push(id);
    }
  }
  if (query.overdue === '1') {
    where.push(`due_at IS NOT NULL AND due_at < ? AND status IN (${H.OPEN_STATUSES.map(() => '?').join(',')})`);
    params.push(Date.now(), ...H.OPEN_STATUSES);
  }
  if (query.warranty === '1') where.push('under_warranty = 1');
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = function hazardRoutes(db, baseUrlOf) {
  const router = express.Router();
  const upload = makeUpload();

  router.get('/', (req, res) => {
    A.escalate(db);
    const { sql, params } = listFilter(req.query);
    const order = SORTS[req.query.sort] || SORTS.priority;
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 100, 1), 1000);
    const offset = Math.max(Math.floor(Number(req.query.offset)) || 0, 0);
    const rows = db.prepare(`SELECT * FROM hazards ${sql} ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) n FROM hazards ${sql}`).get(...params).n;
    const base = baseUrlOf(req);
    const lk = H.lookups(db);
    res.json({ success: true, total, items: rows.map((h) => H.serializeHazard(h, base, {}, lk)) });
  });

  /** Lightweight feed for in-car alerts: open hazards around a point, nearest first. */
  router.get('/nearby', (req, res) => {
    const q = parse(
      z.object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        radius: z.coerce.number().min(50).max(20000).default(2000),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
      res
    );
    if (!q) return;
    const box = boundingBox(q.lat, q.lng, q.radius);
    const rows = db
      .prepare(
        `SELECT id, type, lat, lng, status, severity_level, severity_score, report_count, unique_reporters, road_name
         FROM hazards
         WHERE status IN (${H.OPEN_STATUSES.map(() => '?').join(',')})
           AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
      )
      .all(...H.OPEN_STATUSES, box.minLat, box.maxLat, box.minLng, box.maxLng);
    const items = rows
      .map((h) => ({ h, d: distanceMeters(q.lat, q.lng, h.lat, h.lng) }))
      .filter((x) => x.d <= q.radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, q.limit)
      .map(({ h, d }) => ({
        id: h.id,
        type: h.type,
        latitude: h.lat,
        longitude: h.lng,
        status: h.status,
        severityLevel: h.severity_level,
        severityScore: h.severity_score,
        reportCount: h.report_count,
        uniqueReporters: h.unique_reporters,
        roadName: h.road_name,
        distanceMeters: Math.round(d),
      }));
    res.json({ success: true, items });
  });

  /** [lat, lng, weight 0..1] triples for heat layers. */
  router.get('/heatmap', (req, res) => {
    const { sql, params } = listFilter({ status: req.query.status || 'open', bbox: req.query.bbox, type: req.query.type });
    const rows = db.prepare(`SELECT lat, lng, severity_score, unique_reporters FROM hazards ${sql} LIMIT 20000`).all(...params);
    res.json({
      success: true,
      points: rows.map((h) => [
        h.lat,
        h.lng,
        Math.round(Math.min(1, (h.severity_score / 100) * (0.7 + Math.min(h.unique_reporters, 6) * 0.05)) * 100) / 100,
      ]),
    });
  });

  router.get('/export.csv', requireRole('authority', 'admin'), (req, res) => {
    const { sql, params } = listFilter(req.query);
    const rows = db.prepare(`SELECT * FROM hazards ${sql} ORDER BY priority DESC`).all(...params);
    const cols = [
      'id', 'type', 'status', 'severity_level', 'severity_score', 'priority', 'unique_reporters', 'report_count',
      'road_name', 'lat', 'lng', 'assigned_team', 'first_reported_at', 'last_reported_at', 'resolved_at',
      'contractor', 'tender_id', 'due_at', 'escalation_level', 'under_warranty',
    ];
    const iso = (t) => (t ? new Date(t).toISOString() : '');
    const lk = H.lookups(db);
    const lines = [cols.join(',')].concat(
      rows.map((h) => {
        const c = lk.contractor(h.contractor_id);
        const seg = lk.segment(h.segment_id);
        const row = { ...h, contractor: c ? c.name : '', tender_id: seg ? seg.tender_id : '' };
        return cols.map((k) => csvCell(k.endsWith('_at') ? iso(row[k]) : row[k])).join(',');
      })
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="roadguard-hazards-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  });

  router.get('/:id', (req, res) => {
    A.escalate(db);
    const h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(Number(req.params.id));
    if (!h) return res.status(404).json({ success: false, message: 'Hazard not found.' });
    const base = baseUrlOf(req);
    const reports = db
      .prepare(
        `SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id = r.user_id
         WHERE r.hazard_id = ? ORDER BY r.detected_at DESC LIMIT 30`
      )
      .all(h.id);
    const events = db
      .prepare(
        `SELECT e.*, u.name AS actor FROM hazard_events e LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.hazard_id = ? ORDER BY e.created_at ASC`
      )
      .all(h.id);
    const votes = db
      .prepare(`SELECT vote, COUNT(DISTINCT user_id) n FROM hazard_votes WHERE hazard_id = ? AND vote <> 'pass' GROUP BY vote`)
      .all(h.id);
    const myVote = req.user
      ? db
          .prepare(`SELECT vote FROM hazard_votes WHERE hazard_id = ? AND user_id = ? AND vote <> 'pass' ORDER BY created_at DESC LIMIT 1`)
          .get(h.id, req.user.id)
      : null;
    const isStaff = req.user && ['authority', 'admin'].includes(req.user.role);

    res.json({
      success: true,
      hazard: H.serializeHazard(
        h,
        base,
        {
          votes: Object.fromEntries(votes.map((v) => [v.vote, v.n])),
          myVote: myVote ? myVote.vote : null,
        },
        H.lookups(db)
      ),
      reports: reports.map((r) => ({
        ...H.serializeReport(r, base, h),
        reporter: isStaff ? r.reporter : undefined,
      })),
      timeline: events.map((e) => ({
        id: e.id,
        type: e.type,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        note: e.note,
        actor: !e.actor_id
          ? 'RoadGuard'
          : isStaff
            ? e.actor
            : ['created', 'reopened', 'vote_fixed', 'vote_present'].includes(e.type)
              ? 'A driver'
              : 'City team',
        createdAt: e.created_at,
      })),
    });
  });

  router.post('/:id/vote', requireAuth, (req, res) => {
    const body = parse(z.object({ vote: z.enum(['present', 'fixed', 'pass']) }), req.body, res);
    if (!body) return;
    const before = db.prepare('SELECT status FROM hazards WHERE id = ?').get(Number(req.params.id));
    const result = H.castVote(db, Number(req.params.id), req.user, body.vote);
    if (!result) return res.status(404).json({ success: false, message: 'Hazard not found.' });
    const reopened = before && before.status === 'resolved' && result.hazard.status === 'reported';
    const message = reopened
      ? "Thanks. It's back on the city's repair list."
      : body.vote === 'pass'
        ? 'Noted.'
        : result.duplicate
          ? 'You already told us. Thanks!'
          : body.vote === 'fixed'
            ? result.hazard.status === 'resolved'
              ? 'Marked as fixed. Thanks for closing the loop!'
              : 'Thanks! We will mark it fixed once others confirm.'
            : 'Thanks for confirming. This raises its priority.';
    res.json({
      success: true,
      message,
      pointsAwarded: result.pointsAwarded,
      hazard: H.serializeHazard(result.hazard, baseUrlOf(req), {}, H.lookups(db)),
    });
  });

  /** A ready-to-send formal complaint (English or Hindi) for this hazard. Public. */
  router.get('/:id/complaint', (req, res) => {
    A.escalate(db);
    const h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(Number(req.params.id));
    if (!h) return res.status(404).json({ success: false, message: 'Hazard not found.' });
    const lang = req.query.lang === 'hi' ? 'hi' : 'en';
    res.json({ success: true, lang, ...A.complaint(db, h, { base: baseUrlOf(req), lang }) });
  });

  /** Repair proof: the contractor's after photo closes the hazard. */
  router.post('/:id/repair', requireRole('authority', 'admin'), upload.single('image'), (req, res) => {
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
    let h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(Number(req.params.id));
    if (!h) {
      removeUpload(req.file);
      return res.status(404).json({ success: false, message: 'Hazard not found.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'image: attach the repair photo (JPEG or PNG).' });
    }
    if (h.status === 'rejected') {
      removeUpload(req.file);
      return res.status(409).json({ success: false, message: 'This hazard was rejected. Reopen it before recording a repair.' });
    }
    const file = path.basename(req.file.path);
    db.transaction(() => {
      const now = Date.now();
      const lk = H.lookups(db);
      const c = lk.contractor(h.contractor_id);
      const text = note || `Repair photo uploaded${c ? ` for ${c.name}` : ''}.`;
      db.prepare('UPDATE hazards SET repair_image = ?, updated_at = ? WHERE id = ?').run(file, now, h.id);
      if (h.status === 'resolved') {
        db.prepare("UPDATE hazards SET resolved_by = 'contractor' WHERE id = ?").run(h.id);
        H.addEvent(db, h.id, req.user.id, 'repaired', { note: text, at: now });
      } else {
        H.setStatus(db, { ...h, repair_image: file }, 'resolved', req.user.id, { type: 'repaired', resolvedBy: 'contractor', note: text, now });
      }
    })();
    h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(h.id);
    res.json({ success: true, message: 'Repair recorded.', hazard: H.serializeHazard(h, baseUrlOf(req), {}, H.lookups(db)) });
  });

  /** Authority workflow: change status, assign a crew, add a note. */
  router.patch('/:id', requireRole('authority', 'admin'), (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(H.STATUSES).optional(),
        assignedTeam: z.string().trim().max(80).nullable().optional(),
        note: z.string().trim().max(1000).optional(),
      }),
      req.body,
      res
    );
    if (!body) return;
    let h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(Number(req.params.id));
    if (!h) return res.status(404).json({ success: false, message: 'Hazard not found.' });

    db.transaction(() => {
      const now = Date.now();
      if (body.assignedTeam !== undefined) body.assignedTeam = body.assignedTeam || null;
      if (body.assignedTeam !== undefined && body.assignedTeam !== (h.assigned_team || null)) {
        db.prepare('UPDATE hazards SET assigned_team = ?, updated_at = ? WHERE id = ?').run(body.assignedTeam || null, now, h.id);
        H.addEvent(db, h.id, req.user.id, 'assigned', { note: body.assignedTeam ? `Assigned to ${body.assignedTeam}` : 'Unassigned', at: now });
        h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(h.id);
        if (body.assignedTeam && !body.status && ['reported', 'verified'].includes(h.status)) {
          h = H.setStatus(db, h, 'assigned', req.user.id, { now });
        }
      }
      if (body.status && body.status !== h.status) {
        // Repairs should come with proof; closing without it is allowed but stays on the record.
        const note = body.status === 'resolved' && !h.repair_image
          ? [body.note, 'Closed without repair photo.'].filter(Boolean).join(' ')
          : body.note;
        h = H.setStatus(db, h, body.status, req.user.id, { note, resolvedBy: 'authority', now });
      } else if (body.note) {
        H.addEvent(db, h.id, req.user.id, 'comment', { note: body.note, at: now });
      }
    })();

    h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(h.id);
    res.json({ success: true, hazard: H.serializeHazard(h, baseUrlOf(req), {}, H.lookups(db)) });
  });

  router.use(uploadErrors);
  return router;
};
