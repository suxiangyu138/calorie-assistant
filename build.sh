#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK:-/root/android-sdk}"
BT="$SDK/build-tools/35.0.0"
PLATFORM="$SDK/platforms/android-35/android.jar"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
KEYS="$ROOT/keys"
KS="$KEYS/release.jks"
ALIAS="calorie"
STOREPASS="${STORE_PASS:-$(cat "$KEYS/storepass" 2>/dev/null || true)}"
[ -n "$STOREPASS" ] || { echo "缺少签名口令：写进 keys/storepass"; exit 1; }

VERSION="$(grep -oP 'android:versionName="\K[^"]+' "$ROOT/android/AndroidManifest.xml")"
APK_NAME="卡路里小助手-${VERSION}.apk"

run_aapt2() { qemu-x86_64-static "$BT/aapt2" "$@"; }
run_zipalign() { qemu-x86_64-static "$BT/zipalign" "$@"; }

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$BUILD/assets" "$DIST"

cp -r "$ROOT/www" "$BUILD/assets/www"

run_aapt2 compile --dir "$ROOT/android/res" -o "$BUILD/res.zip"
run_aapt2 link -o "$BUILD/unsigned.apk" -I "$PLATFORM" \
  --manifest "$ROOT/android/AndroidManifest.xml" \
  -A "$BUILD/assets" -R "$BUILD/res.zip" --java "$BUILD/gen" --auto-add-overlay

if ! javac -encoding UTF-8 --release 11 -classpath "$PLATFORM" \
  -d "$BUILD/classes" \
  $(find "$ROOT/android/src" -name '*.java') $(find "$BUILD/gen" -name '*.java') > "$BUILD/javac.log" 2>&1; then
  cat "$BUILD/javac.log"
  exit 1
fi

"$BT/d8" --min-api 26 --lib "$PLATFORM" --output "$BUILD/dex" $(find "$BUILD/classes" -name '*.class')

python3 - "$BUILD/unsigned.apk" "$BUILD/dex/classes.dex" <<'PY'
import shutil, sys, zipfile
src, dex = sys.argv[1], sys.argv[2]
shutil.copy(src, src + '.tmp')
with zipfile.ZipFile(src + '.tmp', 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
shutil.move(src + '.tmp', src)
PY

run_zipalign -p -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

mkdir -p "$KEYS"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias "$ALIAS" -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -dname "CN=Calorie Assistant, OU=Personal, O=Personal, L=Hefei, ST=Anhui, C=CN"
fi

"$BT/apksigner" sign --ks "$KS" --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$STOREPASS" --key-pass "pass:$STOREPASS" \
  --out "$DIST/$APK_NAME" "$BUILD/aligned.apk"

cp "$DIST/$APK_NAME" "$DIST/卡路里小助手.apk"
"$BT/apksigner" verify "$DIST/$APK_NAME"

echo "APK: $DIST/$APK_NAME"
