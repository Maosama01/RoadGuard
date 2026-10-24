'use strict';

/**
 * GET /h/:id: the public, shareable page for one hazard. Server-rendered HTML, no login,
 * no scripts. Every value that came from a user or a CSV goes through esc().
 */

const config = require('./config');
const H = require('./hazards');
const A = require('./accountability');

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SEV_HEX = { CRITICAL: '#C62E2E', HIGH: '#E8742A', MEDIUM: '#E0A526', LOW: '#3E9C73' };
const SEV_WORD = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const STATUS_WORD = {
  reported: 'Reported', verified: 'Verified', assigned: 'Assigned', in_progress: 'Crew working', resolved: 'Fixed', rejected: 'Rejected',
};
const EVENT_WORD = {
  created: 'First reported',
  auto_verified: 'Verified by drivers',
  assigned: 'Crew assigned',
  auto_assigned: 'Sent to the contractor',
  escalated: 'Escalated',
  repaired: 'Repaired, with photo',
  comment: 'Note from the city',
  vote_fixed: 'A driver says it is fixed',
  vote_present: 'A driver says it is still there',
  community_resolved: 'Closed by drivers',
  reopened: 'Reopened',
};
const STEPS = ['Reported', 'Verified', 'Assigned', 'Fixed'];
const STEP_OF = { reported: 0, verified: 1, assigned: 2, in_progress: 2, resolved: 3, rejected: 0 };

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231C2026'/%3E%3Crect x='14' y='4' width='4' height='7' rx='1' fill='%23F2C230'/%3E%3Crect x='14' y='14' width='4' height='7' rx='1' fill='%23F2C230'/%3E%3Crect x='14' y='24' width='4' height='5' rx='1' fill='%23F2C230'/%3E%3C/svg%3E";

function shell({ title, description, image, url, body, status = 200 }) {
  const og = [
    ['og:type', 'article'],
    ['og:site_name', 'RoadGuard'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', url],
    ['og:image', image],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`)
    .join('\n  ');
  return {
    status,
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  ${og}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#1C2026">
  <link rel="icon" href="${ICON}">
  <link rel="stylesheet" href="/site/hazard.css">
</head>
<body>
  <header class="bar">
    <span class="brand"><span class="brand-mark" aria-hidden="true"></span>RoadGuard</span>
  </header>
  ${body}
</body>
</html>`,
  };
}

function notFound(base) {
  return shell({
    title: 'Hazard not found | RoadGuard',
    description: 'This RoadGuard hazard link does not exist or was removed.',
    url: base,
    status: 404,
    body: `<main class="page page-empty">
    <h1>We could not find this hazard</h1>
    <p>The link may be mistyped, or the report was removed.</p>
  </main>`,
  });
}

function statusLine(h, c, seg, now) {
  const overdue = H.overdueDays(h, now);
  switch (h.status) {
    case 'reported':
      return 'Reported by drivers. Waiting for the city to verify it.';
    case 'verified':
      return 'Verified. Waiting to be sent to a crew.';
    case 'assigned':
    case 'in_progress': {
      const who = c ? c.name : h.assigned_team;
      if (overdue > 0) {
        const escalated = h.escalation_level
          ? ` Escalated to ${seg && seg.officer_name ? seg.officer_name : 'the ward officer'}.`
          : '';
        return `Overdue by ${overdue} ${overdue === 1 ? 'day' : 'days'}.${escalated}`;
      }
      const lead = h.status === 'in_progress' ? `${who ? `${who} is` : 'A crew is'} working on it.` : who ? `Sent to ${who}.` : 'Assigned to a crew.';
      return h.due_at ? `${lead} Due ${A.formatDate(h.due_at)}.` : lead;
    }
    case 'resolved':
      return h.resolved_by === 'community'
        ? `Drivers reported it fixed on ${A.formatDate(h.resolved_at)}.`
        : `Fixed on ${A.formatDate(h.resolved_at)}.`;
    case 'rejected':
      return 'The city reviewed this report and closed it as not a road hazard.';
    default:
      return '';
  }
}

function render(db, id, base, now = Date.now()) {
  const h = Number.isInteger(id) && id > 0 ? db.prepare('SELECT * FROM hazards WHERE id = ?').get(id) : null;
  if (!h) return notFound(base);

  const lk = H.lookups(db);
  const c = lk.contractor(h.contractor_id);
  const seg = lk.segment(h.segment_id);
  const label = H.TYPE_LABELS[h.type] || 'Road hazard';
  const road = h.road_name || (h.area ? `a road in ${h.area}` : 'an unnamed road');
  const sevWord = SEV_WORD[h.severity_level] || 'Low';
  const sevHex = SEV_HEX[h.severity_level] || SEV_HEX.LOW;
  const before = H.imageUrl(base, h.cover_image);
  const after = H.imageUrl(base, h.repair_image);
  const overdue = H.overdueDays(h, now);
  const url = `${base}/h/${h.id}`;
  const line = statusLine(h, c, seg, now);
  const events = db.prepare('SELECT * FROM hazard_events WHERE hazard_id = ? ORDER BY created_at DESC, id DESC').all(h.id);

  const title = `${label} on ${road} | RoadGuard`;
  const description = `${sevWord} severity ${label.toLowerCase()} on ${road}, reported by ${h.unique_reporters} ${
    h.unique_reporters === 1 ? 'driver' : 'drivers'
  }. ${line}`;

  const fig = (src, cap, alt) =>
    `<figure class="shot"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"><figcaption>${esc(cap)}</figcaption></figure>`;
  let photos;
  if (before && after) photos = `<div class="shots shots-2">${fig(before, 'Before', `${label} as drivers saw it`)}${fig(after, 'After', 'Repair photo')}</div>`;
  else if (after) photos = `<div class="shots">${fig(after, 'After the repair', 'Repair photo')}</div>`;
  else if (before) photos = `<div class="shots">${fig(before, 'Photo from a driver’s dashboard camera', `${label} on ${road}`)}</div>`;
  else {
    photos = `<div class="shots"><div class="no-shot">${
      h.type === 'bump' ? 'Found by drivers’ phones in pocket mode, so there is no photo.' : 'No photo yet.'
    }</div></div>`;
  }

  const step = STEP_OF[h.status] ?? 0;
  const progress = STEPS.map((s, i) => {
    const cls = h.status === 'rejected' ? '' : i < step || (i === step && h.status === 'resolved') ? 'is-done' : i === step ? 'is-current' : '';
    return `<li class="${cls}"><span class="lane" aria-hidden="true"></span><span class="step">${s}</span></li>`;
  }).join('');

  const facts = [];
  if (c) facts.push(['Contractor', `${esc(c.name)}${c.phone ? `<small>${esc(c.phone)}</small>` : ''}`]);
  else if (h.assigned_team) facts.push(['Crew', esc(h.assigned_team)]);
  if (seg && seg.tender_id) facts.push(['Tender', esc(seg.tender_id)]);
  if (seg && seg.officer_name) facts.push(['Officer', `${esc(seg.officer_name)}${seg.officer_contact ? `<small>${esc(seg.officer_contact)}</small>` : ''}`]);
  if (seg && seg.ward) facts.push(['Ward', esc(seg.ward)]);
  if (h.due_at) {
    let note = '';
    if (overdue) note = `<small class="late">Overdue by ${overdue} ${overdue === 1 ? 'day' : 'days'}</small>`;
    else if (h.status === 'resolved' && h.resolved_at) {
      const lateBy = Math.max(1, Math.floor((h.resolved_at - h.due_at) / H.DAY));
      note = h.resolved_at <= h.due_at ? '<small>Fixed on time</small>' : `<small class="late">Fixed ${lateBy} ${lateBy === 1 ? 'day' : 'days'} late</small>`;
    }
    facts.push(['Due', `${esc(A.formatDate(h.due_at))}${note}`]);
  }
  if (h.under_warranty) {
    facts.push(['Warranty', `Under warranty${seg && seg.warranty_until ? ` until ${esc(A.formatDate(seg.warranty_until))}` : ''}<small>The contractor must repair it at no cost.</small>`]);
  }

  const timeline = events
    .map((e) => {
      const what = e.type === 'status_change' && e.to_status ? STATUS_WORD[e.to_status] : EVENT_WORD[e.type] || 'Update';
      return `<li><div class="t-what">${esc(what)}</div><div class="t-when">${esc(A.formatDate(e.created_at))}</div>${
        e.note ? `<div class="t-note">${esc(e.note)}</div>` : ''
      }</li>`;
    })
    .join('');

  const maps = `https://www.google.com/maps/search/?api=1&query=${h.lat.toFixed(6)},${h.lng.toFixed(6)}`;
  const appLine = config.appUrl
    ? `<a href="${esc(config.appUrl)}">Get the RoadGuard app</a>: your phone spots potholes while you drive and tells the city.`
    : 'Get the RoadGuard app: your phone spots potholes while you drive and tells the city.';

  const body = `<main class="page">
    <section class="hero">
      <p class="kicker">${esc(label)} #${h.id}</p>
      <h1>${esc(h.road_name || (h.area ? `Near ${h.area}` : 'Unnamed road'))}</h1>
      <p class="sub">First reported ${esc(A.formatDate(h.first_reported_at))}, by ${h.unique_reporters} ${h.unique_reporters === 1 ? 'driver' : 'drivers'}</p>
    </section>
    ${photos}
    <section class="sev" style="--c:${sevHex}">
      <b>${Math.round(h.severity_score)}</b>
      <span><strong>${sevWord}</strong> severity out of 100</span>
    </section>
    <section class="status${h.status === 'rejected' ? ' is-rejected' : ''}${overdue ? ' is-late' : ''}">
      <ol class="progress" aria-label="Progress: ${esc(STATUS_WORD[h.status])}">${progress}</ol>
      <p class="status-line">${esc(line)}</p>
    </section>
    ${facts.length ? `<section class="card"><h2>Who is responsible</h2><dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></section>` : ''}
    <section class="card">
      <h2>History</h2>
      <ol class="timeline">${timeline}</ol>
    </section>
    <p class="links"><a href="${esc(maps)}" rel="noopener">Open in Google Maps</a></p>
    <footer class="foot">
      <p>${appLine}</p>
      <p class="muted">Reported by drivers using RoadGuard. Locations are approximate to a few metres.</p>
    </footer>
  </main>`;

  return shell({ title, description, image: after && h.status === 'resolved' ? after : before || `${base}/site/og-default.png`, url, body });
}

function publicPage(db, baseUrlOf) {
  return (req, res) => {
    A.escalate(db);
    const { status, html } = render(db, Number(req.params.id), baseUrlOf(req));
    res.status(status).type('html').set('Cache-Control', 'public, max-age=60').send(html);
  };
}

module.exports = { publicPage, render, esc };
