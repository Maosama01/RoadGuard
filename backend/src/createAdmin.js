'use strict';

/**
 * Creates or updates a staff account.
 *   npm run create-admin -- email@city.gov "Strong Password" "Full Name" [admin|authority]
 */
const bcrypt = require('bcryptjs');

function ensureStaff(db, { email, password, name, role = 'admin' }) {
  email = String(email).trim().toLowerCase();
  const hash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ?, name = COALESCE(?, name), is_guest = 0 WHERE id = ?').run(
      hash,
      role,
      name || null,
      existing.id
    );
    return { ...existing, role, created: false };
  }
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name || 'Admin', email, hash, role, Date.now());
  return { id: info.lastInsertRowid, email, role, created: true };
}

if (require.main === module) {
  const [email, password, name, role] = process.argv.slice(2);
  if (!email || !password) {
    console.log('Usage: npm run create-admin -- <email> <password> [name] [admin|authority]');
    process.exit(1);
  }
  const db = require('./db').open();
  const r = ensureStaff(db, { email, password, name, role: role === 'authority' ? 'authority' : 'admin' });
  console.log(`${r.created ? 'Created' : 'Updated'} ${r.role} account ${email}`);
}

module.exports = { ensureStaff };
