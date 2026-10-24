'use strict';

const os = require('os');
const config = require('./config');
const { open } = require('./db');
const { createApp } = require('./app');
const { ensureStaff } = require('./createAdmin');
const { computePriority, OPEN_STATUSES } = require('./hazards');
const { escalate } = require('./accountability');

const db = open();
const { cleanStoredRoadNames } = require('./hazards');
const renamed = cleanStoredRoadNames(db);
if (renamed) console.log(`Cleared ${renamed} unusable road names (Plus Codes, "Unnamed Road").`);

if (config.admin.email && config.admin.password) {
  const r = ensureStaff(db, { ...config.admin, role: 'admin' });
  if (r.created) console.log(`Admin account created: ${config.admin.email}`);
}

// Priority includes "how long has this been left open", so refresh it periodically.
function refreshPriorities() {
  const rows = db.prepare(`SELECT * FROM hazards WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).all(...OPEN_STATUSES);
  const upd = db.prepare('UPDATE hazards SET priority = ? WHERE id = ?');
  db.transaction(() => rows.forEach((h) => upd.run(computePriority(h), h.id)))();
}
// Overdue contractor deadlines escalate on start, every hour, and whenever the queue is listed.
function hourly() {
  const n = escalate(db);
  if (n) console.log(`Escalated ${n} overdue ${n === 1 ? 'hazard' : 'hazards'}.`);
  refreshPriorities();
}
hourly();
setInterval(hourly, 60 * 60 * 1000).unref();

const app = createApp(db);
app.listen(config.port, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('\nRoadGuard backend is running');
  console.log(`  Dashboard:  http://localhost:${config.port}/admin/`);
  for (const ip of lan) console.log(`  App server: http://${ip}:${config.port}/   <- put this in the app's Settings`);
  if (config.jwtSecret === 'dev-only-secret-change-me') console.log('  Warning: using a development JWT_SECRET. Set one in .env.');
  console.log('');
});
