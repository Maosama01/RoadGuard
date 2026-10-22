'use strict';

const jwt = require('jsonwebtoken');
const config = require('./config');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

function readToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme && scheme.toLowerCase() === 'bearer' && token) return token;
  return null;
}

/** Attaches req.user when a valid token is present; never rejects. */
function optionalAuth(db) {
  const findUser = db.prepare('SELECT * FROM users WHERE id = ?');
  return (req, _res, next) => {
    const token = readToken(req);
    if (token) {
      try {
        const payload = jwt.verify(token, config.jwtSecret);
        const user = findUser.get(payload.sub);
        if (user) req.user = user;
      } catch (_) {
        /* invalid or expired: treat as anonymous */
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to do that.' });
    }
    next();
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    isGuest: !!u.is_guest,
    city: u.city,
    team: u.team,
    points: u.points,
    createdAt: u.created_at,
  };
}

module.exports = { signToken, optionalAuth, requireAuth, requireRole, publicUser };
