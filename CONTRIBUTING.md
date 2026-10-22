# Working on RoadGuard

## First-time setup

1. **Clone:** `git clone https://github.com/Maosama01/RoadGuard.git`
2. **App:** open the folder in Android Studio and let it sync. If it complains about the Gradle JDK, choose
   *Settings > Build Tools > Gradle > Gradle JDK > JDK 21* (Gradle 8.11 doesn't run on Java 25).
3. **Backend:** `cd backend && npm install && npm run seed && npm start`. With no `.env` it runs on
   port 5000 with demo data; on a Mac use `PORT=5050` (AirPlay takes 5000).
4. **Model:** the trained detector is already in `app/src/main/assets/`. Retraining is in `ml/README.md`.

The live server (`backend/.env`) and the release signing key (`signing/`) are **never in git**.
Get them from Vayam directly if you need them.

## Day to day

* Make a branch for each change: `git switch -c fix/drive-summary`.
* Push it and open a pull request into `main`. CI runs the backend tests, the app's core tests and a full
  app build on every pull request; merge when it's green. The debug APK of each run is under *Artifacts*.
* Keep `main` working: it's what gets built and handed to drivers.

## Useful commands

| What | Command |
|---|---|
| Backend tests | `cd backend && npm test` |
| App core tests | `./gradlew :app:testDebugUnitTest` |
| Signed release APK | `bash ops/build_release.sh` (needs `signing/`) |
| Live server from a Mac | `bash ops/go_live_mac.sh` (start), `... status`, `... stop` |
| Point a debug build at a backend on your Wi-Fi | add `roadguard.useLanServer=true` to `~/.gradle/gradle.properties` (your machine only) |
