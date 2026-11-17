#!/bin/sh
# Builds site/thumbprint.apk with the SDK tools alone: one activity, no dependencies, no Gradle.
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
TOOLS="$SDK/build-tools/35.0.0"
PLATFORM="$SDK/platforms/android-35/android.jar"
KEYSTORE="${KEYSTORE:-$HOME/.config/thumbprint/android.keystore}"
rm -rf build && mkdir -p build/classes build/dex
[ -f "$KEYSTORE" ] || keytool -genkeypair -keystore "$KEYSTORE" -storepass thumbprint -alias thumbprint -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Thumbprint"
python3 - <<'PY' > build/BuildConfig.java
import json, os
from urllib.parse import urlparse
origin = os.environ.get("THUMBPRINT_ORIGIN", "https://thumbprint.pyras.org")
url = urlparse(origin)
debug = url.hostname in ("localhost", "127.0.0.1")
assert url.scheme == "https" or (debug and url.scheme == "http")
assert not url.username and not url.password and not url.query and not url.fragment and url.path in ("", "/")
manifest = open("AndroidManifest.xml").read()
if debug:
    manifest = manifest.replace('<application ', '<application android:usesCleartextTraffic="true" ')
open("build/AndroidManifest.xml", "w").write(manifest)
print("package org.pyras.thumbprint; final class BuildConfig { static final String ORIGIN = " + json.dumps(origin.rstrip('/')) + "; static final boolean DEBUG = " + str(debug).lower() + "; }")
PY
# The X tab runs the browser extension's own content script, with x.js standing in for its worker.
mkdir build/assets
bun build ../extension/verify.ts --target browser --minify --outfile ../extension/verify.js
{ echo '(() => {'; cat ../extension/verify.js x.js ../extension/shared.js ../extension/content.js; echo '})();'; } > build/assets/inject.js
node --check build/assets/inject.js
cp ../extension/content.css build/assets/
"$TOOLS/aapt2" compile --dir res -o build/res.zip
"$TOOLS/aapt2" link -o build/unsigned.apk -I "$PLATFORM" --manifest build/AndroidManifest.xml -A build/assets build/res.zip
javac -Xlint:-options --release 17 -cp "$PLATFORM" -d build/classes src/org/pyras/thumbprint/*.java build/BuildConfig.java
"$TOOLS/d8" --lib "$PLATFORM" --min-api 33 --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$TOOLS/zipalign" -f 4 build/unsigned.apk build/aligned.apk
"$TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:thumbprint --out ../site/thumbprint.apk build/aligned.apk
rm -f ../site/thumbprint.apk.idsig
