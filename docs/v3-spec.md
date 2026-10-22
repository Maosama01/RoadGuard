# RoadGuard v3 build spec (shared contract)

Goal: take the best idea from every Indian competitor and close the gaps in RoadGuard.

| From | Idea we adopt |
|---|---|
| Intents Mobi, RoadBounce | **Pocket mode**: phone in pocket/holder, accelerometer + GPS only, runs in the background. No mounting. |
| Mappls, Ather Pothole+ | **Voice warnings in pocket mode too**, not only in camera mode. |
| BBMP PACE, Rajmargyatra | **Accountability**: every hazard routed to the responsible contractor with a deadline (SLA), automatic **escalation** when overdue, **repair photo required** to close. |
| Gaurav Sen's Bengaluru tool | **Tender / contractor / officer mapping per road**, **warranty** flag (contractor must fix free), **4-second complaint** text + shareable public link. |
| RoadMetrics | **Multiple damage classes** (cracks, not only potholes) and a **Road Health Index** per road. |
| Nayan, RoadMetrics | **Coverage**: which roads were actually scanned and when ("no reports" must not mean "not checked"). |
| Spothole | **Public shareable hazard page** that tracks repairs and resurfacing. |
| (gap) | **Privacy**: blur everything except the hazard region in photos (DPDP Act 2023). |
| (gap) | **Hindi** UI and Hindi voice alerts. |
| (gap) | **HTTPS deployment** files. |

All JSON is camelCase. Existing endpoints and shapes stay backward compatible.

---

## 1. New hazard types

`TYPES = ['pothole', 'drain_hole', 'sewer_cover', 'crack', 'bump', 'other']`

* `crack` = alligator/fatigue cracking detected by the camera model (precursor to potholes). Reportable, normally LOW/MEDIUM.
* `bump` = rough patch found by **pocket mode only** (no photo). Created only after corroboration (see 2).

Display names: pothole "Pothole", drain_hole "Open drain", sewer_cover "Sewer cover", crack "Cracked surface", bump "Rough patch", other "Road hazard".

## 2. Pocket mode sensor hits

`POST /api/sensor-hits` (auth). Body:
```json
{ "hits": [ { "clientId": "uuid", "latitude": 30.31, "longitude": 78.03, "accuracy": 6.5,
              "speed": 32.4, "heading": 120.0, "shock": 9.8, "timestamp": 1792482776015 } ] }
```
Max 200 hits per call. Idempotent on clientId. Hits older than 14 days or with accuracy > 30 m or speed < 10 km/h are ignored (counted in `ignored`).

Server rule (corroboration, because one jolt can be a speed breaker or a door slam):
1. If an existing hazard (any type except sewer_cover) with status not `rejected` is within 15 m: add the hit to it as a report with `source='sensor'`, `confidence=0`, `severity_score` from shock+speed (formula below). This confirms it and counts as a sighting (resets clean passes; can reopen a resolved hazard exactly like a camera report).
2. Otherwise store the hit in `sensor_hits`. When **3 or more distinct users** have hits within 15 m in the last 30 days, promote: create a hazard of type `bump` (status `reported`), attach all those hits as reports (`source='sensor'`), and delete them from `sensor_hits`.
3. Rejected hazards absorb hits silently (a speed breaker rejected by the city never comes back).

Sensor severity: `score = clamp(0,100, (min(shock,20)/20)*65 + (min(speed,80)/80)*35)`.

Response: `{ "success": true, "accepted": 5, "ignored": 1, "confirmed": 2, "promoted": 1, "pointsAwarded": 3 }`. Points: +1 per hit that confirmed an existing hazard (once per hazard per user), +5 to each contributing user when a bump is promoted.

Reports table `source` CHECK becomes `('auto','manual','sensor')`.

## 3. Drives and coverage

`POST /api/drives` (auth):
```json
{ "clientId": "uuid", "mode": "camera" | "pocket", "startedAt": 1792482000000, "endedAt": 1792483800000,
  "distanceMeters": 12450, "path": [[30.31, 78.03, 1792482000000], ...] }
```
Path is downsampled by the app (one point per ~40 m, max 2000 points). Server snaps each point to a grid cell (~110 m: lat/lng rounded to 0.001) and upserts `coverage_cells(cell_key, lat, lng, scans, last_scanned_at, last_mode)`; one drive counts once per cell. Idempotent on clientId. Response `{ success, cells, distanceMeters }`.

`GET /api/coverage?bbox=minLng,minLat,maxLng,maxLat&days=30` → `{ success, cells: [{ lat, lng, scans, lastScannedAt }] }` (max 20000).

User stats (`/api/stats/me`) gain `kmScanned` and `drives`. Overview gains `kmScanned30d`.

## 4. Accountability

Tables:
* `contractors(id, name, phone, email, created_at)`
* `road_segments(id, road_pattern, ward, contractor_id, officer_name, officer_contact, tender_id, sla_days default 7, warranty_until (ms, nullable), min_lat, min_lng, max_lat, max_lng (nullable bbox), created_at)`

Hazard gains columns: `contractor_id, segment_id, due_at, escalation_level (default 0), last_escalated_at, repair_image, under_warranty (0/1)`.

Matching: a hazard matches a segment when `lower(road_name)` contains `lower(road_pattern)` AND (segment bbox is null OR hazard point inside bbox). Most specific match wins (bbox set beats null; longer pattern beats shorter).

Auto-assignment: when a hazard becomes `verified` (auto or manual), or is created/updated with severity HIGH or CRITICAL, and has no contractor yet and a segment matches: set contractor/segment, `due_at = now + sla_days` (CRITICAL: half, min 1 day), status `assigned`, `assigned_team = contractor name`, event `auto_assigned` with note "Sent to <contractor> under tender <id>. Due <date>.". If `warranty_until > now`, set `under_warranty=1` and the note adds "Under warranty: repair at no cost."

Escalation: run on every server start, hourly, and lazily when listing. For open hazards with `due_at < now`: `escalation_level = 1 + floor((now - due_at) / (sla_days*day))` capped at 3; when it increases, event `escalated` with note "Overdue by N days. Escalated to <officer_name or 'the ward officer'>." Priority adds `+10 * escalation_level` (still capped 100).

Repair proof: `POST /api/hazards/:id/repair` (authority/admin), multipart with required `image` (+ optional `note`). Sets `repair_image`, status `resolved`, `resolved_by='contractor'`, event `repaired` with note. Plain `PATCH status=resolved` is still allowed for admins but the event note records "closed without repair photo". After a repair, community votes/clean passes/new sightings behave as today (reopen counts against the contractor).

Serialized hazard gains:
```json
"contractor": { "id": 1, "name": "Shree Infra", "phone": "..." } | null,
"segment": { "id": 3, "tenderId": "DDN/PWD/2025/114", "officerName": "...", "officerContact": "...", "ward": "Ward 12", "slaDays": 7, "warrantyUntil": 1830000000000 } | null,
"dueAt": 1792..., "overdueDays": 0, "escalationLevel": 0, "underWarranty": false,
"repairImageUrl": "http://.../uploads/x.jpg" | null,
"publicUrl": "http://host/h/42"
```

Endpoints (staff = authority/admin):
* `GET /api/contractors` (public) → list with scorecard: `{ id, name, assigned, open, fixed, overdue, avgFixDays, reopenedAfterRepair, onTimeRate }`.
* `POST /api/contractors`, `PATCH /api/contractors/:id` (staff).
* `GET /api/segments` (staff), `POST /api/segments`, `PATCH /api/segments/:id`, `DELETE /api/segments/:id` (staff).
* `POST /api/segments/import` (staff) body `{ "csv": "road_pattern,ward,contractor,officer_name,officer_contact,tender_id,sla_days,warranty_until\n..." }` (contractor by name, created if missing; warranty_until as YYYY-MM-DD). Response `{ imported, contractorsCreated, errors: [] }`. After import, re-run assignment for open unassigned hazards.
* `GET /api/hazards/:id/complaint?lang=en|hi` (public) → `{ subject, body, to: { officerName, officerContact, contractor }, publicUrl }`. Body is a ready-to-send formal complaint: location (road, coordinates, Google Maps link), first reported date, number of drivers, severity, tender ID + contractor + officer if known, warranty clause if under warranty, overdue days if any, photo link, public page link. Hindi version in Devanagari.

## 5. Public hazard page

`GET /h/:id` → server-rendered HTML (no login, mobile friendly, same visual language as the dashboard): photo, severity, status progress (Reported, Verified, Assigned, Fixed), contractor + tender + due/overdue, warranty, repair photo (before/after when present), timeline, "Get the RoadGuard app" line. Escape all user content. 404 page if missing. Open Graph tags (title, description, image) so links unfurl in WhatsApp.

## 6. Road Health Index

`GET /api/stats/roads?limit=50` → `{ success, items: [{ road, healthScore, openHazards, potholes, cracks, worstSeverity, kmScanned30d, lastScannedAt, contractor }] }`.
`healthScore` (100 = perfect): `100 - min(100, sum over open hazards of weight)`, weight = severity_score/100 * (pothole 12, drain_hole 12, crack 5, bump 6, other 4). Roads ordered worst first.

## 7. Dashboard

* New tab **Contractors**: scorecards table (on-time rate, avg fix days, overdue, reopened after repair), segment list with add/edit/delete, CSV import box with template.
* Hazard detail: contractor/tender/officer/due/overdue/escalation/warranty block; "Upload repair photo" (file input) action; "Copy complaint" and "Open public page" buttons; repair photo shown next to the original (before/after).
* Map: toggle **Coverage** layer (cells scanned in last 30 days, faint lane-yellow squares).
* Insights: **Road health** table (worst roads), km scanned.
* Queue items show "Overdue N d" and contractor.

## 8. App (Android)

* Pocket mode (foreground service, `foregroundServiceType="location"`): accelerometer+GPS, BumpDetector (pure Kotlin, tested), batched upload to `/api/sensor-hits`, path to `/api/drives`, voice + vibration warnings from AlertEngine using `/api/hazards/nearby`. Persistent notification with Stop. Start/stop from Home.
* Drive (camera) mode also uploads its path to `/api/drives` at the end.
* Privacy: report photos keep the hazard region sharp and blur the rest.
* Hazard detail shows contractor, tender, officer, due/overdue, warranty, repair photo; "Send complaint" (share sheet with `/complaint` text) and "Share link" (`publicUrl`).
* New kinds `crack`, `bump`. Model labels from RDD ("Longitudinal Crack", "Transverse Crack", "Alligator Crack", "Pothole", or D00/D10/D20/D40) map to: alligator → CRACK (reportable), longitudinal/transverse → not reportable (drawn only), pothole → POTHOLE.
* Profile shows km scanned.
