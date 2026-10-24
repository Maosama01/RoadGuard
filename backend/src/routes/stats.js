'use strict';

const express = require('express');
const { requireAuth, requireRole, publicUser } = require('../auth');
const { z, parse } = require('../validate');
const H = require('../hazards');
const A = require('../accountability');
const { roadHealth } = require('../coverage');

const config = require('../config');

const DAY = 86400000;
const TZ_MS = config.timeZoneOffsetMinutes * 60000;

/** Midnight in the city's time zone (IST), not the server's (the cloud server runs on UTC). */
function startOfDay(t) {
  return Math.floor((t + TZ_MS) / DAY) * DAY - TZ_MS;
}
/** "2026-10-24" for a time, in the city's time zone. */
const localDate = (t) => new Date(t + TZ_MS).toISOString().slice(0, 10);

module.exports = function statsRoutes(db) {
  const router = express.Router();
  const open = `(${H.OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`;

  /** City-wide numbers for the home screen and the authority dashboard. */
  router.get('/overview', (req, res) => {
    A.escalate(db);
    const days = Math.min(Math.max(Number(req.query.days) || 14, 7), 90);
    const now = Date.now();
    const since = startOfDay(now - (days - 1) * DAY);

    const totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ${open} THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
           SUM(CASE WHEN status IN ${open} AND severity_level = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
           SUM(CASE WHEN status IN ${open} AND severity_level = 'HIGH' THEN 1 ELSE 0 END) AS high,
           SUM(CASE WHEN status IN ${open} AND severity_level = 'MEDIUM' THEN 1 ELSE 0 END) AS medium,
           SUM(CASE WHEN status IN ${open} AND severity_level = 'LOW' THEN 1 ELSE 0 END) AS low,
           SUM(CASE WHEN status = 'reported' THEN 1 ELSE 0 END) AS reported,
           SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) AS assigned,
           SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS inProgress,
           SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN status IN ${open} AND clean_passes >= 5 THEN 1 ELSE 0 END) AS likelyFixed,
           SUM(CASE WHEN status IN ${open} AND due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN status IN ${open} AND under_warranty = 1 THEN 1 ELSE 0 END) AS underWarranty,
           COUNT(*) AS total
         FROM hazards`
      )
      .get(now);
    for (const k of Object.keys(totals)) totals[k] = totals[k] || 0;

    const reportsToday = db.prepare('SELECT COUNT(*) n FROM reports WHERE created_at >= ?').get(startOfDay(now)).n;
    const activeReporters = db
      .prepare('SELECT COUNT(DISTINCT user_id) n FROM reports WHERE created_at >= ?')
      .get(now - 30 * DAY).n;
    const resolution = db
      .prepare(
        `SELECT AVG(resolved_at - first_reported_at) avg, COUNT(*) n FROM hazards
         WHERE status = 'resolved' AND resolved_at >= ?`
      )
      .get(now - 90 * DAY);

    const reportsByDay = db
      .prepare(
        `SELECT (created_at - ?) / ${DAY} AS d, COUNT(*) n FROM reports WHERE created_at >= ? GROUP BY d`
      )
      .all(since, since);
    const resolvedByDay = db
      .prepare(
        `SELECT (resolved_at - ?) / ${DAY} AS d, COUNT(*) n FROM hazards
         WHERE status = 'resolved' AND resolved_at >= ? GROUP BY d`
      )
      .all(since, since);
    const newByDay = db
      .prepare(`SELECT (first_reported_at - ?) / ${DAY} AS d, COUNT(*) n FROM hazards WHERE first_reported_at >= ? GROUP BY d`)
      .all(since, since);
    const trend = Array.from({ length: days }, (_, i) => ({
      date: localDate(since + i * DAY + DAY / 2),
      reports: 0,
      newHazards: 0,
      resolved: 0,
    }));
    for (const r of reportsByDay) if (trend[Math.floor(r.d)]) trend[Math.floor(r.d)].reports = r.n;
    for (const r of newByDay) if (trend[Math.floor(r.d)]) trend[Math.floor(r.d)].newHazards = r.n;
    for (const r of resolvedByDay) if (trend[Math.floor(r.d)]) trend[Math.floor(r.d)].resolved = r.n;

    const topRoads = db
      .prepare(
        `SELECT road_name AS road, COUNT(*) AS hazards, ROUND(AVG(severity_score), 1) AS avgSeverity
         FROM hazards WHERE status IN ${open} AND road_name IS NOT NULL AND road_name <> ''
         GROUP BY road_name ORDER BY hazards DESC, avgSeverity DESC LIMIT 8`
      )
      .all();
    const byType = db
      .prepare(`SELECT type, COUNT(*) n FROM hazards WHERE status IN ${open} GROUP BY type`)
      .all();

    const closed = totals.resolved + totals.rejected;
    const km = db.prepare('SELECT COALESCE(SUM(distance_meters), 0) m, COUNT(*) n FROM drives WHERE ended_at >= ?').get(now - 30 * DAY);
    const kmScanned30d = Math.round(km.m / 100) / 10;
    res.json({
      success: true,
      totals: {
        ...totals,
        reportsToday,
        activeReporters,
        resolutionRate: totals.total ? Math.round((totals.resolved / Math.max(1, totals.total - totals.rejected)) * 100) : 0,
        avgResolutionHours: resolution.n ? Math.round((resolution.avg / 3600000) * 10) / 10 : null,
        closed,
        kmScanned30d,
        drives30d: km.n,
      },
      kmScanned30d,
      byType: Object.fromEntries(byType.map((t) => [t.type, t.n])),
      trend,
      topRoads,
    });
  });

  /** "Your impact" for the profile screen. */
  router.get('/me', requireAuth, (req, res) => {
    const uid = req.user.id;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    const reports = db.prepare('SELECT COUNT(*) n FROM reports WHERE user_id = ?').get(uid).n;
    const discovered = db.prepare('SELECT COUNT(*) n FROM hazards WHERE discovered_by = ?').get(uid).n;
    const touched = db
      .prepare(
        `SELECT
           COUNT(*) AS hazards,
           SUM(CASE WHEN h.status = 'resolved' THEN 1 ELSE 0 END) AS fixed,
           SUM(CASE WHEN h.status IN ${open} THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN h.status = 'verified' OR h.unique_reporters >= 3 THEN 1 ELSE 0 END) AS verified
         FROM hazards h WHERE h.id IN (SELECT DISTINCT hazard_id FROM reports WHERE user_id = ?)`
      )
      .get(uid);
    const reportsThisWeek = db
      .prepare('SELECT COUNT(*) n FROM reports WHERE user_id = ? AND created_at >= ?')
      .get(uid, Date.now() - 7 * DAY).n;
    const driving = db.prepare('SELECT COALESCE(SUM(distance_meters), 0) m, COUNT(*) n FROM drives WHERE user_id = ?').get(uid);
    const rank = db.prepare('SELECT COUNT(*) + 1 n FROM users WHERE points > ? AND is_guest = 0').get(user.points).n;
    const days = db
      .prepare(
        `SELECT DISTINCT date((detected_at + ?) / 1000, 'unixepoch') d FROM reports
         WHERE user_id = ? ORDER BY d DESC LIMIT 60`
      )
      .all(TZ_MS, uid)
      .map((r) => r.d);
    // Consecutive active days ending today or yesterday (city time zone).
    let streak = 0;
    const nowMs = Date.now();
    for (let i = 0; i < 60; i++) {
      const key = localDate(nowMs - i * DAY);
      if (days.includes(key)) streak++;
      else if (i > 0 || streak > 0) break;
    }

    res.json({
      success: true,
      user: publicUser(user),
      stats: {
        reports,
        reportsThisWeek,
        hazardsDiscovered: discovered,
        hazardsContributed: touched.hazards || 0,
        hazardsFixed: touched.fixed || 0,
        hazardsOpen: touched.open || 0,
        hazardsVerified: touched.verified || 0,
        points: user.points,
        rank,
        streakDays: streak,
        kmScanned: Math.round(driving.m / 100) / 10,
        drives: driving.n,
        ...H.levelFor(user.points),
      },
    });
  });

  /** Road Health Index, worst roads first. */
  router.get('/roads', (req, res) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }), req.query, res);
    if (!q) return;
    res.json({ success: true, items: roadHealth(db, { limit: q.limit }) });
  });

  router.get('/leaderboard', (req, res) => {
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 20, 1), 100);
    const rows = db
      .prepare(
        `SELECT u.id, u.name, u.city, u.points, u.is_guest,
                (SELECT COUNT(*) FROM reports r WHERE r.user_id = u.id) AS reports
         FROM users u WHERE u.role = 'citizen' AND u.points > 0 ORDER BY u.points DESC LIMIT ?`
      )
      .all(limit);
    res.json({
      success: true,
      items: rows.map((u, i) => ({
        rank: i + 1,
        id: u.id,
        name: u.is_guest ? `Guardian #${u.id}` : u.name,
        city: u.city,
        points: u.points,
        reports: u.reports,
        isMe: req.user ? req.user.id === u.id : false,
        ...H.levelFor(u.points),
      })),
    });
  });

  // ---- Admin: manage staff accounts ----
  router.get('/users', requireRole('admin'), (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM users WHERE is_guest = 0 ORDER BY role DESC, points DESC LIMIT 500`)
      .all();
    res.json({ success: true, items: rows.map(publicUser) });
  });

  router.patch('/users/:id', requireRole('admin'), (req, res) => {
    const body = parse(
      z.object({ role: z.enum(['citizen', 'authority', 'admin']).optional(), team: z.string().trim().max(80).nullable().optional() }),
      req.body,
      res
    );
    if (!body) return;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
    if (u.id === req.user.id && body.role && body.role !== 'admin') {
      return res.status(400).json({ success: false, message: 'You cannot remove your own admin access.' });
    }
    db.prepare('UPDATE users SET role = COALESCE(?, role), team = ? WHERE id = ?').run(
      body.role || null,
      body.team === undefined ? u.team : body.team,
      u.id
    );
    res.json({ success: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  });

  return router;
};
