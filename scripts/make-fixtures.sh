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

# ---------------------------------------------------------------------------
# Phase 4 part B: mock B-roll clips and music beds. Everything below is made
# here from ffmpeg's built-in lavfi sources (flat colours, boxes, sine and
# triangle tones): no download, no stock footage, no real music, so the files
# are ours (CC0). The catalogue JSON files next to them are written by hand.
# ---------------------------------------------------------------------------
mkdir -p "$OUT/music"

# B-roll clips (moving white box on a flat colour): their own script since p5-b1.
FFMPEG="$FFMPEG" bash scripts/make-broll-fixtures.sh

# Music beds: gentle chords (3 tones each), one chord per section with a
# soft swell that starts and ends at silence, so the bed loops without a
# click. Normalised to about -14 LUFS (the level the real set must have too;
# the editor turns music down by MUSIC.bed_gain_db from there). Mono AAC.
# chord <a> <b> <c> <d>: one frequency per section, chosen by the time.
chord4() { # section length, then 4 frequencies
  local s=$1
  echo "if(lt(mod(t\\,4*$s)\\,$s)\\,$2\\,if(lt(mod(t\\,4*$s)\\,2*$s)\\,$3\\,if(lt(mod(t\\,4*$s)\\,3*$s)\\,$4\\,$5)))"
}
bed() { # <name> <seconds> <expression>
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "aevalsrc=$3:s=48000:d=$2" \
    -af "loudnorm=I=-14:TP=-2:LRA=11,aresample=48000" \
    -c:a aac -b:a 32k -ac 1 -movflags +faststart \
    "$OUT/music/$1.m4a"
}
# calm: C - Am - F - G, sine tones, 6 s a chord (24 s).
S=6
CALM="0.2*sin(PI*mod(t\\,$S)/$S)*(sin(2*PI*$(chord4 $S 261.63 220 174.61 196)*t)+sin(2*PI*$(chord4 $S 329.63 261.63 220 246.94)*t)+sin(2*PI*$(chord4 $S 392 329.63 261.63 293.66)*t))"
bed bed-calm 24 "$CALM"
# bright: D - G - A - G, triangle tones (asin(sin(x)) shape), 5 s a chord (20 s).
S=5
tri() { echo "asin(sin(2*PI*$1*t))*2/PI"; }
BRIGHT="0.18*sin(PI*mod(t\\,$S)/$S)*($(tri "$(chord4 $S 293.66 196 220 196)")+$(tri "$(chord4 $S 369.99 246.94 277.18 246.94)")+$(tri "$(chord4 $S 440 293.66 329.63 293.66)"))"
bed bed-bright 20 "$BRIGHT"
# soft: A - F#m - D - E, low sine tones, 7.5 s a chord (30 s).
S=7.5
SOFT="0.2*sin(PI*mod(t\\,$S)/$S)*(sin(2*PI*$(chord4 $S 110 92.5 73.42 82.41)*t)+sin(2*PI*$(chord4 $S 220 185 146.83 164.81)*t)+sin(2*PI*$(chord4 $S 277.18 220 220 207.65)*t))"
bed bed-soft 30 "$SOFT"

ls -l "$OUT"/broll/*.mp4 "$OUT"/music/*.m4a
du -ch "$OUT"/broll/*.mp4 "$OUT"/music/*.m4a | tail -1
