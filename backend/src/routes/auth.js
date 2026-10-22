'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z, parse } = require('../validate');
const { signToken, requireAuth, publicUser } = require('../auth');

module.exports = function authRoutes(db) {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
  });

  const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(120);
  const passwordSchema = z.string().min(6, 'Password needs at least 6 characters').max(128);

  const registerSchema = z.object({
    name: z.string().trim().min(2, 'Tell us your name').max(60),
    email: emailSchema,
    password: passwordSchema,
    city: z.string().trim().max(60).optional(),
  });

  const respond = (res, user, status = 200) =>
    res.status(status).json({ success: true, token: signToken(user), user: publicUser(user) });

  /**
   * Register. If the request carries a guest token, that guest account is upgraded in place
   * so the person keeps every report and point they earned before signing up.
   */
  router.post('/register', limiter, (req, res) => {
    const body = parse(registerSchema, req.body, res);
    if (!body) return;
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email)) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists. Try signing in.' });
    }
    const hash = bcrypt.hashSync(body.password, 10);
    const now = Date.now();
    if (req.user && req.user.is_guest) {
      db.prepare(
        `UPDATE users SET name = ?, email = ?, password_hash = ?, city = COALESCE(?, city), is_guest = 0, last_seen_at = ?
         WHERE id = ?`
      ).run(body.name, body.email, hash, body.city || null, now, req.user.id);
      return respond(res, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
    }
    const info = db
      .prepare(
        `INSERT INTO users (name, email, password_hash, city, role, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'citizen', ?, ?)`
      )
      .run(body.name, body.email, hash, body.city || null, now, now);
    respond(res, db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid), 201);
  });

  router.post('/login', limiter, (req, res) => {
    const body = parse(z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password') }), req.body, res);
    if (!body) return;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email);
    if (!user || !user.password_hash || !bcrypt.compareSync(body.password, user.password_hash)) {
      return res.status(401).json({ success: false, message: 'Email or password is incorrect.' });
    }
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), user.id);
    respond(res, user);
  });

  /** Zero-friction start: one account per device, upgradeable later via /register. */
  router.post('/guest', limiter, (req, res) => {
    const body = parse(
      z.object({ deviceId: z.string().trim().min(8).max(100), name: z.string().trim().max(60).optional() }),
      req.body,
      res
    );
    if (!body) return;
    let user = db.prepare('SELECT * FROM users WHERE device_id = ?').get(body.deviceId);
    if (user && !user.is_guest) {
      // Device belonged to a guest that later registered: start a fresh guest for this device.
      db.prepare('UPDATE users SET device_id = NULL WHERE id = ?').run(user.id);
      user = null;
    }
    if (!user) {
      const now = Date.now();
      const info = db
        .prepare(
          `INSERT INTO users (name, role, is_guest, device_id, created_at, last_seen_at)
           VALUES (?, 'citizen', 1, ?, ?, ?)`
        )
        .run(body.name || 'Road Guardian', body.deviceId, now, now);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    respond(res, user);
  });

  router.get('/me', requireAuth, (req, res) => res.json({ success: true, user: publicUser(req.user) }));

  router.patch('/me', requireAuth, (req, res) => {
    const body = parse(
      z.object({ name: z.string().trim().min(2).max(60).optional(), city: z.string().trim().max(60).optional() }),
      req.body,
      res
    );
    if (!body) return;
    db.prepare('UPDATE users SET name = COALESCE(?, name), city = COALESCE(?, city) WHERE id = ?').run(
      body.name || null,
      body.city || null,
      req.user.id
    );
    res.json({ success: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  return router;
};
