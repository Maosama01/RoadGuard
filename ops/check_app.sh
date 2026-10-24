#!/bin/bash
# Checks the Android app on this Mac: unit tests, Android lint, debug and release builds.
# With a phone plugged in (USB debugging on), it also installs the release build, opens it,
# and saves a screenshot, the screen layout and any crash logs.
#
#   bash ~/Projects/RoadGuard/ops/check_app.sh          build + test (+ phone smoke test)
#   bash ~/Projects/RoadGuard/ops/check_app.sh logs     only collect crash logs from the phone
#
# Everything lands in ops/reports/ (git ignored), so it can be read back afterwards.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPORTS="$ROOT/ops/reports"
mkdir -p "$REPORTS"
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="$REPORTS/check-$STAMP.log"
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }

ADB="$(command -v adb || true)"
[ -z "$ADB" ] && [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ] && ADB="$HOME/Library/Android/sdk/platform-tools/adb"
phone() { [ -n "$ADB" ] && "$ADB" get-state >/dev/null 2>&1; }

collect_logs() {
  if ! phone; then echo "No phone connected (USB debugging off?)."; return 1; fi
  "$ADB" logcat -d -b crash > "$REPORTS/phone-crashes-$STAMP.txt" 2>&1
  "$ADB" logcat -d -v time 2>/dev/null | grep -E "RoadGuard|AndroidRuntime|com\.roadguard|FATAL|TfLite|CameraX|WM-" | tail -2000 > "$REPORTS/phone-log-$STAMP.txt"
  echo "Saved phone logs to ops/reports/phone-*-$STAMP.txt"
}

if [ "${1:-}" = "logs" ]; then collect_logs; exit $?; fi

if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -qE 'version "(17|21)'; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home -v 17 2>/dev/null || true)"
fi
export JAVA_HOME

TASKS=(:app:testDebugUnitTest :app:lintDebug :app:assembleDebug)
[ -f signing/keystore.properties ] && TASKS+=(:app:assembleRelease)

bold "Building and testing the app (a few minutes)…"
bash ./gradlew --console=plain "${TASKS[@]}" --continue > "$LOG" 2>&1
STATUS=$?
cp -f app/build/reports/lint-results-debug.txt "$REPORTS/lint-$STAMP.txt" 2>/dev/null
# Unit test results in one readable file.
find app/build/test-results/testDebugUnitTest -name '*.xml' -exec cat {} + > "$REPORTS/unit-tests-$STAMP.xml" 2>/dev/null

if [ $STATUS -eq 0 ]; then echo "Build and tests: OK"; else echo "Build or tests FAILED. Details: ops/reports/check-$STAMP.log"; grep -E "^e: |error:|FAILED|Test.*FAILED" "$LOG" | head -20; fi

if phone && [ -f app/build/outputs/apk/release/app-release.apk ]; then
  bold "Phone found: installing the release build and opening it…"
  "$ADB" logcat -c 2>/dev/null
  "$ADB" install -r app/build/outputs/apk/release/app-release.apk >> "$LOG" 2>&1 || echo "Install failed (an older debug build on the phone? Uninstall RoadGuard first)."
  "$ADB" shell monkey -p com.roadguard.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 6
  "$ADB" exec-out screencap -p > "$REPORTS/phone-launch-$STAMP.png" 2>/dev/null
  "$ADB" shell uiautomator dump /sdcard/rg-ui.xml >/dev/null 2>&1 && "$ADB" pull /sdcard/rg-ui.xml "$REPORTS/phone-ui-$STAMP.xml" >/dev/null 2>&1
  collect_logs
fi

bold "Done. Reports are in ops/reports/ (tell Claude \"check done\")."
exit $STATUS
