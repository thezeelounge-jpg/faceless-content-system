#!/usr/bin/env bash
# Rebuilds the mock B-roll clips in tests/fixtures/broll/ with ffmpeg (MOCK_PEXELS).
# Run from the app folder:  npm run fixtures:broll   (npm run fixtures runs it too)
# Made from ffmpeg's built-in lavfi sources (a flat colour and one white box): no
# download, no stock footage, so the files are ours (CC0). catalogue.json next to
# them is written by hand.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=tests/fixtures
FFMPEG=${FFMPEG:-ffmpeg}
mkdir -p "$OUT/broll"

# B-roll: <name> <colour> <size> <seconds> <box x> <box y> <direction>. A flat
# colour with one white box (a different place per clip), portrait, no sound.
# Sizes are deliberately mixed (smaller than 1080x1920, and one odd ratio) so
# the editor's scale + crop is exercised. The centre is always the flat colour,
# which the integration test samples.
# p5-b1 (Rowan 2): the box MOVES (bounces up and down by a tenth of the height,
# a full sweep every 0.3 s, away from the centre: <direction> 1 = down for the
# top boxes, -1 = up for the bottom ones), so Gate 4's freezedetect never sees
# a frozen b-roll cut (tests/integration/broll-fixtures-motion.test.ts). Real
# stock clips move too.
# (drawbox evaluates its position once, so the box is a second colour source
# laid on with overlay, whose x/y are evaluated every frame.)
broll() {
  local w=${3%x*} h=${3#*x}
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=$2:s=$3:r=30:d=$4" \
    -f lavfi -i "color=c=white:s=$((w / 5))x$((h / 8)):r=30:d=$4" \
    -filter_complex "[0:v][1:v]overlay=x=$5:y='$6+($7)*(H/10)*abs(mod(t\\,0.6)/0.3-1)':shortest=1,format=yuv420p" \
    -c:v libx264 -preset veryslow -crf 40 -pix_fmt yuv420p -g 300 -an -movflags +faststart \
    "$OUT/broll/$1.mp4"
}
broll cafe-green    0x1E8C3A 720x1280  3.5 W/10   H/10   1
broll cafe-blue     0x1F4FD8 1080x1920 3.2 W*7/10 H/10   1
broll phone-magenta 0xC2187A 540x960   4   W/10   H*8/10 -1
broll city-orange   0xE8730C 640x1136  3   W*7/10 H*8/10 -1

ls -l "$OUT"/broll/*.mp4
du -ch "$OUT"/broll/*.mp4 | tail -1
