#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -d /usr/lib/jvm/java-21-openjdk ]; then
  export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
fi
# Pin Google's maintained verifier; never implement certificate validation in the app.
REV=c391708adccdeff0ac12f51e81cebfe5de42a017
if [ ! -d build/upstream/.git ]; then
  mkdir -p build
  git clone https://github.com/android/keyattestation.git build/upstream
fi
git -C build/upstream checkout --detach "$REV"
cp Verify.kt build/upstream/src/main/kotlin/ThumbprintVerify.kt
cat > build/application.gradle <<'EOF'
allprojects {
    apply plugin: 'application'
    application { mainClass = 'org.pyras.thumbprint.ThumbprintVerifyKt' }
}
EOF
cd build/upstream
./gradlew --no-daemon -I ../application.gradle installDist
