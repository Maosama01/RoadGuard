/* RoadGuard Control: authority dashboard. Vanilla JS, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };

  const SEV_VAR = { CRITICAL: 'var(--critical)', HIGH: 'var(--high)', MEDIUM: 'var(--medium)', LOW: 'var(--low)' };
  const SEV_HEX = { CRITICAL: '#C62E2E', HIGH: '#E8742A', MEDIUM: '#E0A526', LOW: '#3E9C73' };
  const SEV_WORD = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
  const STATUS_WORD = {
    reported: 'New', verified: 'Verified', assigned: 'Assigned', in_progress: 'Crew working', resolved: 'Fixed', rejected: 'Rejected',
  };
  const TYPE_WORD = {
    pothole: 'Pothole', drain_hole: 'Open drain', sewer_cover: 'Sewer cover', crack: 'Cracked surface', bump: 'Rough patch', other: 'Road hazard',
  };
  const EVENT_WORD = {
    created: 'First reported',
    auto_verified: 'Auto-verified',
    status_change: 'Status changed',
    assigned: 'Crew assignment',
    comment: 'Note added',
    vote_fixed: 'Driver says fixed',
    vote_present: 'Driver says still there',
    community_resolved: 'Closed by drivers',
    reopened: 'Reopened',
    auto_assigned: 'Sent to contractor',
    escalated: 'Escalated',
    repaired: 'Repaired, with photo',
  };
  const OPEN = ['reported', 'verified', 'assigned', 'in_progress'];

  function ago(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  function openFor(h) {
    const end = h.resolvedAt || Date.now();
    const d = Math.floor((end - h.firstReportedAt) / 86400000);
    if (d < 1) return 'under a day';
    return d === 1 ? '1 day' : `${d} days`;
  }
  function when(t) {
    return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function day(t) {
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  /** "in 3 days", "today", "tomorrow" for a future time. */
  function dueIn(t) {
    const d = Math.floor((t - Date.now()) / 86400000);
    if (d <= 0) return 'today';
    return d === 1 ? 'tomorrow' : `in ${d} days`;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fmtKm = (km) => (km == null ? '–' : km >= 100 ? Math.round(km).toLocaleString() : (Math.round(km * 10) / 10).toLocaleString());

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
  }

  // ---------------------------------------------------------------- api
  let token = store.get('rg_token');
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/auth/login') {
      signOut();
      throw new Error('Your session ended. Sign in again.');
    }
    if (!res.ok || data.success === false) throw new Error(data.message || `Request failed (${res.status})`);
    return data;
  }

  // ---------------------------------------------------------------- state
  const state = {
    me: null,
    view: 'queue',
    status: 'open',
    sev: new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    type: '',
    sort: 'priority',
    q: '',
    inView: false,
    items: [],
    total: 0,
    selected: null,
    detail: null,
    photoIdx: 0,
    heat: false,
    coverage: false,
    contractor: null, // { id, name } when the queue is filtered to one contractor
    editingSegment: null,
    csvDraft: '',
    importResult: null,
  };

  // ---------------------------------------------------------------- auth
  function showLogin() {
    $('#shell').hidden = true;
    $('#login').hidden = false;
    setTimeout(() => $('#loginEmail').focus(), 50);
  }
  function signOut() {
    token = null;
    store.del('rg_token');
    showLogin();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginError');
    err.textContent = '';
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      if (!['authority', 'admin'].includes(data.user.role)) {
        err.textContent = 'This account is a driver account. Ask your admin for city team access.';
        return;
      }
      token = data.token;
      store.set('rg_token', token);
      start(data.user);
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  $('#logoutBtn').addEventListener('click', signOut);

  // ---------------------------------------------------------------- map
  let map, markerLayer, heatLayer, coverageLayer, tiles;
  const markers = new Map();
  function initMap() {
    if (map) return;
    map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([30.3255, 78.0436], 13);
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    tiles = L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`,
      {
        maxZoom: 20,
        subdomains: 'abcd',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }
    ).addTo(map);
    map.createPane('coverage');
    map.getPane('coverage').style.zIndex = 350;
    coverageLayer = L.layerGroup();
    markerLayer = L.layerGroup().addTo(map);
    map.on('moveend', () => { if (state.inView) loadQueue(); });
  }

  function radiusFor(h) {
    return 6 + Math.min(h.uniqueReporters || 1, 10) * 1.3;
  }

  function drawMarkers(fit) {
    markerLayer.clearLayers();
    markers.clear();
    const pts = [];
    for (const h of state.items) {
      const done = !OPEN.includes(h.status);
      const color = done ? '#8A9099' : SEV_HEX[h.severityLevel] || '#8A9099';
      const m = L.circleMarker([h.latitude, h.longitude], {
        radius: radiusFor(h),
        color: done ? color : '#fff',
        weight: done ? 2 : 1.5,
        fillColor: color,
        fillOpacity: done ? 0.15 : 0.9,
      });
      m.bindTooltip(`${esc(h.roadName || TYPE_WORD[h.type])}: ${esc(SEV_WORD[h.severityLevel])}`, { className: 'rg-tip', direction: 'top', offset: [0, -6] });
      m.on('click', () => select(h.id, false));
      m.addTo(markerLayer);
      markers.set(h.id, m);
      pts.push([h.latitude, h.longitude]);
    }
    highlightMarker();
    if (fit && pts.length && !state.inView) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 16 });
  }

  function highlightMarker() {
    markers.forEach((m, id) => {
      if (id === state.selected) { m.setStyle({ color: '#F2C230', weight: 4 }); m.bringToFront(); }
      else {
        const h = state.items.find((x) => x.id === id);
        const done = h && !OPEN.includes(h.status);
        m.setStyle({ color: done ? '#8A9099' : '#fff', weight: done ? 2 : 1.5 });
      }
    });
  }

  async function toggleHeat() {
    state.heat = !state.heat;
    $('#heatBtn').setAttribute('aria-pressed', String(state.heat));
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (state.heat && L.heatLayer) {
      const data = await api('/api/hazards/heatmap?status=open');
      heatLayer = L.heatLayer(data.points, { radius: 28, blur: 22, maxZoom: 17, gradient: { 0.3: '#3E9C73', 0.55: '#E0A526', 0.75: '#E8742A', 1: '#C62E2E' } }).addTo(map);
    }
  }
  $('#heatBtn').addEventListener('click', () => toggleHeat().catch((e) => toast(e.message)));

  /** Faint lane-yellow squares: the ~110 m cells someone drove with RoadGuard on in the last 30 days. */
  async function toggleCoverage() {
    state.coverage = !state.coverage;
    $('#coverageBtn').setAttribute('aria-pressed', String(state.coverage));
    $('#coverageLegend').hidden = !state.coverage;
    coverageLayer.clearLayers();
    if (!state.coverage) { map.removeLayer(coverageLayer); return; }
    const { cells } = await api('/api/coverage?days=30');
    const renderer = L.canvas({ pane: 'coverage' });
    for (const c of cells) {
      L.rectangle([[c.lat - 0.0005, c.lng - 0.0005], [c.lat + 0.0005, c.lng + 0.0005]], {
        renderer, pane: 'coverage', stroke: false, fillColor: '#F2C230', fillOpacity: Math.min(0.42, 0.16 + c.scans * 0.04), interactive: false,
      }).addTo(coverageLayer);
    }
    coverageLayer.addTo(map);
    if (!cells.length) toast('No drives recorded in the last 30 days yet.');
  }
  $('#coverageBtn').addEventListener('click', () => toggleCoverage().catch((e) => toast(e.message)));
  $('#fitBtn').addEventListener('click', () => {
    const pts = state.items.map((h) => [h.latitude, h.longitude]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 16 });
  });

  // ---------------------------------------------------------------- pulse
  async function loadPulse() {
    const { totals } = await api('/api/stats/overview?days=14');
    const items = [
      ['Open', totals.open, ''],
      ['Critical', totals.critical, totals.critical ? 'is-critical' : ''],
      ['Overdue', totals.overdue || 0, totals.overdue ? 'is-critical' : ''],
      ['New today', totals.reportsToday, ''],
      ['Fixed rate', `${totals.resolutionRate}%`, ''],
      ['Avg. time to fix', totals.avgResolutionHours == null ? '–' : totals.avgResolutionHours < 48 ? `${Math.round(totals.avgResolutionHours)} h` : `${Math.round(totals.avgResolutionHours / 24)} d`, ''],
    ];
    $('#pulse').innerHTML = items.map(([k, v, c]) => `<div class="${c}"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    return totals;
  }

  // ---------------------------------------------------------------- queue
  function queueParams() {
    const p = new URLSearchParams();
    if (state.status === 'overdue') { p.set('status', 'open'); p.set('overdue', '1'); } else p.set('status', state.status);
    if (state.contractor) p.set('contractor', String(state.contractor.id));
    if (state.sev.size < 4) p.set('severity', [...state.sev].join(','));
    if (state.type) p.set('type', state.type);
    if (state.q) p.set('q', state.q);
    p.set('sort', state.sort);
    p.set('limit', '500');
    if (state.inView && map) {
      const b = map.getBounds();
      p.set('bbox', [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','));
    }
    return p;
  }

  let loadSeq = 0;
  async function loadQueue(fit = false) {
    const seq = ++loadSeq;
    if (state.sev.size === 0) {
      state.items = []; state.total = 0; renderQueue(); drawMarkers(false); return;
    }
    const data = await api(`/api/hazards?${queueParams()}`);
    if (seq !== loadSeq) return;
    state.items = data.items;
    state.total = data.total;
    renderQueue();
    drawMarkers(fit);
  }

  function renderQueue() {
    const list = $('#queueList');
    $('#queueMeta').innerHTML = `<span>${plural(state.total, 'hazard', 'hazards')}${
      state.contractor ? ` for ${esc(state.contractor.name)} <button class="link-btn" type="button" data-act="clear-contractor">Show all</button>` : ''
    }</span><span>${state.sort === 'priority' ? 'Highest priority first' : ''}</span>`;
    if (!state.items.length) {
      const fixedView = state.status === 'resolved';
      list.innerHTML = `<li class="empty"><strong>${fixedView ? 'Nothing fixed yet' : 'Nothing here'}</strong>${
        state.q || state.sev.size < 4 || state.type || state.inView || state.contractor
          ? 'Try clearing the filters or zooming the map out.'
          : fixedView ? 'Hazards you close appear here.' : 'New sightings from drivers show up here automatically.'
      }</li>`;
      return;
    }
    list.innerHTML = state.items
      .map((h) => {
        const done = !OPEN.includes(h.status);
        const flags = [];
        if (h.likelyFixed) flags.push('<span class="pill pill-flag">Likely fixed</span>');
        if (h.reopenCount) flags.push(`<span class="pill pill-flag">Came back ${h.reopenCount > 1 ? `${h.reopenCount} times` : 'once'}</span>`);
        if (h.overdueDays && !done) flags.push(`<span class="pill pill-late">Overdue ${h.overdueDays} d</span>`);
        if (h.contractor && h.status !== 'resolved') flags.push(`<span class="pill pill-flag">${esc(h.contractor.name)}</span>`);
        else if (h.assignedTeam && h.status !== 'resolved') flags.push(`<span class="pill pill-flag">${esc(h.assignedTeam)}</span>`);
        if (h.underWarranty && !done) flags.push('<span class="pill pill-flag">Warranty</span>');
        return `<li class="q-item${h.id === state.selected ? ' is-selected' : ''}" data-id="${h.id}" tabindex="0" role="button"
                   aria-label="${esc(h.roadName || TYPE_WORD[h.type])}, ${SEV_WORD[h.severityLevel]}, priority ${Math.round(h.priority)}">
          <span class="q-edge${done ? ' is-done' : ''}" style="--c:${SEV_VAR[h.severityLevel]}"></span>
          <span class="q-prio">${done ? '–' : Math.round(h.priority)}<small>${done ? '' : 'priority'}</small></span>
          <span class="q-main">
            <span class="q-title">${esc(h.roadName || 'Unnamed road')}</span>
            <span class="q-sub"><span>${TYPE_WORD[h.type]}, ${SEV_WORD[h.severityLevel].toLowerCase()}</span><span>${plural(h.uniqueReporters, 'driver', 'drivers')}</span><span>${done ? `open ${openFor(h)}` : `waiting ${openFor(h)}`}</span></span>
            <span class="q-flags"><span class="pill pill-status-${h.status}">${STATUS_WORD[h.status]}</span>${flags.join('')}</span>
          </span>
        </li>`;
      })
      .join('');
  }

  $('#queueMeta').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="clear-contractor"]')) {
      state.contractor = null;
      loadQueue(true).catch((ex) => toast(ex.message));
    }
  });
  $('#queueList').addEventListener('click', (e) => {
    const li = e.target.closest('.q-item');
    if (li) select(Number(li.dataset.id), true);
  });
  $('#queueList').addEventListener('keydown', (e) => {
    const li = e.target.closest('.q-item');
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(Number(li.dataset.id), true); }
    if (e.key === 'ArrowDown' && li.nextElementSibling) { e.preventDefault(); li.nextElementSibling.focus(); }
    if (e.key === 'ArrowUp' && li.previousElementSibling) { e.preventDefault(); li.previousElementSibling.focus(); }
  });

  // filters
  $('#statusSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#statusSeg button').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    state.status = b.dataset.status;
    if (b.dataset.status === 'resolved' && state.sort === 'priority') { state.sort = 'recent'; $('#sortSel').value = 'recent'; }
    if (b.dataset.status === 'overdue' && state.sort === 'recent') { state.sort = 'priority'; $('#sortSel').value = 'priority'; }
    loadQueue(true).catch((ex) => toast(ex.message));
  });
  $('#sevToggles').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    if (on) state.sev.add(b.dataset.sev); else state.sev.delete(b.dataset.sev);
    loadQueue().catch((ex) => toast(ex.message));
  });
  $('#typeSel').addEventListener('change', (e) => { state.type = e.target.value; loadQueue(true).catch((ex) => toast(ex.message)); });
  $('#sortSel').addEventListener('change', (e) => { state.sort = e.target.value; loadQueue().catch((ex) => toast(ex.message)); });
  $('#inViewChk').addEventListener('change', (e) => { state.inView = e.target.checked; loadQueue().catch((ex) => toast(ex.message)); });
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadQueue(true).catch((ex) => toast(ex.message)); }, 250);
  });

  // ---------------------------------------------------------------- detail
  async function select(id, pan) {
    state.selected = id;
    state.photoIdx = 0;
    $$('.q-item').forEach((li) => li.classList.toggle('is-selected', Number(li.dataset.id) === id));
    highlightMarker();
    const panel = $('#detail');
    panel.hidden = false;
    panel.innerHTML = '<div class="empty">Loading…</div>';
    if (map) setTimeout(() => map.invalidateSize(), 0);
    try {
      const data = await api(`/api/hazards/${id}`);
      if (state.selected !== id) return;
      state.detail = data;
      renderDetail();
      if (pan && map) map.panTo([data.hazard.latitude, data.hazard.longitude], { animate: true });
    } catch (ex) {
      panel.innerHTML = `<div class="empty"><strong>Could not open this hazard</strong>${esc(ex.message)}</div>`;
    }
  }

  function closeDetail() {
    state.selected = null;
    state.detail = null;
    $('#detail').hidden = true;
    $$('.q-item').forEach((li) => li.classList.remove('is-selected'));
    highlightMarker();
    if (map) setTimeout(() => map.invalidateSize(), 0);
  }

  /** The obvious next step for each stage of the workflow. */
  function nextActions(h) {
    switch (h.status) {
      case 'reported':
        return [['verified', 'Verify', 'btn-dark'], ['rejected', 'Reject', 'btn-danger']];
      case 'verified':
        return [['assign', 'Assign a crew', 'btn-primary'], ['resolved', 'Mark fixed', 'btn-dark'], ['rejected', 'Reject', 'btn-danger']];
      case 'assigned':
        return [['in_progress', 'Crew started', 'btn-primary'], ['resolved', 'Mark fixed', 'btn-dark']];
      case 'in_progress':
        return [['resolved', 'Mark fixed', 'btn-primary']];
      default:
        return [['reported', 'Reopen', 'btn-dark']];
    }
  }

  function renderDetail() {
    const { hazard: h, reports, timeline } = state.detail;
    const photos = reports.filter((r) => r.imageUrl).map((r) => r.imageUrl);
    if (h.imageUrl && !photos.includes(h.imageUrl)) photos.unshift(h.imageUrl);
    const photo = photos[state.photoIdx] || null;
    const done = !OPEN.includes(h.status);
    const teams = [...new Set(state.items.map((x) => x.assignedTeam).filter(Boolean))];

    const callouts = [];
    if (h.likelyFixed) {
      callouts.push(`<p class="callout">${plural(h.cleanPasses, 'car has', 'cars have')} driven over this spot since the last sighting without feeling a jolt. It may already be fixed.</p>`);
    }
    if (h.reopenCount) {
      callouts.push(`<p class="callout callout-warn">This came back after being marked fixed ${h.reopenCount === 1 ? 'once' : `${h.reopenCount} times`}. Worth checking the repair method.</p>`);
    }

    // Before and after: the drivers' photo next to the contractor's repair photo.
    const after = h.repairImageUrl;
    const photoBlock = after
      ? `<div class="d-ba">
          <figure>${photo ? `<img src="${esc(photo)}" alt="Before the repair, from a driver's camera">` : '<div class="no-photo">No photo from drivers</div>'}<figcaption>Before</figcaption></figure>
          <figure><img src="${esc(after)}" alt="After the repair, from the contractor"><figcaption>After</figcaption></figure>
        </div>`
      : `<div class="d-photo${photo ? '' : ' is-empty'}">${photo ? `<img src="${esc(photo)}" alt="Photo from a driver's dashboard camera">` : `<div class="no-photo">${h.type === 'bump' ? 'Found by drivers in pocket mode, so there is no photo.' : 'No photo yet. The next driver to pass with the camera on will add one.'}</div>`}</div>`;

    const seg = h.segment;
    const late = h.overdueDays > 0 && !done;
    const canRepair = h.status !== 'rejected' && !(h.status === 'resolved' && after);
    let dueNote = '';
    if (late) dueNote = `Overdue by ${plural(h.overdueDays, 'day', 'days')}`;
    else if (h.dueAt && !done) dueNote = dueIn(h.dueAt);
    else if (h.dueAt && h.status === 'resolved' && h.resolvedAt) {
      const lateBy = Math.floor((h.resolvedAt - h.dueAt) / 86400000);
      dueNote = h.resolvedAt <= h.dueAt ? 'Fixed on time' : `Fixed ${plural(Math.max(1, lateBy), 'day', 'days')} late`;
    }
    const duty = h.contractor
      ? `<dl class="duty">
          <div><dt>Contractor</dt><dd>${esc(h.contractor.name)}${h.contractor.phone ? `<small><a href="tel:${esc(h.contractor.phone.replace(/\s+/g, ''))}">${esc(h.contractor.phone)}</a></small>` : ''}</dd></div>
          <div><dt>Ward</dt><dd>${seg && seg.ward ? esc(seg.ward) : '–'}</dd></div>
          <div class="wide"><dt>Tender</dt><dd class="tender">${seg && seg.tenderId ? esc(seg.tenderId) : '<span class="muted">Not recorded</span>'}</dd></div>
          <div class="wide"><dt>Officer</dt><dd>${seg && seg.officerName ? esc(seg.officerName) : 'Ward officer'}${seg && seg.officerContact ? `<small>${esc(seg.officerContact)}</small>` : ''}</dd></div>
          <div class="${late ? 'is-late' : ''}"><dt>Due</dt><dd>${h.dueAt ? esc(day(h.dueAt)) : '–'}<small>${dueNote}</small></dd></div>
          <div class="${h.escalationLevel && !done ? 'is-late' : ''}"><dt>Escalation</dt><dd>${h.escalationLevel ? `Level ${h.escalationLevel} of 3` : 'None'}</dd></div>
        </dl>
        ${h.underWarranty ? `<p class="note-warranty">Under warranty${seg && seg.warrantyUntil ? ` until ${esc(day(seg.warrantyUntil))}` : ''}. The contractor must repair it at no cost.</p>` : ''}`
      : `<p class="d-muted">No contractor is mapped to this road yet. Add the road on the Contractors tab, or assign a crew below.</p>`;

    $('#detail').innerHTML = `
      <div class="d-head">
        <div>
          <h2>${esc(h.roadName || 'Unnamed road')}</h2>
          <p>${TYPE_WORD[h.type]} #${h.id}, first seen ${esc(ago(h.firstReportedAt))}</p>
        </div>
        <button class="d-close" type="button" aria-label="Close">×</button>
      </div>
      ${photoBlock}
      ${photos.length > 1 ? `<div class="d-thumbs">${photos.map((p, i) => `<button type="button" data-idx="${i}" class="${i === state.photoIdx ? 'is-on' : ''}" aria-label="Photo ${i + 1}"><img src="${esc(p)}" alt=""></button>`).join('')}</div>` : ''}
      <div class="d-sev" style="--c:${SEV_VAR[h.severityLevel]}">
        <span class="d-score">${Math.round(h.severityScore)}</span>
        <span class="d-score-label"><strong>${SEV_WORD[h.severityLevel]}</strong>severity out of 100</span>
        <span class="d-prio"><b>${done ? '–' : Math.round(h.priority)}</b><span>priority</span></span>
      </div>
      <dl class="facts">
        <div><dt>Drivers</dt><dd>${h.uniqueReporters}</dd></div>
        <div><dt>Sightings</dt><dd>${h.reportCount}</dd></div>
        <div><dt>Status</dt><dd>${STATUS_WORD[h.status]}</dd></div>
        <div><dt>Hardest jolt</dt><dd>${h.maxShock ? `${h.maxShock.toFixed(1)} m/s²` : 'none felt'}</dd></div>
        <div><dt>Traffic speed</dt><dd>${Math.round(h.avgSpeed)} km/h</dd></div>
        <div><dt>${done ? 'Was open' : 'Waiting'}</dt><dd>${openFor(h)}</dd></div>
      </dl>
      ${callouts.length ? `<div style="display:grid;gap:8px;margin-top:12px">${callouts.join('')}</div>` : ''}

      <section class="d-sec d-duty">
        <h3>Who fixes it</h3>
        ${duty}
        <div class="actions" style="margin-top:12px">
          ${canRepair ? '<button class="btn btn-dark" type="button" data-act="repair">Upload repair photo</button><input type="file" id="repairInput" accept="image/jpeg,image/png" hidden>' : ''}
          <button class="btn" type="button" data-act="complaint" data-lang="en">Copy complaint</button>
          <button class="btn" type="button" data-act="complaint" data-lang="hi" lang="hi">Copy in Hindi</button>
          <a class="btn" href="${esc(h.publicUrl)}" target="_blank" rel="noopener">Open public page</a>
        </div>
      </section>

      <section class="d-sec">
        <h3>Next step</h3>
        <div class="actions">
          ${nextActions(h).map(([to, label, cls]) => `<button class="btn ${cls}" type="button" data-to="${to}">${label}</button>`).join('')}
        </div>
        <div class="assign" ${['reported', 'resolved', 'rejected'].includes(h.status) ? 'hidden' : ''}>
          <input id="teamInput" list="teamList" placeholder="Crew or team name" value="${esc(h.assignedTeam || '')}" aria-label="Assigned crew">
          <datalist id="teamList">${teams.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <button class="btn" type="button" data-act="save-team">Save crew</button>
        </div>
        <div class="note"><textarea id="noteInput" placeholder="Add a note for the record (optional)" aria-label="Note"></textarea></div>
        <div class="actions" style="margin-top:8px">
          <button class="btn btn-quiet" type="button" data-act="note">Save note</button>
          <a class="btn btn-quiet" href="https://www.google.com/maps/search/?api=1&query=${h.latitude},${h.longitude}" target="_blank" rel="noopener">Open in Google Maps</a>
        </div>
      </section>

      <section class="d-sec">
        <h3>History</h3>
        <ol class="timeline">
          ${timeline
            .slice()
            .reverse()
            .map(
              (e) => `<li>
                <div class="t-what">${esc(e.type === 'status_change' && e.toStatus ? `${STATUS_WORD[e.toStatus]}` : EVENT_WORD[e.type] || e.type)}</div>
                <div class="t-when">${esc(when(e.createdAt))}, ${esc(e.actor)}</div>
                ${e.note ? `<div class="t-note">${esc(e.note)}</div>` : ''}
              </li>`
            )
            .join('')}
        </ol>
      </section>

      <section class="d-sec">
        <h3>Sightings</h3>
        <ul class="sightings">
          ${reports
            .slice(0, 12)
            .map(
              (r) => `<li style="--c:${SEV_VAR[r.severityLevel]}">
                <span class="s-sev">${Math.round(r.severityScore)}</span>
                <span><div>${esc(when(r.timestamp))}${r.reporter ? `, ${esc(r.reporter)}` : ''}</div>
                  <div class="s-meta">${r.source === 'sensor' ? 'Felt, no camera' : `${Math.round(r.confidence * 100)}% AI confidence`}, ${r.shock ? `${r.shock.toFixed(1)} m/s² jolt` : 'no jolt'}, ${Math.round(r.speed)} km/h</div></span>
                <span class="s-src">${r.source === 'manual' ? 'Tapped' : r.source === 'sensor' ? 'Pocket' : 'Auto'}</span>
              </li>`
            )
            .join('')}
        </ul>
      </section>`;
  }

  $('#detail').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('d-close')) return closeDetail();
    if (t.dataset.idx) { state.photoIdx = Number(t.dataset.idx); return renderDetail(); }
    const h = state.detail && state.detail.hazard;
    if (!h) return;
    if (t.dataset.act === 'repair') { $('#repairInput').click(); return; }
    if (t.dataset.act === 'complaint') {
      t.disabled = true;
      try {
        const c = await api(`/api/hazards/${h.id}/complaint?lang=${t.dataset.lang}`);
        await copyText(c.body);
        toast(t.dataset.lang === 'hi' ? 'Hindi complaint copied. Paste it into an email or WhatsApp.' : 'Complaint copied. Paste it into an email or WhatsApp.');
      } catch (ex) { toast(ex.message); }
      t.disabled = false;
      return;
    }
    const note = ($('#noteInput') && $('#noteInput').value.trim()) || undefined;
    let body = null;
    if (t.dataset.to === 'assign') {
      const input = $('#teamInput');
      input.focus();
      if (!input.value.trim()) { toast('Type the crew name, then press Save crew.'); return; }
      body = { assignedTeam: input.value.trim(), note };
    } else if (t.dataset.to) {
      body = { status: t.dataset.to, note };
    } else if (t.dataset.act === 'save-team') {
      body = { assignedTeam: $('#teamInput').value.trim() || null, note };
    } else if (t.dataset.act === 'note') {
      if (!note) { toast('Write a note first.'); return; }
      body = { note };
    }
    if (!body) return;
    t.disabled = true;
    try {
      await api(`/api/hazards/${h.id}`, { method: 'PATCH', body });
      toast(body.status ? `Marked ${STATUS_WORD[body.status].toLowerCase()}` : body.assignedTeam ? `Assigned to ${body.assignedTeam}` : 'Saved');
      await Promise.all([loadQueue(), loadPulse()]);
      await select(h.id, false);
    } catch (ex) {
      toast(ex.message);
      t.disabled = false;
    }
  });

  $('#detail').addEventListener('change', async (e) => {
    if (e.target.id !== 'repairInput' || !e.target.files.length) return;
    const h = state.detail && state.detail.hazard;
    if (!h) return;
    const form = new FormData();
    form.append('image', e.target.files[0]);
    const note = $('#noteInput') && $('#noteInput').value.trim();
    if (note) form.append('note', note);
    const btn = $('[data-act="repair"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    try {
      await api(`/api/hazards/${h.id}/repair`, { method: 'POST', body: form });
      toast('Repair photo saved. Marked fixed.');
      await Promise.all([loadQueue(), loadPulse()]);
      await select(h.id, false);
    } catch (ex) {
      toast(ex.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Upload repair photo'; }
    }
  });

  /** Clipboard API needs https or localhost; fall back to a hidden textarea on plain http. */
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) { /* fall through */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Could not copy. Your browser blocked the clipboard.');
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDetail(); });

  // ---------------------------------------------------------------- insights
  function barChart(trend) {
    const W = 700, Hh = 220, pad = { l: 28, r: 8, t: 8, b: 26 };
    const max = Math.max(4, ...trend.map((d) => Math.max(d.reports, d.resolved)));
    const step = (W - pad.l - pad.r) / trend.length;
    const bw = Math.max(3, step * 0.36);
    const y = (v) => pad.t + (Hh - pad.t - pad.b) * (1 - v / max);
    const ticks = [0, Math.round(max / 2), max];
    let svg = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Daily sightings and fixes">`;
    ticks.forEach((t) => { svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`; });
    trend.forEach((d, i) => {
      const x = pad.l + i * step + step / 2;
      svg += `<rect x="${x - bw - 1}" y="${y(d.reports)}" width="${bw}" height="${y(0) - y(d.reports)}" rx="2" class="bar-ink"><title>${d.date}: ${d.reports} sightings</title></rect>`;
      svg += `<rect x="${x + 1}" y="${y(d.resolved)}" width="${bw}" height="${y(0) - y(d.resolved)}" rx="2" fill="#3E9C73"><title>${d.date}: ${d.resolved} fixed</title></rect>`;
      if (i % Math.ceil(trend.length / 7) === 0 || i === trend.length - 1) {
        const lbl = new Date(d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        svg += `<text class="ax" x="${x}" y="${Hh - 6}" text-anchor="middle">${lbl}</text>`;
      }
    });
    return `${svg}</svg>`;
  }

  async function loadInsights() {
    const el = $('#insights');
    el.innerHTML = '<div class="panel span-12">Loading…</div>';
    const [ov, roads] = await Promise.all([api('/api/stats/overview?days=30'), api('/api/stats/roads?limit=50')]);
    const t = ov.totals;
    const funnel = [
      ['New', t.reported], ['Verified', t.verified], ['Assigned', t.assigned], ['Crew working', t.inProgress], ['Fixed', t.resolved],
    ];
    const fmax = Math.max(1, ...funnel.map((f) => f[1]));
    const sevRows = [['Critical', t.critical, 'var(--critical)'], ['High', t.high, 'var(--high)'], ['Medium', t.medium, 'var(--medium)'], ['Low', t.low, 'var(--low)']];
    const smax = Math.max(1, ...sevRows.map((s) => s[1]));
    el.innerHTML = `
      <div class="panel span-12">
        <div class="headline">
          <div><b>${t.open}</b><span>open hazards</span></div>
          <div><b>${t.critical + t.high}</b><span>critical or high</span></div>
          <div><b>${t.resolutionRate}%</b><span>of real hazards fixed</span></div>
          <div><b>${t.avgResolutionHours == null ? '–' : t.avgResolutionHours < 48 ? `${Math.round(t.avgResolutionHours)} h` : `${Math.round(t.avgResolutionHours / 24)} days`}</b><span>average time to fix</span></div>
          <div><b>${t.activeReporters}</b><span>drivers reporting this month</span></div>
          <div><b>${fmtKm(t.kmScanned30d)}</b><span>km of road scanned in 30 days</span></div>
          <div class="${t.overdue ? 'is-late' : ''}"><b>${t.overdue || 0}</b><span>past the contractor's deadline</span></div>
        </div>
      </div>
      <div class="panel span-7 chart">
        <h2>Sightings and fixes, last 30 days</h2>
        <p>If the dark bars keep outgrowing the green ones, the backlog is growing.</p>
        ${barChart(ov.trend)}
        <div class="chart-key"><span><i class="key-ink"></i>Sightings from drivers</span><span><i style="background:#3E9C73"></i>Hazards fixed</span></div>
      </div>
      <div class="panel span-5">
        <h2>Where every hazard is right now</h2>
        <p>From a driver's first report to a fixed road.</p>
        <ol class="funnel">${funnel.map(([k, v]) => `<li><span>${k}</span><span class="bar"><i style="width:${(v / fmax) * 100}%"></i></span><b>${v}</b></li>`).join('')}</ol>
        <h2 style="margin-top:24px">Open hazards by severity</h2>
        <ol class="funnel" style="margin-top:10px">${sevRows.map(([k, v, c]) => `<li><span>${k}</span><span class="bar"><i style="width:${(v / smax) * 100}%;background:${c}"></i></span><b>${v}</b></li>`).join('')}</ol>
      </div>
      <div class="panel span-12">
        <h2>Road health</h2>
        <p>100 is a clean road. Open hazards pull the score down by type and severity. Worst roads first: candidates for resurfacing rather than one-off patching.</p>
        ${roads.items.length ? `<div class="table-scroll"><table class="roads roads-health"><thead><tr>
          <th>Road</th><th>Health</th><th class="n">Open</th><th class="n">Potholes</th><th class="n">Cracks</th><th>Worst</th><th>Scanned, 30 days</th><th>Contractor</th>
        </tr></thead><tbody>
          ${roads.items.map((r) => {
            const lvl = r.healthScore < 50 ? 'CRITICAL' : r.healthScore < 70 ? 'HIGH' : r.healthScore < 85 ? 'MEDIUM' : 'LOW';
            const scanned = r.kmScanned30d > 0
              ? `${fmtKm(r.kmScanned30d)} km<small>last scan ${esc(ago(r.lastScannedAt))}</small>`
              : `<span class="warn-text">Not checked</span><small>${r.lastScannedAt ? `last scan ${esc(ago(r.lastScannedAt))}` : 'never scanned'}</small>`;
            return `<tr>
              <td>${esc(r.road)}</td>
              <td class="nowrap"><span class="meter" style="--c:${SEV_VAR[lvl]}"><i style="width:${r.healthScore}%"></i></span><b>${r.healthScore}</b></td>
              <td class="n">${r.openHazards}</td><td class="n">${r.potholes}</td><td class="n">${r.cracks}</td>
              <td>${r.worstSeverity ? `<span class="sev-word" style="--c:${SEV_VAR[r.worstSeverity]}">${SEV_WORD[r.worstSeverity]}</span>` : '–'}</td>
              <td class="stack">${scanned}</td>
              <td>${r.contractor ? esc(r.contractor) : '<span class="muted">Not mapped</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody></table></div>` : '<div class="empty">No hazards with a road name yet.</div>'}
      </div>`;
  }

  // ---------------------------------------------------------------- team
  async function loadTeam() {
    const el = $('#team');
    el.innerHTML = '<div class="panel">Loading…</div>';
    const { items } = await api('/api/stats/users');
    const staff = items.filter((u) => u.role !== 'citizen');
    const drivers = items.filter((u) => u.role === 'citizen');
    const row = (u) => `<div class="team-row">
        <div><strong>${esc(u.name)}</strong><small>${esc(u.email || '')}</small></div>
        <div><small>${u.role === 'citizen' ? `${u.points} points` : esc(u.team || 'No team')}</small></div>
        <select data-uid="${u.id}" aria-label="Access for ${esc(u.name)}">
          <option value="citizen" ${u.role === 'citizen' ? 'selected' : ''}>Driver</option>
          <option value="authority" ${u.role === 'authority' ? 'selected' : ''}>City team</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select></div>`;
    el.innerHTML = `
      <div class="panel"><h2>City team</h2><p>People who can see this dashboard and update hazards.</p>${staff.map(row).join('')}</div>
      <div class="panel"><h2>Registered drivers</h2><p>Give a driver city team access by changing their role.</p>${drivers.length ? drivers.map(row).join('') : '<div class="empty">No registered drivers yet.</div>'}</div>`;
  }
  $('#team').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-uid]');
    if (!sel) return;
    try {
      await api(`/api/stats/users/${sel.dataset.uid}`, { method: 'PATCH', body: { role: sel.value } });
      toast('Access updated');
      loadTeam();
    } catch (ex) { toast(ex.message); loadTeam(); }
  });


  // ---------------------------------------------------------------- contractors
  let contractorsCache = [];
  let segmentsCache = [];
  const rateColor = (v) => (v >= 80 ? 'var(--low)' : v >= 50 ? 'var(--medium)' : 'var(--critical)');
  /** Warranty dates are stored as the end of that day in India; this gives the calendar date back. */
  const isoDay = (t) => new Date(t + 330 * 60000).toISOString().slice(0, 10);

  async function loadContractors() {
    const el = $('#contractors');
    if (!el.innerHTML) el.innerHTML = '<div class="panel">Loading…</div>';
    const [c, sg] = await Promise.all([api('/api/contractors'), api('/api/segments')]);
    contractorsCache = c.items;
    segmentsCache = sg.items;
    renderContractors();
  }

  function segmentForm(g) {
    const v = (k) => esc(g && g[k] != null ? g[k] : '');
    return `<form class="inline-form seg-form" id="segmentForm" autocomplete="off" novalidate>
      <h3>${g ? `Edit ${esc(g.roadPattern)}` : 'Add a road'}</h3>
      <div class="form-grid">
        <label class="field"><span>Road name, or part of it</span><input name="roadPattern" required maxlength="120" value="${v('roadPattern')}" placeholder="Rajpur Road"></label>
        <label class="field"><span>Ward</span><input name="ward" maxlength="80" value="${v('ward')}"></label>
        <label class="field"><span>Contractor</span><select name="contractorId"><option value="">None</option>${contractorsCache
          .map((c) => `<option value="${c.id}" ${g && g.contractorId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)
          .join('')}</select></label>
        <label class="field"><span>Tender ID</span><input name="tenderId" maxlength="80" value="${v('tenderId')}"></label>
        <label class="field"><span>Officer</span><input name="officerName" maxlength="120" value="${v('officerName')}" placeholder="Assistant Engineer, PWD"></label>
        <label class="field"><span>Officer phone or email</span><input name="officerContact" maxlength="120" value="${v('officerContact')}"></label>
        <label class="field"><span>Days to fix</span><input name="slaDays" type="number" min="1" max="365" value="${g ? g.slaDays : 7}"></label>
        <label class="field"><span>Warranty until</span><input name="warrantyUntil" type="date" value="${g && g.warrantyUntil ? isoDay(g.warrantyUntil) : ''}"></label>
      </div>
      <details ${g && g.minLat != null ? 'open' : ''}><summary>Limit to an area (optional)</summary>
        <div class="form-grid">
          <label class="field"><span>South latitude</span><input name="minLat" type="number" step="any" value="${v('minLat')}"></label>
          <label class="field"><span>West longitude</span><input name="minLng" type="number" step="any" value="${v('minLng')}"></label>
          <label class="field"><span>North latitude</span><input name="maxLat" type="number" step="any" value="${v('maxLat')}"></label>
          <label class="field"><span>East longitude</span><input name="maxLng" type="number" step="any" value="${v('maxLng')}"></label>
        </div>
      </details>
      <p class="form-error" id="segmentError" role="alert"></p>
      <div class="actions">
        <button class="btn btn-dark" type="submit">${g ? 'Save changes' : 'Add road'}</button>
        <button class="btn btn-quiet" type="button" data-act="cancel-segment">Cancel</button>
      </div>
    </form>`;
  }

  function importSummary(r) {
    if (!r) return '';
    const parts = [`${plural(r.imported, 'road', 'roads')} imported${r.updated ? ` (${r.updated} updated)` : ''}`];
    if (r.contractorsCreated) parts.push(`${plural(r.contractorsCreated, 'new contractor', 'new contractors')}`);
    if (r.assigned) parts.push(`${plural(r.assigned, 'hazard', 'hazards')} sent to contractors`);
    return `<div class="import-result">
      <p><strong>${esc(parts.join(', '))}.</strong></p>
      ${r.errors.length ? `<p>${plural(r.errors.length, 'row was', 'rows were')} skipped:</p><ul>${r.errors
        .map((e) => `<li>${e.line ? `Line ${e.line}: ` : ''}${esc(e.message)}</li>`)
        .join('')}</ul>` : ''}
    </div>`;
  }

  function renderContractors() {
    const el = $('#contractors');
    const ed = state.editingSegment;
    const cards = contractorsCache;
    const segs = segmentsCache;
    el.innerHTML = `
      <div class="panel">
        <h2>Contractor scorecards</h2>
        <p>How each contractor is doing on the roads they maintain. Late fixes and work still overdue both count against the on-time rate.</p>
        ${cards.length ? `<div class="table-scroll"><table class="roads score">
          <thead><tr><th>Contractor</th><th class="n">Roads</th><th class="n">Assigned</th><th class="n">Open</th><th class="n">Overdue</th><th class="n">Fixed</th><th class="n">Days to fix</th><th>On time</th><th class="n">Came back</th><th></th></tr></thead>
          <tbody>${cards.map((c) => `<tr>
            <td class="stack"><strong>${esc(c.name)}</strong>${c.phone ? `<small>${esc(c.phone)}</small>` : ''}</td>
            <td class="n">${c.segments}</td>
            <td class="n">${c.assigned}</td>
            <td class="n">${c.open}</td>
            <td class="n${c.overdue ? ' late' : ''}">${c.overdue}</td>
            <td class="n">${c.fixed}</td>
            <td class="n">${c.avgFixDays == null ? '–' : c.avgFixDays}</td>
            <td class="nowrap">${c.onTimeRate == null ? '<span class="muted">No deadlines yet</span>' : `<span class="meter" style="--c:${rateColor(c.onTimeRate)}"><i style="width:${c.onTimeRate}%"></i></span>${c.onTimeRate}%`}</td>
            <td class="n${c.reopenedAfterRepair ? ' late' : ''}" title="Hazards that came back after this contractor's repair">${c.reopenedAfterRepair}</td>
            <td class="n nowrap"><button class="link-btn" type="button" data-act="show-queue" data-id="${c.id}">Show hazards</button></td>
          </tr>`).join('')}</tbody></table></div>
          <p class="table-note">Days to fix: average from being sent to the contractor to the repair. Came back: repairs that drivers later found broken again.</p>` : '<div class="empty"><strong>No contractors yet</strong>Add one below, or import a spreadsheet of roads.</div>'}
        <form class="inline-form" id="contractorForm" autocomplete="off">
          <h3>Add a contractor</h3>
          <div class="form-grid">
            <label class="field"><span>Name</span><input name="name" required maxlength="120"></label>
            <label class="field"><span>Phone</span><input name="phone" maxlength="40" inputmode="tel"></label>
            <label class="field"><span>Email</span><input name="email" type="email" maxlength="120"></label>
            <div class="field field-end"><button class="btn btn-dark" type="submit">Add contractor</button></div>
          </div>
        </form>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Roads and who maintains them</h2>
            <p>Once a hazard is verified, or rated high or critical, it goes to the contractor for its road with a deadline. The road name only has to contain the text entered here. Limit an entry to an area when one road is split between contractors.</p>
          </div>
          ${ed ? '' : '<button class="btn btn-primary" type="button" data-act="new-segment">Add a road</button>'}
        </div>
        ${ed ? segmentForm(ed === 'new' ? null : ed) : ''}
        ${segs.length ? `<div class="table-scroll"><table class="roads segs">
          <thead><tr><th>Road</th><th>Ward</th><th>Contractor</th><th>Tender</th><th>Officer</th><th class="n">Days to fix</th><th>Warranty</th><th class="n">Open</th><th></th></tr></thead>
          <tbody>${segs.map((g) => `<tr>
            <td class="stack"><strong>${esc(g.roadPattern)}</strong>${g.minLat != null ? '<small>Part of the road only</small>' : ''}</td>
            <td>${g.ward ? esc(g.ward) : '–'}</td>
            <td>${g.contractor ? esc(g.contractor.name) : '<span class="muted">None</span>'}</td>
            <td class="mono">${g.tenderId ? esc(g.tenderId) : '–'}</td>
            <td class="stack">${g.officerName ? esc(g.officerName) : '–'}${g.officerContact ? `<small>${esc(g.officerContact)}</small>` : ''}</td>
            <td class="n">${g.slaDays}</td>
            <td class="nowrap">${g.warrantyUntil ? (g.warrantyUntil > Date.now() ? `Until ${esc(day(g.warrantyUntil))}` : `<span class="muted">Ended ${esc(day(g.warrantyUntil))}</span>`) : '<span class="muted">None</span>'}</td>
            <td class="n">${g.openHazards}</td>
            <td class="n nowrap"><button class="link-btn" type="button" data-act="edit-segment" data-id="${g.id}">Edit</button><button class="link-btn link-danger" type="button" data-act="delete-segment" data-id="${g.id}">Delete</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty"><strong>No roads mapped yet</strong>Add a road, or import a spreadsheet below.</div>'}
      </div>

      <div class="panel">
        <h2>Import roads from a spreadsheet</h2>
        <p>Paste CSV text, or choose a .csv file saved from Excel or Google Sheets. Contractors are matched by name and added if new. Importing the same road and tender again updates it.</p>
        <div class="actions" style="margin-bottom:10px">
          <a class="btn" href="/api/segments/template.csv" download="roadguard-road-segments.csv">Download template</a>
          <button class="btn" type="button" data-act="pick-csv">Choose a file</button>
          <input type="file" id="csvFile" accept=".csv,text/csv" hidden>
        </div>
        <textarea id="csvText" class="csv-box" spellcheck="false" aria-label="CSV text" placeholder="road_pattern,ward,contractor,officer_name,officer_contact,tender_id,sla_days,warranty_until">${esc(state.csvDraft || '')}</textarea>
        <div class="actions" style="margin-top:10px"><button class="btn btn-dark" type="button" data-act="import-csv">Import</button></div>
        <div id="importResult" aria-live="polite">${importSummary(state.importResult)}</div>
      </div>`;
  }

  const blank = (v) => {
    const t = String(v == null ? '' : v).trim();
    return t === '' ? null : t;
  };
  const num = (v) => (blank(v) === null ? null : Number(v));

  $('#contractors').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || !t.dataset.act) return;
    const act = t.dataset.act;
    if (act === 'show-queue') {
      const c = contractorsCache.find((x) => x.id === Number(t.dataset.id));
      state.contractor = { id: c.id, name: c.name };
      setView('queue');
      loadQueue(true).catch((ex) => toast(ex.message));
    } else if (act === 'new-segment') {
      state.editingSegment = 'new';
      renderContractors();
      $('#segmentForm input').focus();
    } else if (act === 'edit-segment') {
      state.editingSegment = segmentsCache.find((x) => x.id === Number(t.dataset.id));
      renderContractors();
      $('#segmentForm').scrollIntoView({ block: 'nearest' });
      $('#segmentForm input').focus();
    } else if (act === 'cancel-segment') {
      state.editingSegment = null;
      renderContractors();
    } else if (act === 'delete-segment') {
      const g = segmentsCache.find((x) => x.id === Number(t.dataset.id));
      if (!window.confirm(`Delete the entry for ${g.roadPattern}? Hazards already sent to a contractor stay with them.`)) return;
      try {
        await api(`/api/segments/${g.id}`, { method: 'DELETE' });
        toast('Road removed');
        await loadContractors();
      } catch (ex) { toast(ex.message); }
    } else if (act === 'pick-csv') {
      $('#csvFile').click();
    } else if (act === 'import-csv') {
      const csv = $('#csvText').value;
      state.csvDraft = csv;
      if (!csv.trim()) { toast('Paste the CSV text or choose a file first.'); return; }
      t.disabled = true;
      try {
        const r = await api('/api/segments/import', { method: 'POST', body: { csv } });
        state.importResult = r;
        if (!r.errors.length) state.csvDraft = '';
        toast(`${plural(r.imported, 'road', 'roads')} imported`);
        await Promise.all([loadContractors(), loadPulse()]);
      } catch (ex) { toast(ex.message); t.disabled = false; }
    }
  });

  $('#contractors').addEventListener('change', (e) => {
    if (e.target.id !== 'csvFile' || !e.target.files.length) return;
    const reader = new FileReader();
    reader.onload = () => { $('#csvText').value = String(reader.result || ''); state.csvDraft = $('#csvText').value; };
    reader.onerror = () => toast('Could not read that file.');
    reader.readAsText(e.target.files[0]);
  });

  $('#contractors').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const val = (n) => (f.elements[n] ? f.elements[n].value : '');
    if (f.id === 'contractorForm') {
      try {
        await api('/api/contractors', { method: 'POST', body: { name: val('name').trim(), phone: blank(val('phone')), email: blank(val('email')) } });
        toast('Contractor added');
        await loadContractors();
      } catch (ex) { toast(ex.message); }
      return;
    }
    if (f.id === 'segmentForm') {
      const editing = state.editingSegment && state.editingSegment !== 'new' ? state.editingSegment : null;
      const body = {
        roadPattern: val('roadPattern').trim(),
        ward: blank(val('ward')),
        contractorId: num(val('contractorId')),
        tenderId: blank(val('tenderId')),
        officerName: blank(val('officerName')),
        officerContact: blank(val('officerContact')),
        slaDays: num(val('slaDays')) || 7,
        warrantyUntil: blank(val('warrantyUntil')),
        minLat: num(val('minLat')), minLng: num(val('minLng')), maxLat: num(val('maxLat')), maxLng: num(val('maxLng')),
      };
      try {
        const r = await api(editing ? `/api/segments/${editing.id}` : '/api/segments', { method: editing ? 'PATCH' : 'POST', body });
        state.editingSegment = null;
        toast(r.assigned ? `Saved. ${plural(r.assigned, 'hazard', 'hazards')} sent to the contractor.` : 'Saved');
        await Promise.all([loadContractors(), loadPulse()]);
      } catch (ex) {
        $('#segmentError').textContent = ex.message;
      }
    }
  });

  // ---------------------------------------------------------------- views
  function setView(v) {
    state.view = v;
    $$('.tab').forEach((t) => { const on = t.dataset.view === v; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on)); });
    $$('.view').forEach((s) => { s.hidden = s.id !== `view-${v}`; });
    if (v === 'queue' && map) setTimeout(() => map.invalidateSize(), 0);
    if (v === 'insights') loadInsights().catch((e) => toast(e.message));
    if (v === 'team') loadTeam().catch((e) => toast(e.message));
    if (v === 'contractors') loadContractors().catch((e) => toast(e.message));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

  $('#exportBtn').addEventListener('click', async () => {
    try {
      const p = queueParams();
      p.delete('limit');
      const res = await fetch(`/api/hazards/export.csv?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `roadguard-hazards-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (ex) { toast(ex.message); }
  });

  // ---------------------------------------------------------------- start
  let refreshTimer;
  async function start(user) {
    state.me = user;
    $('#login').hidden = true;
    $('#shell').hidden = false;
    $('#meName').textContent = user.name;
    $('#teamTab').hidden = user.role !== 'admin';
    initMap();
    setTimeout(() => map.invalidateSize(), 0);
    await Promise.all([loadPulse(), loadQueue(true)]).catch((e) => toast(e.message));
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.hidden || state.view !== 'queue') return;
      loadPulse().catch(() => {});
      loadQueue().catch(() => {});
    }, 30000);
  }

  (async function boot() {
    if (!token) return showLogin();
    try {
      const { user } = await api('/api/auth/me');
      if (!['authority', 'admin'].includes(user.role)) return signOut();
      start(user);
    } catch (_) {
      signOut();
    }
  })();
})();
