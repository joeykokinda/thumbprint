#!/bin/sh
# Records the Chrome monitor and the phone screen at the same time: ./record.sh name   (Enter stops; phone clips cap at 3 minutes)
set -e
cd "$(dirname "$0")/footage"
name=${1:?name}
adb shell screenrecord --bit-rate 12000000 /sdcard/live.mp4 &
wf-recorder -y -o "${OUTPUT:-DP-7}" -r 30 -f "live-$name-screen.mp4" >/dev/null 2>&1 &
screen=$!
date +%s.%N > "live-$name.start"
echo "recording $name: touch footage/stop to stop"; rm -f stop; while [ ! -e stop ]; do sleep 0.3; done; rm -f stop
kill -INT $screen; adb shell pkill -INT screenrecord || true; wait 2>/dev/null || true
sleep 2; adb pull /sdcard/live.mp4 "live-$name-phone.mp4" >/dev/null; adb shell rm /sdcard/live.mp4
ls -la live-$name-*
