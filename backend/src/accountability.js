'use strict';

/**
 * Accountability: who is responsible for a road, by when it must be fixed, and what happens
 * when that deadline passes.
 *
 * A road segment maps a road (by name pattern, optionally limited to a bounding box) to the
 * contractor holding the maintenance tender, the officer supervising it, an SLA in days and
 * an optional warranty (defect liability) end date.
 */

const config = require('./config');
const H = require('./hazards');

const { DAY, OPEN_STATUSES } = H;
const MAX_ESCALATION = 3;

// ---------------------------------------------------------------- dates

const TZ = config.timeZone;
const fmtLong = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const fmtNum = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ });

/** "27 Oct 2026" */
const formatDate = (t) => fmtLong.format(new Date(t));
/** "27/10/2026" (used in the Hindi letter, as in Indian official correspondence) */
const formatDateNumeric = (t) => fmtNum.format(new Date(t));

/** "2027-03-31" -> end of that day in the configured time zone (ms). null if invalid. */
function parseDay(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  // End of day, India Standard Time unless configured otherwise (IST has no DST).
  return Date.UTC(y, mo - 1, d, 23, 59, 59, 999) - config.timeZoneOffsetMinutes * 60000;
}

// ---------------------------------------------------------------- matching

const hasBbox = (s) => [s.min_lat, s.min_lng, s.max_lat, s.max_lng].every((v) => v !== null && v !== undefined);

function segmentMatches(seg, roadName, lat, lng) {
  if (!roadName || !seg.road_pattern) return false;
  if (!roadName.toLowerCase().includes(seg.road_pattern.toLowerCase())) return false;
  if (!hasBbox(seg)) return true;
  return lat >= seg.min_lat && lat <= seg.max_lat && lng >= seg.min_lng && lng <= seg.max_lng;
}

/** Most specific first: a bounding box beats none, then a longer pattern beats a shorter one. */
function compareSpecificity(a, b) {
  return (hasBbox(b) ? 1 : 0) - (hasBbox(a) ? 1 : 0) || b.road_pattern.length - a.road_pattern.length || a.id - b.id;
}

function matchSegment(db, hazard, segments = null) {
  if (!hazard.road_name) return null;
  const all = segments || db.prepare('SELECT * FROM road_segments').all();
  const hits = all.filter((s) => segmentMatches(s, hazard.road_name, hazard.lat, hazard.lng));
  return hits.sort(compareSpecificity)[0] || null;
}

/**
 * For per-road views: the segment responsible for a road as a whole. A segment without a
 * bounding box covers the whole road, so it wins here; then the longest pattern.
 */
function segmentForRoad(segments, roadName) {
  const hits = segments.filter((s) => roadName && s.road_pattern && roadName.toLowerCase().includes(s.road_pattern.toLowerCase()));
  return hits.sort((a, b) => (hasBbox(a) ? 1 : 0) - (hasBbox(b) ? 1 : 0) || b.road_pattern.length - a.road_pattern.length || a.id - b.id)[0] || null;
}

// ---------------------------------------------------------------- assignment

function isEligible(h) {
  if (!['reported', 'verified'].includes(h.status)) return false;
  if (h.due_at) return false; // already with a contractor and on the clock
  return h.status === 'verified' || h.severity_level === 'HIGH' || h.severity_level === 'CRITICAL';
}

function dueDateFor(seg, severityLevel, now) {
  const sla = Math.max(1, seg.sla_days || 7);
  const days = severityLevel === 'CRITICAL' ? Math.max(1, sla / 2) : sla;
  return now + Math.round(days * DAY);
}

/**
 * Sends a hazard to the contractor responsible for its road, if it qualifies:
 * verified, or HIGH/CRITICAL; still New/Verified; not already on a contractor's clock.
 * Returns the (possibly updated) hazard row.
 */
function maybeAutoAssign(db, hazard, now = Date.now(), { segments = null } = {}) {
  if (!hazard || !isEligible(hazard)) return hazard;
  const seg = matchSegment(db, hazard, segments);
  if (!seg || !seg.contractor_id) return hazard;
  const contractor = db.prepare('SELECT * FROM contractors WHERE id = ?').get(seg.contractor_id);
  if (!contractor) return hazard;

  const dueAt = dueDateFor(seg, hazard.severity_level, now);
  const warranty = !!(seg.warranty_until && seg.warranty_until > now);
  db.prepare(
    `UPDATE hazards SET contractor_id = ?, segment_id = ?, assigned_team = ?, assigned_at = ?, due_at = ?,
       escalation_level = 0, last_escalated_at = NULL, under_warranty = ?, updated_at = ?
     WHERE id = ?`
  ).run(contractor.id, seg.id, contractor.name, now, dueAt, warranty ? 1 : 0, now, hazard.id);

  const again = hazard.contractor_id && hazard.contractor_id === contractor.id;
  let note = `${again ? 'Sent back to' : 'Sent to'} ${contractor.name}${seg.tender_id ? ` under tender ${seg.tender_id}` : ''}. Due ${formatDate(dueAt)}.`;
  if (warranty) note += ' Under warranty: repair at no cost.';

  const fresh = db.prepare('SELECT * FROM hazards WHERE id = ?').get(hazard.id);
  return H.setStatus(db, fresh, 'assigned', null, { type: 'auto_assigned', note, now });
}

/** Re-runs auto-assignment for every open hazard that has no contractor deadline yet. */
function assignAllEligible(db, now = Date.now()) {
  const segments = db.prepare('SELECT * FROM road_segments').all();
  if (!segments.length) return 0;
  const rows = db
    .prepare(`SELECT * FROM hazards WHERE status IN ('reported','verified') AND due_at IS NULL AND road_name IS NOT NULL`)
    .all();
  let n = 0;
  db.transaction(() => {
    for (const h of rows) {
      const after = maybeAutoAssign(db, h, now, { segments });
      if (after && after.status === 'assigned') n++;
    }
  })();
  return n;
}

// ---------------------------------------------------------------- escalation

/** 1 the moment the deadline passes, +1 for every further SLA period, at most 3. */
function escalationLevelFor(dueAt, slaDays, now) {
  if (!dueAt || now <= dueAt) return 0;
  const period = Math.max(1, slaDays || 7) * DAY;
  return Math.min(MAX_ESCALATION, 1 + Math.floor((now - dueAt) / period));
}

/**
 * Raises escalation_level on overdue open hazards and records an `escalated` event each time
 * it goes up. Cheap (indexed on due_at), so it runs on start, hourly and before lists.
 */
function escalate(db, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT h.*, s.sla_days AS seg_sla, s.officer_name AS seg_officer
       FROM hazards h LEFT JOIN road_segments s ON s.id = h.segment_id
       WHERE h.due_at IS NOT NULL AND h.due_at < ? AND h.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
         AND h.escalation_level < ${MAX_ESCALATION}`
    )
    .all(now, ...OPEN_STATUSES);
  let changed = 0;
  if (!rows.length) return 0;
  db.transaction(() => {
    for (const h of rows) {
      const level = escalationLevelFor(h.due_at, h.seg_sla, now);
      if (level <= (h.escalation_level || 0)) continue;
      const days = H.overdueDays(h, now);
      db.prepare('UPDATE hazards SET escalation_level = ?, last_escalated_at = ?, updated_at = ? WHERE id = ?').run(
        level, now, now, h.id
      );
      H.addEvent(db, h.id, null, 'escalated', {
        note: `Overdue by ${days} ${days === 1 ? 'day' : 'days'}. Escalated to ${h.seg_officer || 'the ward officer'}.`,
        at: now,
      });
      const fresh = db.prepare('SELECT * FROM hazards WHERE id = ?').get(h.id);
      db.prepare('UPDATE hazards SET priority = ? WHERE id = ?').run(H.computePriority(fresh, now), h.id);
      changed++;
    }
  })();
  return changed;
}

// ---------------------------------------------------------------- scorecards

function scorecards(db, now = Date.now()) {
  const contractors = db.prepare('SELECT * FROM contractors ORDER BY name COLLATE NOCASE').all();
  const hazards = db.prepare('SELECT * FROM hazards WHERE contractor_id IS NOT NULL').all();
  const reopened = new Set(
    db
      .prepare(
        `SELECT DISTINCT r.hazard_id AS id FROM hazard_events r
         JOIN hazard_events o ON o.hazard_id = r.hazard_id AND o.type = 'reopened' AND o.created_at > r.created_at
         WHERE r.type = 'repaired'`
      )
      .all()
      .map((r) => r.id)
  );
  const segCount = new Map(
    db.prepare('SELECT contractor_id id, COUNT(*) n FROM road_segments GROUP BY contractor_id').all().map((r) => [r.id, r.n])
  );

  return contractors.map((c) => {
    const mine = hazards.filter((h) => h.contractor_id === c.id);
    const open = mine.filter((h) => OPEN_STATUSES.includes(h.status));
    const fixed = mine.filter((h) => h.status === 'resolved');
    const overdue = open.filter((h) => h.due_at && h.due_at < now);
    const fixTimes = fixed.filter((h) => h.resolved_at && h.assigned_at).map((h) => (h.resolved_at - h.assigned_at) / DAY);
    const fixedWithDue = fixed.filter((h) => h.due_at && h.resolved_at);
    const onTime = fixedWithDue.filter((h) => h.resolved_at <= h.due_at).length;
    const judged = fixedWithDue.length + overdue.length; // late fixes and still-overdue both count against
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      segments: segCount.get(c.id) || 0,
      assigned: mine.filter((h) => h.status !== 'rejected').length,
      open: open.length,
      fixed: fixed.length,
      overdue: overdue.length,
      avgFixDays: fixTimes.length ? Math.round((fixTimes.reduce((a, b) => a + b, 0) / fixTimes.length) * 10) / 10 : null,
      reopenedAfterRepair: mine.filter((h) => reopened.has(h.id)).length,
      onTimeRate: judged ? Math.round((onTime / judged) * 100) : null,
    };
  });
}

// ---------------------------------------------------------------- CSV

/**
 * Small RFC 4180 parser: commas, "quoted, fields", doubled "" quotes, newlines inside quotes,
 * CRLF or LF, a leading BOM. Returns [{ line, cells }] where line is the 1-based line the row
 * starts on. Throws on an unterminated quote.
 */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRow = () => {
    endCell();
    if (!(cells.length === 1 && cells[0].trim() === '')) rows.push({ line: rowLine, cells });
    cells = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (ch === '\n') line++;
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell.trim() === '') { cell = ''; quoted = true; i++; continue; }
    if (ch === ',') { endCell(); i++; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && src[i + 1] === '\n') i++;
      i++; line++; rowLine = line; continue;
    }
    cell += ch; i++;
  }
  if (quoted) throw new Error(`Line ${rowLine}: a quoted field is never closed.`);
  if (cell !== '' || cells.length) endRow();
  return rows;
}

const SEGMENT_COLUMNS = ['road_pattern', 'ward', 'contractor', 'officer_name', 'officer_contact', 'tender_id', 'sla_days', 'warranty_until'];
const BBOX_COLUMNS = ['min_lat', 'min_lng', 'max_lat', 'max_lng'];
const CSV_TEMPLATE = `${SEGMENT_COLUMNS.join(',')}\n` +
  '"Rajpur Road",Ward 12,Shivalik Roadworks,"Assistant Engineer, PWD North",ae.north@example.gov.in,DDN/PWD/2026/014,7,2027-03-31\n';

/** Validates one segment-like record. Returns { value } or { error }. Shared by the API and CSV import. */
function cleanSegment(r) {
  const out = {};
  const str = (v, max) => {
    if (v === undefined || v === null) return null;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
  };
  out.road_pattern = str(r.road_pattern, 120);
  if (!out.road_pattern) return { error: 'road_pattern is required' };
  if (out.road_pattern.length < 2) return { error: 'road_pattern needs at least 2 characters' };
  out.ward = str(r.ward, 80);
  out.officer_name = str(r.officer_name, 120);
  out.officer_contact = str(r.officer_contact, 120);
  out.tender_id = str(r.tender_id, 80);
  out.contractor = str(r.contractor, 120);

  const sla = str(r.sla_days, 10);
  if (sla === null) out.sla_days = 7;
  else if (!/^\d+$/.test(sla) || Number(sla) < 1 || Number(sla) > 365) return { error: 'sla_days must be a whole number from 1 to 365' };
  else out.sla_days = Number(sla);

  const w = str(r.warranty_until, 20);
  if (w === null) out.warranty_until = null;
  else {
    const t = parseDay(w);
    if (t === null) return { error: `warranty_until "${w}" is not a date like 2027-03-31` };
    out.warranty_until = t;
  }

  const box = BBOX_COLUMNS.map((k) => str(r[k], 20));
  if (box.some((v) => v !== null)) {
    if (box.some((v) => v === null)) return { error: 'give all four of min_lat, min_lng, max_lat, max_lng, or none' };
    const nums = box.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return { error: 'bounding box values must be numbers' };
    const [minLat, minLng, maxLat, maxLng] = nums;
    if (minLat > maxLat || minLng > maxLng) return { error: 'bounding box minimums must be below the maximums' };
    if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 || Math.abs(minLng) > 180 || Math.abs(maxLng) > 180) {
      return { error: 'bounding box is outside the map' };
    }
    Object.assign(out, { min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng });
  } else Object.assign(out, { min_lat: null, min_lng: null, max_lat: null, max_lng: null });
  return { value: out };
}

function findOrCreateContractor(db, name, now = Date.now()) {
  const found = db.prepare('SELECT * FROM contractors WHERE name = ? COLLATE NOCASE').get(name);
  if (found) return { contractor: found, created: false };
  const info = db.prepare('INSERT INTO contractors (name, created_at) VALUES (?, ?)').run(name, now);
  return { contractor: db.prepare('SELECT * FROM contractors WHERE id = ?').get(info.lastInsertRowid), created: true };
}

/**
 * Imports road segments from CSV text. Rows with errors are skipped and reported; the rest are
 * imported. A row with the same road_pattern, tender_id and bounding box as an existing
 * segment updates it instead of adding a duplicate.
 */
function importSegments(db, csv, now = Date.now()) {
  let rows;
  try {
    rows = parseCsv(csv);
  } catch (e) {
    return { imported: 0, updated: 0, contractorsCreated: 0, assigned: 0, errors: [{ line: null, message: e.message }] };
  }
  if (!rows.length) return { imported: 0, updated: 0, contractorsCreated: 0, assigned: 0, errors: [{ line: null, message: 'The file is empty.' }] };

  const header = rows[0].cells.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  if (!header.includes('road_pattern')) {
    return {
      imported: 0, updated: 0, contractorsCreated: 0, assigned: 0,
      errors: [{ line: rows[0].line, message: `The first line must be the header: ${SEGMENT_COLUMNS.join(',')}` }],
    };
  }

  const errors = [];
  let imported = 0;
  let updated = 0;
  let contractorsCreated = 0;
  const findSame = db.prepare(
    `SELECT id FROM road_segments
     WHERE lower(road_pattern) = lower(?) AND IFNULL(tender_id, '') = IFNULL(?, '')
       AND min_lat IS ? AND min_lng IS ? AND max_lat IS ? AND max_lng IS ?`
  );

  db.transaction(() => {
    for (const row of rows.slice(1)) {
      if (row.cells.length > header.length && row.cells.slice(header.length).some((c) => c.trim())) {
        errors.push({ line: row.line, message: `has ${row.cells.length} columns but the header has ${header.length}` });
        continue;
      }
      const rec = Object.fromEntries(header.map((h, i) => [h, row.cells[i]]));
      const { value, error } = cleanSegment(rec);
      if (error) { errors.push({ line: row.line, message: error }); continue; }
      let contractorId = null;
      if (value.contractor) {
        const r = findOrCreateContractor(db, value.contractor, now);
        contractorId = r.contractor.id;
        if (r.created) contractorsCreated++;
      }
      const same = findSame.get(value.road_pattern, value.tender_id, value.min_lat, value.min_lng, value.max_lat, value.max_lng);
      const params = { ...value, contractor_id: contractorId, now };
      if (same) {
        db.prepare(
          `UPDATE road_segments SET road_pattern=@road_pattern, ward=@ward, contractor_id=@contractor_id, officer_name=@officer_name,
             officer_contact=@officer_contact, tender_id=@tender_id, sla_days=@sla_days, warranty_until=@warranty_until
           WHERE id=@id`
        ).run({ ...params, id: same.id });
        updated++;
      } else {
        insertSegment(db, params);
      }
      imported++;
    }
  })();

  const assigned = imported ? assignAllEligible(db, now) : 0;
  return { imported, updated, contractorsCreated, assigned, errors };
}

function insertSegment(db, v) {
  const info = db
    .prepare(
      `INSERT INTO road_segments (road_pattern, ward, contractor_id, officer_name, officer_contact, tender_id, sla_days,
                                  warranty_until, min_lat, min_lng, max_lat, max_lng, created_at)
       VALUES (@road_pattern, @ward, @contractor_id, @officer_name, @officer_contact, @tender_id, @sla_days,
               @warranty_until, @min_lat, @min_lng, @max_lat, @max_lng, @now)`
    )
    .run({ now: Date.now(), ...v });
  return info.lastInsertRowid;
}

function serializeSegment(s, lk) {
  const c = lk ? lk.contractor(s.contractor_id) : null;
  return {
    id: s.id,
    roadPattern: s.road_pattern,
    ward: s.ward,
    contractorId: s.contractor_id,
    contractor: c ? { id: c.id, name: c.name, phone: c.phone } : null,
    officerName: s.officer_name,
    officerContact: s.officer_contact,
    tenderId: s.tender_id,
    slaDays: s.sla_days,
    warrantyUntil: s.warranty_until,
    minLat: s.min_lat,
    minLng: s.min_lng,
    maxLat: s.max_lat,
    maxLng: s.max_lng,
    createdAt: s.created_at,
  };
}

// ---------------------------------------------------------------- complaint letter

const HI = {
  type: {
    pothole: { what: 'एक गड्ढा है', of: 'गड्ढे' },
    drain_hole: { what: 'एक खुला नाला है', of: 'खुले नाले' },
    sewer_cover: { what: 'सीवर का ढक्कन टूटा या खुला है', of: 'सीवर के ढक्कन' },
    crack: { what: 'सड़क की सतह जगह-जगह से टूट चुकी है और उसमें दरारें पड़ गई हैं', of: 'टूटी सतह' },
    bump: { what: 'सड़क का एक हिस्सा बहुत ऊबड़-खाबड़ हो गया है', of: 'ऊबड़-खाबड़ हिस्से' },
    other: { what: 'एक खतरनाक गड़बड़ी है', of: 'सड़क' },
  },
  severity: { LOW: 'कम', MEDIUM: 'मध्यम', HIGH: 'गंभीर', CRITICAL: 'अत्यंत गंभीर' },
};
const EN_SEVERITY = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };
const EN_WHAT = {
  pothole: 'a pothole',
  drain_hole: 'an open drain',
  sewer_cover: 'a damaged sewer cover',
  crack: 'a badly cracked stretch of road surface',
  bump: 'a rough, broken patch of road',
  other: 'a road hazard',
};

/**
 * A ready-to-send formal complaint about one hazard, in English or Hindi (Devanagari).
 * Everything in it is public information already shown on the hazard's public page.
 */
function complaint(db, h, { base, lang = 'en', now = Date.now() } = {}) {
  const lk = H.lookups(db);
  const c = lk.contractor(h.contractor_id);
  const seg = lk.segment(h.segment_id) || matchSegment(db, h);
  const segContractor = !c && seg ? lk.contractor(seg.contractor_id) : null;
  const contractor = c || segContractor;
  const lat = h.lat.toFixed(5);
  const lng = h.lng.toFixed(5);
  const maps = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const publicUrl = `${base}/h/${h.id}`;
  const photo = H.imageUrl(base, h.cover_image);
  const overdue = H.overdueDays(h, now);
  const open = OPEN_STATUSES.includes(h.status);
  const warrantyUntil = seg && seg.warranty_until && seg.warranty_until > now ? seg.warranty_until : null;
  const underWarranty = !!h.under_warranty || !!warrantyUntil;
  const ref = `RoadGuard #${h.id}`;
  const score = Math.round(h.severity_score);

  const to = {
    officerName: seg ? seg.officer_name : null,
    officerContact: seg ? seg.officer_contact : null,
    contractor: contractor ? contractor.name : null,
  };

  if (lang === 'hi') {
    const t = HI.type[h.type] || HI.type.other;
    const road = h.road_name || `निर्देशांक ${lat}, ${lng} के पास की सड़क`;
    const lines = [
      'सेवा में,',
      to.officerName || 'संबंधित वार्ड अधिकारी महोदय/महोदया',
      ...(seg && seg.ward ? [seg.ward] : []),
      ...(to.officerContact ? [to.officerContact] : []),
      '',
      `विषय: ${road} पर ${t.of} की मरम्मत हेतु शिकायत (${ref})`,
      '',
      'महोदय/महोदया,',
      '',
      `सविनय निवेदन है कि ${road} पर ${t.what}, जिससे वाहन चालकों और पैदल चलने वालों को दुर्घटना का खतरा बना हुआ है। इसका विवरण इस प्रकार है:`,
      '',
      `स्थान: ${road}${seg && seg.ward ? `, ${seg.ward}` : ''}`,
      `निर्देशांक: ${lat}, ${lng}`,
      `गूगल मैप्स: ${maps}`,
      `पहली सूचना की तिथि: ${formatDateNumeric(h.first_reported_at)}`,
      `सूचना देने वाले वाहन चालक: ${h.unique_reporters} (RoadGuard ऐप के माध्यम से)`,
      `गंभीरता: ${HI.severity[h.severity_level] || h.severity_level} (100 में से ${score})`,
      ...(seg && seg.tender_id ? [`निविदा (टेंडर) संख्या: ${seg.tender_id}`] : []),
      ...(contractor ? [`ठेकेदार: ${contractor.name}`] : []),
      ...(to.officerName ? [`संबंधित अधिकारी: ${to.officerName}`] : []),
    ];
    if (underWarranty) {
      const until = warrantyUntil || (seg && seg.warranty_until);
      lines.push('', `यह सड़क ${until ? `${formatDateNumeric(until)} तक ` : ''}ठेकेदार की वारंटी (दोष दायित्व अवधि) में है। अनुबंध की शर्तों के अनुसार इसकी मरम्मत ठेकेदार को बिना किसी अतिरिक्त लागत के करनी होगी।`);
    }
    if (open && overdue > 0) {
      lines.push('', `इसकी मरम्मत की निर्धारित अंतिम तिथि ${formatDateNumeric(h.due_at)} थी, जिसे बीते ${overdue} दिन हो चुके हैं।`);
    } else if (open && h.due_at) {
      lines.push('', `इसकी मरम्मत की निर्धारित अंतिम तिथि ${formatDateNumeric(h.due_at)} है।`);
    }
    lines.push(
      '',
      ...(photo ? [`फ़ोटो: ${photo}`] : []),
      `ताज़ा स्थिति और पूरा विवरण: ${publicUrl}`,
      '',
      'अतः आपसे विनम्र अनुरोध है कि इसकी मरम्मत शीघ्र करवाने की कृपा करें, ताकि किसी दुर्घटना से बचा जा सके, और मरम्मत के बाद ऊपर दिए गए पेज पर इसकी स्थिति अपडेट करवाएँ।',
      '',
      'धन्यवाद।',
      '',
      'भवदीय,',
      'एक जागरूक नागरिक'
    );
    return { subject: `${road} पर ${t.of} की मरम्मत हेतु शिकायत (${ref})`, body: lines.join('\n'), to, publicUrl };
  }

  const label = H.TYPE_LABELS[h.type] || 'Road hazard';
  const road = h.road_name || `the road near ${lat}, ${lng}`;
  const subject = `${label} on ${road} needs repair (${ref})`;
  const lines = [
    'To,',
    to.officerName || 'The Ward Officer',
    ...(seg && seg.ward ? [seg.ward] : []),
    ...(to.officerContact ? [to.officerContact] : []),
    '',
    `Subject: ${subject}`,
    '',
    'Respected Sir/Madam,',
    '',
    `I wish to bring to your notice ${EN_WHAT[h.type] || EN_WHAT.other} on ${road}. It is a danger to drivers and pedestrians, and I request that it be repaired.`,
    '',
    `Location: ${road}${seg && seg.ward ? `, ${seg.ward}` : ''}`,
    `Coordinates: ${lat}, ${lng}`,
    `Google Maps: ${maps}`,
    `First reported: ${formatDate(h.first_reported_at)}`,
    `Reported by: ${h.unique_reporters} ${h.unique_reporters === 1 ? 'driver' : 'drivers'} using the RoadGuard app`,
    `Severity: ${EN_SEVERITY[h.severity_level] || h.severity_level} (${score} out of 100)`,
    ...(seg && seg.tender_id ? [`Tender ID: ${seg.tender_id}`] : []),
    ...(contractor ? [`Contractor: ${contractor.name}`] : []),
    ...(to.officerName ? [`Responsible officer: ${to.officerName}`] : []),
  ];
  if (underWarranty) {
    const until = warrantyUntil || (seg && seg.warranty_until);
    lines.push('', `This road is under the contractor's warranty (defect liability period)${until ? ` until ${formatDate(until)}` : ''}. Under the terms of the tender, the contractor must repair it at no cost to the public.`);
  }
  if (open && overdue > 0) {
    lines.push('', `The repair was due on ${formatDate(h.due_at)} and is now ${overdue} ${overdue === 1 ? 'day' : 'days'} overdue.`);
  } else if (open && h.due_at) {
    lines.push('', `The repair is due by ${formatDate(h.due_at)}.`);
  }
  lines.push(
    '',
    ...(photo ? [`Photo: ${photo}`] : []),
    `Live status and history: ${publicUrl}`,
    '',
    'I request you to get this repaired at the earliest, before it causes an accident, and to update its status on the page above once the work is done.',
    '',
    'Thank you.',
    '',
    'Yours faithfully,',
    'A concerned citizen'
  );
  return { subject, body: lines.join('\n'), to, publicUrl };
}

module.exports = {
  MAX_ESCALATION,
  CSV_TEMPLATE,
  SEGMENT_COLUMNS,
  formatDate,
  formatDateNumeric,
  parseDay,
  hasBbox,
  matchSegment,
  segmentForRoad,
  maybeAutoAssign,
  assignAllEligible,
  dueDateFor,
  escalationLevelFor,
  escalate,
  scorecards,
  parseCsv,
  cleanSegment,
  findOrCreateContractor,
  importSegments,
  insertSegment,
  serializeSegment,
  complaint,
};
