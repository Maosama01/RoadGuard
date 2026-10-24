'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

/** Bump when a table definition changes; `migrate` brings older files up to date. */
const SCHEMA_VERSION = 3;

// Tables whose CHECK constraints or columns changed are defined as functions so the
// migration can build them under a temporary name.
const hazardsTable = (name = 'hazards') => `
CREATE TABLE IF NOT EXISTS ${name} (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type              TEXT NOT NULL DEFAULT 'pothole',
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  road_name         TEXT,
  area              TEXT,
  status            TEXT NOT NULL DEFAULT 'reported'
                    CHECK (status IN ('reported','verified','assigned','in_progress','resolved','rejected')),
  severity_score    REAL NOT NULL DEFAULT 0,
  severity_level    TEXT NOT NULL DEFAULT 'LOW',
  avg_confidence    REAL NOT NULL DEFAULT 0,
  max_shock         REAL NOT NULL DEFAULT 0,
  avg_speed         REAL NOT NULL DEFAULT 0,
  report_count      INTEGER NOT NULL DEFAULT 0,
  unique_reporters  INTEGER NOT NULL DEFAULT 0,
  clean_passes      INTEGER NOT NULL DEFAULT 0,
  reopen_count      INTEGER NOT NULL DEFAULT 0,
  priority          REAL NOT NULL DEFAULT 0,
  cover_image       TEXT,
  discovered_by     INTEGER REFERENCES users(id),
  assigned_team     TEXT,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT,
  updated_at        INTEGER NOT NULL,
  contractor_id     INTEGER REFERENCES contractors(id),
  segment_id        INTEGER REFERENCES road_segments(id) ON DELETE SET NULL,
  assigned_at       INTEGER,
  due_at            INTEGER,
  escalation_level  INTEGER NOT NULL DEFAULT 0,
  last_escalated_at INTEGER,
  repair_image      TEXT,
  under_warranty    INTEGER NOT NULL DEFAULT 0
);`;

const reportsTable = (name = 'reports') => `
CREATE TABLE IF NOT EXISTS ${name} (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       TEXT UNIQUE,
  hazard_id       INTEGER NOT NULL REFERENCES hazards(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL DEFAULT 'pothole',
  source          TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual','sensor')),
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  accuracy        REAL,
  heading         REAL,
  speed           REAL NOT NULL DEFAULT 0,
  confidence      REAL NOT NULL DEFAULT 0,
  shock           REAL NOT NULL DEFAULT 0,
  severity_score  REAL NOT NULL DEFAULT 0,
  severity_level  TEXT NOT NULL DEFAULT 'LOW',
  road_name       TEXT,
  area            TEXT,
  image           TEXT,
  note            TEXT,
  detected_at     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);`;

const ACCOUNTABILITY_TABLES = `
CREATE TABLE IF NOT EXISTS contractors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone      TEXT,
  email      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS road_segments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  road_pattern    TEXT NOT NULL,
  ward            TEXT,
  contractor_id   INTEGER REFERENCES contractors(id),
  officer_name    TEXT,
  officer_contact TEXT,
  tender_id       TEXT,
  sla_days        INTEGER NOT NULL DEFAULT 7,
  warranty_until  INTEGER,
  min_lat         REAL,
  min_lng         REAL,
  max_lat         REAL,
  max_lng         REAL,
  created_at      INTEGER NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen','authority','admin')),
  is_guest      INTEGER NOT NULL DEFAULT 0,
  device_id     TEXT UNIQUE,
  city          TEXT,
  team          TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

${ACCOUNTABILITY_TABLES}

${hazardsTable()}
CREATE INDEX IF NOT EXISTS idx_hazards_geo ON hazards(lat, lng);
CREATE INDEX IF NOT EXISTS idx_hazards_status ON hazards(status);
CREATE INDEX IF NOT EXISTS idx_hazards_priority ON hazards(priority DESC);
CREATE INDEX IF NOT EXISTS idx_hazards_due ON hazards(due_at);
CREATE INDEX IF NOT EXISTS idx_hazards_contractor ON hazards(contractor_id);

${reportsTable()}
CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_hazard ON reports(hazard_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);

CREATE TABLE IF NOT EXISTS hazard_votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hazard_id  INTEGER NOT NULL REFERENCES hazards(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  vote       TEXT NOT NULL CHECK (vote IN ('present','fixed','pass')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_hazard ON hazard_votes(hazard_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hazard_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hazard_id   INTEGER NOT NULL REFERENCES hazards(id),
  actor_id    INTEGER REFERENCES users(id),
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_hazard ON hazard_events(hazard_id, created_at);

-- Pocket-mode jolts waiting for corroboration. hazard_id is set when a rejected hazard
-- absorbed the hit (kept only so retries stay idempotent).
CREATE TABLE IF NOT EXISTS sensor_hits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy    REAL,
  speed       REAL NOT NULL DEFAULT 0,
  heading     REAL,
  shock       REAL NOT NULL DEFAULT 0,
  road_name   TEXT,
  hazard_id   INTEGER REFERENCES hazards(id),
  detected_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sensor_geo ON sensor_hits(lat, lng);

CREATE TABLE IF NOT EXISTS drives (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       TEXT NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  mode            TEXT NOT NULL CHECK (mode IN ('camera','pocket')),
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER NOT NULL,
  distance_meters REAL NOT NULL DEFAULT 0,
  cells           INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drives_user ON drives(user_id);
CREATE INDEX IF NOT EXISTS idx_drives_ended ON drives(ended_at);

-- ~110 m grid cells (lat/lng rounded to 0.001) that someone actually drove through.
CREATE TABLE IF NOT EXISTS coverage_cells (
  cell_key        TEXT PRIMARY KEY,
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  scans           INTEGER NOT NULL DEFAULT 0,
  last_scanned_at INTEGER NOT NULL,
  last_mode       TEXT
);
CREATE INDEX IF NOT EXISTS idx_coverage_geo ON coverage_cells(lat, lng);

-- One row per drive per cell, so "scanned in the last 30 days" can be counted honestly.
CREATE TABLE IF NOT EXISTS drive_cells (
  drive_id   INTEGER NOT NULL REFERENCES drives(id),
  cell_key   TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  scanned_at INTEGER NOT NULL,
  PRIMARY KEY (drive_id, cell_key)
);
CREATE INDEX IF NOT EXISTS idx_drive_cells_time ON drive_cells(scanned_at);
`;

const tableExists = (db, name) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const columnsOf = (db, name) => db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);

/** SQLite cannot alter a CHECK constraint: build the new table, copy rows, swap. */
function rebuildTable(db, name, createSql) {
  const tmp = `${name}_v${SCHEMA_VERSION}`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(createSql(tmp));
  const keep = columnsOf(db, name).filter((c) => columnsOf(db, tmp).includes(c));
  const cols = keep.join(', ');
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${name}`);
  db.exec(`DROP TABLE ${name}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${name}`);
}

/**
 * Upgrades a database created by an older version (user_version < SCHEMA_VERSION).
 * v1/v2 files have reports.source limited to ('auto','manual') and no accountability columns.
 */
function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version >= SCHEMA_VERSION || !tableExists(db, 'hazards')) return { from: version, migrated: false };

  // Foreign keys must be off while tables are swapped (this pragma is a no-op inside a transaction).
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // Referenced tables first so the rebuilt hazards table can point at them.
      db.exec(ACCOUNTABILITY_TABLES);
      rebuildTable(db, 'hazards', hazardsTable);
      if (tableExists(db, 'reports')) rebuildTable(db, 'reports', reportsTable);
      const broken = db.pragma('foreign_key_check');
      if (broken.length) throw new Error(`Migration would break ${broken.length} foreign keys; database left unchanged.`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return { from: version, migrated: true };
}

/** Columns added after a table first shipped. ALTER TABLE ADD COLUMN is safe to repeat via this check. */
const ADDED_COLUMNS = {
  hazards: {
    contractor_id: 'INTEGER REFERENCES contractors(id)',
    segment_id: 'INTEGER REFERENCES road_segments(id) ON DELETE SET NULL',
    assigned_at: 'INTEGER',
    due_at: 'INTEGER',
    escalation_level: 'INTEGER NOT NULL DEFAULT 0',
    last_escalated_at: 'INTEGER',
    repair_image: 'TEXT',
    under_warranty: 'INTEGER NOT NULL DEFAULT 0',
  },
  sensor_hits: { road_name: 'TEXT', hazard_id: 'INTEGER REFERENCES hazards(id)' },
  reports: { area: 'TEXT' },
};

function ensureColumns(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const have = columnsOf(db, table);
    for (const [col, def] of Object.entries(cols)) {
      if (!have.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }
}

function open(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const result = migrate(db);
  // Columns first: SCHEMA creates indexes on the new hazards columns.
  ensureColumns(db);
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  db.migration = result;
  return db;
}

module.exports = { open, SCHEMA_VERSION };
