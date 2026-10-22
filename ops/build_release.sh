#!/bin/bash
# Builds the signed release APK of RoadGuard, ready to share with drivers.
#
#   bash ~/Projects/RoadGuard/ops/build_release.sh
#
# Output: release/RoadGuard-<version>.apk (git ignored). If a phone is connected with USB
# debugging on, it's installed on it too.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
die() { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

[ -f signing/keystore.properties ] || die "No signing key in signing/. Ask whoever set up the project for the signing folder (never via git)."

# Gradle 8.11 runs on Java 17 to 23. Android Studio installed a JDK 21; use it.
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -qE 'version "(17|21)'; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home -v 17 2>/dev/null || true)"
fi
[ -n "$JAVA_HOME" ] || die "No Java 17 or 21 found. In Android Studio: Settings > Build Tools > Gradle > Gradle JDK > Download JDK 21, then run this again."
export JAVA_HOME

SERVER=$(grep -E '^roadguard.serverUrl=' gradle.properties | cut -d= -f2- || true)
if [ -z "$SERVER" ]; then
  echo "Warning: no public server set, so this APK points at the emulator address."
  echo "Run ops/go_live_mac.sh first for an APK that works on real phones."
else
  echo "This APK talks to: $SERVER"
fi

echo "Running the core tests and building (the first time takes a few minutes)…"
bash ./gradlew --quiet :app:testDebugUnitTest :app:assembleRelease

VERSION=$(grep -E 'versionName *=' app/build.gradle.kts | head -1 | sed -E 's/.*"(.*)".*/\1/')
mkdir -p release
OUT="release/RoadGuard-$VERSION.apk"
cp app/build/outputs/apk/release/app-release.apk "$OUT"
echo
echo "Built: $ROOT/$OUT ($(du -h "$OUT" | cut -f1))"

ADB="$(command -v adb || true)"
[ -z "$ADB" ] && [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ] && ADB="$HOME/Library/Android/sdk/platform-tools/adb"
if [ -n "$ADB" ] && "$ADB" get-state >/dev/null 2>&1; then
  echo "Installing on the connected phone…"
  if ! "$ADB" install -r "$OUT"; then
    echo
    echo "The phone has a version signed with Android Studio's debug key, and Android won't replace it."
    echo "Uninstall RoadGuard on the phone (reports still waiting to send on it will be lost), then run this again."
  fi
fi
echo
echo "To give it to a driver: send the APK on WhatsApp or Google Drive. On their phone, opening it asks"
echo "to allow installing apps from that source once. Every APK from this script installs over the last."
