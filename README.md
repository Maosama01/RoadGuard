# RoadGuard

Your phone, mounted on the dashboard, spots potholes while you drive. The city sees every one of them, merged and ranked by what to fix first.

There are two sides to it:

* **The Android app** (`app/`) is for drivers. It detects potholes and road cracks with an on-device YOLO model trained on 7,706 photos of Indian roads (RDD2020), confirms them with the accelerometer, tags them with GPS and reports them. It also warns you out loud about potholes other drivers already found. No mount? **Pocket mode** feels potholes with the accelerometer and GPS alone, with the phone in a pocket or a holder.
* **The backend** (`backend/`) is a Node.js API plus the **RoadGuard Control** web dashboard for city road teams: a fix queue, a map, crew assignment, contractor accountability, history and insights. Every hazard also gets a public page anyone can share.

---

## Run it in 5 minutes

### 1. Start the backend (on your laptop)

Requires Node.js 20 or newer.

```bash
cd backend
npm install
cp .env.example .env      # then set JWT_SECRET and the admin email/password
npm run seed              # optional: demo data around Dehradun
npm start
```

The terminal prints two addresses:

```
Dashboard:  http://localhost:5000/admin/
App server: http://192.168.1.20:5000/   <- put this in the app's Settings
```

Sign in to the dashboard with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. If you ran the seed, `admin@demo.roadguard` / `roadguard123` also works.

### 2. Run the app

1. Open the project folder in Android Studio and let Gradle sync. Room now uses KSP, so the first sync downloads it.
2. Run the app on a real phone (the emulator has no useful camera or accelerometer).
3. On the first screen, tap **Server: … (tap to change)** at the bottom and enter the **App server** address from step 1. The phone and laptop must be on the same Wi-Fi.
4. Tap **Start scanning**. No account is needed; guests can create one later and keep their points.

The default server address is `http://10.0.2.2:5000/`, which is your computer as seen from the Android emulator. You can change it in `app/build.gradle.kts`.

---

## How detection works

```
camera frame ─► YOLO (on the phone) ─► candidate pothole ─┐
accelerometer ─► jolt ───────────────────────────────────►├─► DetectionFusion ─► saved on phone ─► uploaded
GPS ─► position, speed, heading ─────────────────────────┘
```

* **The model and its thresholds travel together.** The bundled `best.tflite` (RoadGuard v3, YOLO11n at 512 px) was trained on the RDD2020 India dataset. Class names are read from the model file itself, and confidence thresholds from `assets/model_config.json`, which is calibrated on the validation split. On 800 held-out Indian road photos it finds 3.3x more potholes than the original model, for the same number of false alarms, and runs about 4x faster. The full benchmark is in `ml/RESULTS.md`.
* **What it reports:** *Pothole* is reported. *Alligator Crack*, the fatigue cracking that comes before a pothole, is reported as a cracked surface, with severity capped at medium. *Longitudinal* and *Transverse Crack* are only drawn, faintly. Older models with *Drain Hole* and *Sewer Cover* classes still work: drains are reported, sewer covers never are.
* **A sighting must be seen in at least 2 frames**, or once with 75%+ confidence. This removes most single-frame false positives.
* **The jolt can come after the sighting.** The camera sees a pothole 1 to 3 seconds before the wheels hit it, so a candidate waits up to 2.5 s for the jolt. If the driver steers around it, it is still reported when the model is confident enough (the model's `reportThreshold`). Settings has a "bump only" mode.
* **Severity (0 to 100)** combines model confidence, the pothole's size in frame, jolt strength and speed. The thresholds (40/60/80) are shared with the backend.
* **Save first, send later.** Reports go into a local Room database and a WorkManager job uploads them with retries, so dead zones lose nothing. Each report carries a unique id, so retries never create duplicates.
* **Privacy:** report photos keep only the hazard sharp (the detection box grown 1.6x, or the road just ahead for a manual report). Everything else is blurred on the phone before it is saved, so faces and number plates never leave it.
* **Coverage:** every drive's route (one point per ~40 m, at most 2000) is saved and sent to `/api/drives` when the drive ends, so "no reports" can be told apart from "nobody checked".

### While you drive

* **Spoken warnings:** "Pothole ahead, 120 metres" for hazards other drivers reported. Warnings only fire for hazards ahead of you, and the look-ahead distance grows with speed.
* **Clean passes:** driving straight over a known pothole without a jolt is quiet evidence it was fixed. After 5 such passes the dashboard flags it **Likely fixed**.

### Pocket mode

Start it from the Home screen. It runs as a foreground service with a notification (tap Stop there or in the app), keeps working with the screen off, and needs precise location.

* **BumpDetector** (`core/`, unit-tested) tracks gravity with a slow filter and measures the jolt along it, so the phone's orientation doesn't matter. A jolt counts when it is short (under 0.4 s), the car is doing at least 15 km/h, it stands out from the road's usual roughness, and it isn't mostly sideways (the phone being picked up). The rear wheels hitting the same pothole within 1.5 s count once. The threshold follows the bump sensitivity in Settings.
* **Jolts are saved on the phone** and sent in batches to `/api/sensor-hits`. One jolt proves little, so the server either adds it to a known hazard there or waits until 3 drivers feel the same spot.
* **Warnings work like a camera drive:** voice and vibration for hazards ahead, and clean passes.
* Starting a camera drive stops pocket mode, so you are never warned twice.

### Who fixes it

A hazard's page shows the contractor, tender, ward and officer responsible when the city has mapped that road, with the deadline (or how many days it is overdue and who it was escalated to), whether it is under warranty, and the before/after photos once repaired. **Send complaint** fetches a ready-to-send formal complaint (in Hindi on a Hindi phone) and opens the share sheet; **Share link** shares the public hazard page.

## How the backend thinks

* **One pothole, many sightings.** Sightings of the same type within 15 m merge into one hazard. Its position is accuracy-weighted and its severity is the mean of the three worst sightings.
* **Lifecycle:** Reported, then Verified (automatically, once 3 different drivers report it), then Assigned, then Crew working, then Fixed. A hazard that is spotted again after being fixed **reopens** and is counted, so bad repairs show up.
* **Community closing:** 3 drivers tapping "It's fixed" closes a hazard. One driver tapping "It's back" reopens it.
* **Priority (0 to 100)** = severity + how many drivers hit it + traffic speed there + how long it has waited. Old potholes rise up the queue on their own.
* **Points and levels** (Scout, Spotter, Ranger, Guardian, Road Legend). The driver who found a hazard first earns a bonus when it gets fixed.
* **Hazard types:** pothole, open drain, sewer cover, cracked surface (`crack`, seen by the camera, usually the start of a pothole), rough patch (`bump`, felt in pocket mode only) and other.

### Pocket mode and coverage

* **Pocket mode** sends jolts (accelerometer + GPS, no photo) to `/api/sensor-hits`. One jolt can be a speed breaker or a door slam, so a jolt within 15 m of a known hazard only **confirms** it (and can reopen a fixed one, like a camera sighting). Anywhere else, the jolt waits until **3 different drivers** have felt the same spot within 30 days; then it becomes a "Rough patch". Jolts near a hazard the city **rejected** are absorbed silently, so a speed breaker never comes back. Hits slower than 10 km/h, less accurate than 30 m or older than 14 days are ignored.
* **Coverage:** every drive uploads its path. The map is split into ~110 m cells, and the dashboard's **Coverage** layer shows which cells someone actually drove in the last 30 days. "No reports" on a road that nobody drove means "not checked", not "fine".

### Accountability

* **Roads have owners.** On the Contractors tab, map each road (by name, optionally limited to an area) to its contractor, tender ID, supervising officer, deadline in days (SLA) and warranty end date. Import the list from a spreadsheet (CSV) in one go.
* **Automatic routing.** When a hazard is verified, or rated high or critical, it is sent to the contractor for its road with a due date (critical: half the time). If the road is under warranty, the record says the repair is at no cost.
* **Escalation.** Past the due date the hazard escalates to the officer (level 1, then one level per further SLA period, up to 3), it rises in the queue, and the history records it.
* **Repair proof.** The contractor's after photo closes the hazard and shows next to the drivers' before photo. Closing without a photo is allowed but recorded. If drivers find it again, it reopens and counts against the contractor.
* **Scorecards** per contractor: assigned, open, overdue, fixed, average days to fix, on-time rate and repairs that came back.
* **Complaint in 4 seconds.** Every hazard has a ready-to-send formal complaint in English or Hindi with the location, tender, contractor, officer, warranty and overdue days, plus a **public page** (`/h/<id>`) with photos, progress, who is responsible and the full history. Links unfurl in WhatsApp.
* **Road Health Index** (100 = clean road) ranks roads worst first, with km scanned in the last 30 days, so resurfacing goes where it is needed.

---

## API

All JSON. Authenticate with `Authorization: Bearer <token>`.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/auth/guest` | anyone | One account per device, zero friction |
| POST | `/api/auth/register` | anyone | With a guest token, upgrades that guest in place |
| POST | `/api/auth/login` | anyone | |
| GET/PATCH | `/api/auth/me` | signed in | |
| POST | `/api/reports` | signed in | Multipart (`image` + fields) or JSON; idempotent on `clientId` |
| GET | `/api/reports/mine` | signed in | Your reports with live hazard status |
| GET | `/api/hazards` | anyone | Filters: `status` (`open`, `all`, comma list), `severity`, `type`, `bbox`, `q`, `sort`, `contractor`, `overdue=1`, `warranty=1` |
| GET | `/api/hazards/nearby?lat&lng&radius` | anyone | Open hazards nearest first (in-car warnings) |
| GET | `/api/hazards/heatmap` | anyone | `[lat, lng, weight]` points |
| GET | `/api/hazards/:id` | anyone | Hazard (with `contractor`, `segment`, `dueAt`, `overdueDays`, `escalationLevel`, `underWarranty`, `repairImageUrl`, `publicUrl`), sightings, history |
| POST | `/api/hazards/:id/vote` | signed in | `present`, `fixed` or `pass` |
| PATCH | `/api/hazards/:id` | city team | `status`, `assignedTeam`, `note` |
| POST | `/api/hazards/:id/repair` | city team | Multipart with required `image` (+ `note`): repair proof, closes the hazard |
| GET | `/api/hazards/:id/complaint?lang=en\|hi` | anyone | `{ subject, body, to: { officerName, officerContact, contractor }, publicUrl }` |
| GET | `/api/hazards/export.csv` | city team | Same filters as the list |
| POST | `/api/sensor-hits` | signed in | Pocket mode: `{ hits: [...] }` (max 200), idempotent on `clientId`. Answers `accepted`, `ignored`, `confirmed`, `promoted`, `pointsAwarded` |
| POST | `/api/drives` | signed in | Drive path for coverage, idempotent on `clientId`. Answers `cells`, `distanceMeters` |
| GET | `/api/coverage?bbox&days=30` | anyone | Scanned cells `{ lat, lng, scans, lastScannedAt }` |
| GET | `/api/contractors` | anyone | Contractors with scorecards |
| POST/PATCH | `/api/contractors[/:id]` | city team | `name`, `phone`, `email` |
| GET/POST/PATCH/DELETE | `/api/segments[/:id]` | city team | Road to contractor, tender, officer, SLA, warranty, optional area |
| POST | `/api/segments/import` | city team | `{ csv }`; template at `/api/segments/template.csv` |
| GET | `/api/stats/overview` | anyone | City numbers, 14 to 90 day trend, `kmScanned30d`, overdue count |
| GET | `/api/stats/me` | signed in | Your impact, level, rank, `kmScanned` and `drives` |
| GET | `/api/stats/roads?limit=50` | anyone | Road Health Index, worst first |
| GET | `/api/stats/leaderboard` | anyone | |
| GET/PATCH | `/api/stats/users[/:id]` | admin | Manage city team access |
| GET | `/h/:id` | anyone | Public hazard page (HTML, shareable) |

Run the tests with `cd backend && npm test`. Data lives in `backend/data/`: an SQLite file plus uploaded photos. Older database files are upgraded in place on start.

Create more staff accounts with `npm run create-admin -- email@city.gov "password" "Name" authority`.

---

## Project layout

```
app/src/main/java/com/roadguard/app/
  core/          Pure Kotlin logic, unit-tested: DetectionFusion, AlertEngine, BumpDetector,
                 PathRecorder, GeoUtils, HazardKind
  ml/            YOLODetector (reads layout + class names from the model), Labels, ModelConfig (thresholds)
  camera/        FrameAnalyzer (frame -> detector -> fusion, keeps the best photo)
  scan/          HazardAlerts (spoken warnings, shared by both modes), DriveLog (route for coverage)
  service/       PocketScanService (pocket mode foreground service)
  data/          Session, Settings, ReportQueue, UploadWorker, SensorQueue, SensorUploadWorker, api/ (Retrofit)
  database/      Room offline queue: reports, pocket mode jolts, drive routes
  activities/    Splash, Login, Home (tabs), Drive, HazardDetail, Settings
  fragments/     Home, Map (OpenStreetMap, no API key), Reports, Profile
backend/
  src/           Express app, hazard intelligence (hazards.js), pocket mode (sensors.js), coverage and
                 road health (coverage.js), contractors, deadlines and complaints (accountability.js),
                 public hazard page (publicPage.js), routes
  public/admin/  RoadGuard Control dashboard (no build step; Leaflet + fonts served locally)
  public/site/   Styles for the public hazard pages
  test/          API tests (node --test)
  Dockerfile, docker-compose.yml, Caddyfile, DEPLOY.md   HTTPS deployment
ml/              Verified Indian road dataset, training, benchmark (see ml/README.md)
```

## Before a public launch

* **Serve the backend over HTTPS** (see `backend/DEPLOY.md`: Docker + Caddy with automatic certificates) and turn off cleartext in `app/src/main/res/xml/network_security_config.xml`. Plain HTTP is only allowed now so a laptop on the same Wi-Fi works.
* **Finish training the detector on a GPU.** The app now ships v4 (60 epochs on the Mac GPU, test AP50 0.417). Running `bash ml/train_mac.sh` on an Apple Silicon Mac continues it, benchmarks it against the shipped model, and installs it with freshly calibrated thresholds only if it scores higher. See `ml/RESULTS.md`.
* **Hosting:** move from SQLite to Postgres + PostGIS when several cities share one server.
