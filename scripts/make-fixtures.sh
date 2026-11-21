#!/usr/bin/env bash
# Rebuilds the tiny consent-clip fixtures in tests/fixtures/ with ffmpeg.
# Run from the app folder:  bash scripts/make-fixtures.sh
# No real person is in these clips: they are flat colour with a test tone.
# The face check reads the matching *.vision.json sidecar in mock mode.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=tests/fixtures
FFMPEG=${FFMPEG:-ffmpeg}

# GOOD: 16 s (HeyGen needs 15 s or more), 1080x1920, 30 fps, bright, steady
# speech-like tone with no long gaps. Static picture keeps the file tiny.
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0xD8B49A:s=1080x1920:r=30:d=16" \
  -f lavfi -i "aevalsrc=0.35*sin(2*PI*220*t)*(0.65+0.35*sin(2*PI*3*t)):s=16000:d=16" \
  -c:v libx264 -preset veryslow -crf 45 -pix_fmt yuv420p -g 300 \
  -c:a aac -b:a 24k -ac 1 -shortest -movflags +faststart \
  "$OUT/consent-good.mp4"

# BAD: 8 s (too short), 720x1280 (too small), 24 fps (too few), dark,
# 5 s of silence in the middle. Its sidecar says two faces.
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x141414:s=720x1280:r=24:d=8" \
  -f lavfi -i "aevalsrc=if(between(t\,1.5\,6.5)\,0\,0.3*sin(2*PI*220*t)):s=16000:d=8" \
  -c:v libx264 -preset veryslow -crf 45 -pix_fmt yuv420p -g 200 \
  -c:a aac -b:a 24k -ac 1 -shortest -movflags +faststart \
  "$OUT/consent-bad.mp4"

# GOOD as .mov (decision 5: iPhone-style QuickTime file, converted to mp4 by
# the clip task). Same streams as consent-good.mp4, only the container
# changes, so it stays under 200 KB and uses the same vision sidecar.
"$FFMPEG" -hide_banner -loglevel error -y -i "$OUT/consent-good.mp4" -c copy -f mov "$OUT/consent-good.mov"

# CORRUPT .mov: plain text with a .mov name. ffmpeg cannot read it, so the
# clip task must give the "switch to Most Compatible" tip.
yes "this is not a video" | head -c 8192 > "$OUT/consent-corrupt.mov" || true

ls -l "$OUT"/consent-*.mp4 "$OUT"/consent-*.mov
