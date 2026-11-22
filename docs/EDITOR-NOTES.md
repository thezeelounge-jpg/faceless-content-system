# Editor notes (Phase 4)

How the editor turns a raw HeyGen MP4 into a finished 9:16 reel. Part A = scale/crop, fps, word-by-word captions. Part B (p4-b2) = b-roll, music + loudness, the AI label, the trial watermark and `+faststart`. p4-b3 = QA follow-ups (run-scoped final files, unplaceable b-roll → team, centre trial mark, dark label/tag boxes, the loudness regression). All of it runs in mock mode today (MOCK_STT, MOCK_PEXELS, fixture music).

## Files

| File | What it does |
|---|---|
| `lib/stt.ts` | Speech-to-text interface (`SttProvider`, `Transcript` zod schema). Only the mock exists. |
| `lib/captions.ts` | Aligns display_text with the transcript, makes caption pages, writes the `.ass` file. Styles and safe zone live here. |
| `lib/edit.ts` | Pure ffmpeg argv builder + filtergraph escaping: b-roll overlays, label, watermark, audio graph, `+faststart`, loudness pass 1 args, the publish-guard check `notYetApplied(extras, args)`. |
| `lib/broll.ts` | `BrollProvider` (mock only, `MOCK_PEXELS`) + `planBroll` (pure: where the cut-ins go). |
| `lib/music.ts` | The music set (fixture beds for now), the ducking chain, loudnorm pass 1 / pass 2 filters, the pass-1 JSON parser. |
| `lib/edit-flow.ts` | The job: download → transcript → captions → length (ffprobe) → b-roll plan + clips → music bed → loudness pass 1 → final ffmpeg → upload; plain errors on the row. |
| `lib/edit-store.ts` | Supabase store/storage for the job (secret key, task only). Storage calls have a timeout + bounded retry (p4-b1). |
| `trigger/edit-video.ts` | `schemaTask` `edit-video`, `large-1x` (4 vCPU / 8 GB), maxDuration `EDIT.task_max_duration_s` (1800 s), 2 attempts. |
| `assets/fonts/` | Anton + Poppins `.ttf` only (SIL OFL 1.1). Licences + README in `assets/fonts/licenses/`. All copied into the Trigger build by `additionalFiles` (`./assets/fonts/**`). |
| `tests/integration/edit-ffmpeg.test.ts` | Real local ffmpeg run, checked with ffprobe (part of `npm test`). |
| `tests/integration/edit-extras-ffmpeg.test.ts` | p4-b2: the whole job with real ffmpeg/ffprobe (`tests/helpers/edit-real.ts`), output measured: loudness, true peak, moov first, b-roll/face pixels, stems, label/watermark (about 9 s). |
| `tests/fixtures/broll/`, `tests/fixtures/music/` | The mock b-roll clips + catalogue and the mock music beds (made by `npm run fixtures`, ours, CC0). |
| `scripts/p4-artifacts.ts` | `npm run p4:artifacts`: before/after files into `../logs/p4-artifacts/` (by hand only; the folder is emptied first). |

## Speech-to-text interface

```ts
type Transcript = { language: string; duration_s: number;
  words: { text: string; start_s: number; end_s: number; confidence?: number }[] };
interface SttProvider { transcribe(input: { audioPath: string; language?: "en" | "ur" | "hi" }): Promise<Transcript> }
getSttProvider() // mock when MOCK_STT is not exactly "false"; otherwise "No speech-to-text provider is set up yet."
```

- Mock answer: `tests/fixtures/stt/sample-transcript.json` (19 words, 6 s), matching `tests/fixtures/stt/sample-script.json`. It deliberately looks like real STT output: lowercase, no punctuation, "three" for "3", "whats app" split, an extra "um", the word "a" missed.
- Adding the real provider (after Rowan picks one): a new `SttProvider` in `lib/stt.ts` returning the same shape. Callers don't change. It must have a timeout, retries, and must not be called in tests.
- The edit job takes the transcript from the payload, else `videos.transcript` (Gate 3 saves it in Phase 5), else calls speech-to-text and saves the result to `videos.transcript`.

## Alignment (`alignWords`)

TEXT comes from display_text (brand spelling, punctuation). TIMINGS come from speech-to-text.

- Words are compared in a normal form: lowercase, accents and punctuation removed, whole numbers 0–20 spelled out ("3" = "three").
- Edit-distance alignment (dynamic programming): same word = 0, different word = 1 (takes the misheard word's time, e.g. "Rowan"/"rohan"), missing or extra word = 1. One display word heard as 2–3 words ("WhatsApp" → "whats app") or 2–3 display words heard as one ("can not" → "cannot") cost 0 when the letters join up exactly.
- Display words nobody said get times between their neighbours, shared out by length. A punctuation-only token ("—") sticks to the word before it.
- Matched words keep the exact STT times, so they meet the Gate 4 rule (within 150 ms).

## Pages and styles

- A page holds at most 2 lines. A new page starts after `.`, `!` or `?`, at a pause of 0.5 s or more, or when the style's word limit is reached. A page stays up 0.3 s after its last word, unless the next page starts sooner.
- `.ass` uses `WrapStyle: 2` (libass never wraps by itself; our `\N` breaks are the only ones), `PlayResX/Y` = 1080x1920, `ScaledBorderAndShadow: yes`.
- A single word too long for a line is scaled down with `\fscx`/`\fscy` so it still fits.

| Style | Font (file) | Size | Look | Line / page limit |
|---|---|---|---|---|
| `big_words` (default) | Anton (`Anton-Regular.ttf`), UPPERCASE | 104 | white, 8 px black outline + 3 px shadow; the key word in the brand colour | 14 chars and 1-3 words a line, 2 lines (6 words) a page |
| `small_box` | Poppins Bold (`Poppins-Bold.ttf`) | 60 | white on an opaque near-black box (BorderStyle 3, 14 px padding) | 20 chars, 10 words |
| `minimal` | Poppins SemiBold (`Poppins-SemiBold.ttf`) | 54 | white, 2 px outline, 1 px shadow | 24 chars, 10 words |

- p4-b1 (Rowan): `big_words` is bigger (96 → 104 px) and bolder. Anton has one weight, so "bolder" = a thicker outline (6 → 8 px) plus a 3 px drop shadow, not libass's synthetic bold (it smears letters). Because of the size, short lines break earlier ("STOP / SCROLLING!").
- **Key word rule (big_words)**: if a page holds a word from the script's `edit_plan.emphasis_words`, those word(s) stay in the brand colour for the whole page (one event); a page without one colours the word being spoken (one event per word, as in part A). Matching uses the same normal form as alignment ("3" = "three"; a phrase counts each of its words).
- `small_box` and `minimal` did not change: `tests/fixtures/captions/*.golden.ass` (recorded before the change) must match byte for byte.
- Highlight mechanics: **one Dialogue event per word** (the whole page repeated, only the current word coloured with `{\c&HBBGGRR&}`), not karaoke `\k` tags, because `\k` leaves earlier words coloured. Brand colour must be `#RRGGBB`; otherwise `#FFD400`.
- `small_box` box is opaque because libass draws one box per line and the two lines overlap; a see-through box showed the overlap as a darker stripe.
- `Poppins-ExtraBold.ttf` is bundled but not used yet.
- No `.ass` injection: newlines/tabs become spaces, `\` becomes `/` (libass has no escape for a backslash), `{` `}` become `\{` `\}` (libass extension: literal braces). **Accepted by Rowan (p4-b1)**: a backslash in a script shows as "/" on screen.

## Safe zone (`CAPTION_LAYOUT`, 1080x1920)

| | px | Why |
|---|---|---|
| Top keep-out | 250 | QA-SPEC: not in the top 12% (230 px) |
| Bottom keep-out | 420 | QA-SPEC: not in the bottom 20% (384 px); platform buttons and caption text |
| Left / right | 140 / 140 | QA-SPEC: not in the right 12% (130 px); same on the left so captions stay centred (kept, Rowan p4-b1) |
| Face zone | y 300 – 1150 | Where a HeyGen talking head's face and mouth sit (our estimate, UNCONFIRMED until the first real render; Gate 5 checks) |
| Caption band | y 1150 – 1500 | Captions are bottom-centred (`Alignment 2`) with the bottom edge at 1500 |

The style's `MarginV` = 420 + outline + shadow, so the outline or box also stays inside. Dialogue events set no margins and no `\pos`/`\an`. `estimatePageBox()` estimates each page's box from average letter widths; tests check every page is inside the safe zone and below the face zone.

## The ffmpeg commands (`buildLoudnessMeasureArgs`, `buildEditArgs`)

Every edit runs ffmpeg twice (plus one ffprobe for the length). Option names were checked against the installed ffmpeg 7.1 (`ffmpeg -h filter=loudnorm|sidechaincompress|overlay|drawtext|amix|afade|atrim|ebur128`; the ffmpeg website was not reachable from the build box).

```
# 1. loudness pass 1 (audio only, nothing written; limit EDIT.loudness_timeout_s = 90 s)
ffmpeg -nostdin -hide_banner -nostats -loglevel info -i <raw.mp4> -stream_loop -1 -i <bed.m4a>
  -filter_complex "<audio chain>,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]"
  -map [aout] -f null -

# 2. the final edit (limit EDIT.ffmpeg_timeout_s = 900 s)
ffmpeg -nostdin -hide_banner -nostats -loglevel info -y -i <raw.mp4> -i <broll1.mp4> -i <broll2.mp4> -stream_loop -1 -i <bed.m4a>
  -filter_complex "
    [0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[base];
    [1:v]<same cover>,trim=duration=D1,setpts=PTS-STARTPTS+S1/TB[b1];
    [base][b1]overlay=enable='between(t,S1,E1)':eof_action=pass[v1];  ... one pair per cut
    [vN]subtitles=filename=<captions.ass>:fontsdir=<assets/fonts>,<AI label drawtext>,<watermark drawtext>[vout];
    <audio chain>,loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true:print_format=summary,aresample=48000[aout]"
  -map [vout] -map [aout]
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p
  -c:a aac -b:a 192k -ar 48000 -ac 2
  -movflags +faststart
  <final.mp4>
```

Without b-roll the video part is one chain (`[0:v]scale…,fps=30,subtitles=…[vout]`), as in part A.

- Scale to cover, then crop from the centre: any input becomes 1080x1920 with no black bars.
- Always started with `execFile` (no shell), so there are only two escaping levels (ffmpeg-filters "Notes on filtergraph escaping"): level 1 in an option value escapes `\ ' :`; level 2 in the whole graph escapes `\ ' [ ] , ;`. Tested on the docs' own worked example, and for real in a temp folder named `a:b's [x],y;z\w`.
- `-loglevel info` so libass logs `fontselect: (Anton, 400, 0) -> Anton-Regular, ...`; the integration test checks that each style picks our own font file.
- libass loads every file directly inside the fontsdir. Text files there logged `error opening memory font 'readme.md'` (harmless, but it looks like a failure). p4-b1 moved the README and OFL texts to `assets/fonts/licenses/` (sub-folders are skipped); the integration test now fails if that line comes back.
- Time limits (`lib/qa/config.ts` EDIT), then SIGKILL: final encode `ffmpeg_timeout_s` 900 s, loudness pass 1 `loudness_timeout_s` 90 s, ffprobe `probe_timeout_s` 30 s. Worst case with storage retries stays under the task's 1800 s (tested).

## B-roll (p4-b2, `lib/broll.ts`, numbers in `BROLL`)

- **Provider**: `BrollProvider.search(keyword, { orientation: "portrait", minDuration_s })` returns local clip files, best first. **Only the mock exists** (`MOCK_PEXELS`, on unless exactly `"false"`): `tests/fixtures/broll/catalogue.json` (exact keyword, else a catalogue keyword that is one of the search words, else `default`; portrait and long enough only). `MOCK_PEXELS=false` → plain "B-roll search is not set up yet." (saved on the row, video → team review). There is deliberately **no Pexels client** that can make a request: the real one is a later step after a Pexels key and Zee's OK; it will download each chosen clip into the job's temp folder and return the same shape (timeout, retries, never in tests).
- **Planner** `planBroll` (pure, unit-tested rule by rule):
  - Each `edit_plan.broll_moments[].at_words` is found in the aligned caption words (same normal form as captions: case, punctuation, "3" = "three"); the cut starts at the first matched word. Unknown `at_words` → skipped `not_found`.
  - **Face for the hook and the CTA**: nothing from the start to the end of the hook's last word, nor from the CTA's first word to the end (hook/CTA = `scripts.hook` / `scripts.cta`, found as phrases in the words). A moment there → `protected`. If the hook or CTA can't be found, there is no b-roll at all.
  - Each cut 1.5–3 s (wanted 2.5 s, shortened to fit), at most 4; at least 2 when they fit: with fewer moments, extra cuts go in the biggest free gap, searched with unused `broll_keywords` (`at_words: null`).
  - Coverage of the whole video: **talking ≤ 25%, story ≤ 60%** (`BROLL.max_coverage`). A cut that would pass the cap is shortened, or dropped (`coverage`).
  - No overlaps, and the face comes back for at least `min_gap_s` 0.5 s between cuts: the earlier cut is shortened (only if the next one then really fits), else the later one is dropped (`overlap`). Too close to the CTA → `no_room`.
- In ffmpeg each clip is cover-scaled to 1080x1920 30 fps, trimmed to its length, shifted to its start (`setpts`), and overlaid only inside its window (`enable='between(t,S,E)'`). The voice is untouched (b-roll replaces only the picture). Captions, the label and the watermark are drawn after the overlays, so they stay on top. Each cut gets a different clip when the provider has one.
- The job logs one line per edit: `[edit] broll video=<id> cuts=N coverage=Xs/Ys skipped=<reasons>`.
- **B-roll asked for but none placed → team (p4-b3, QA SF2)**: when the script asked for b-roll (`edit_plan.broll_moments` or `broll_keywords` not empty) and the finished video has **zero** cuts, the edit is still made (face only, the team can watch it) but video and post go to `team_review`, `final_path` saved, with one plain reason on `videos.error` and `posts.status_reason` (`BROLL_TEAM_REASONS` in `lib/edit-flow.ts`): hook or CTA not found in the words → "B-roll couldn't be placed: hook/CTA not found in the transcript."; cuts planned but the provider returned no clip → "No B-roll clips found."; moments asked for but none fit between hook and CTA → "B-roll couldn't be placed: none of the planned moments fit between the hook and the CTA." **Chosen**: a script that asked for NO b-roll at all (no moments, no keywords) keeps going to `final_qa` as a face-only reel, because nothing went wrong there. One or more cuts (even below `min_cuts`) still goes to `final_qa`: "2–4 when they fit".

## Music and loudness (p4-b2, `lib/music.ts`, numbers in `MUSIC`, `LOUDNESS`)

- **Music set**: today the fixture beds in `tests/fixtures/music/` (3 beds, 20–30 s, made from tones; prepared at about -14 LUFS, loop without a click). The real royalty-free set will live in Supabase Storage (a later step) and must be prepared the same way. `pick(video id)` always gives the same bed for the same video. No beds → plain "No music beds are set up yet."
- **Chain**: voice → 48 kHz stereo float → split (one copy mixed, one as the sidechain). Music (input looped with `-stream_loop -1`) → 48 kHz stereo → trimmed to the video length → fade in 0.5 s / fade out 1.5 s → `volume=-22dB` (`bed_gain_db`) → `sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400` with the **voice as the sidechain** (the music ducks while someone speaks) → `amix=inputs=2:duration=first:normalize=0` (normalize=0: amix would otherwise halve both).
- **Music vs voice (QA-SPEC Gate 4: ≥ 15 dB)**: the integration test renders the two stems through the same chain (`audioFilterGraph({ stem: "voice" | "music" })`, the other side goes to `anullsink`) and measures them: voice -16.1 LUFS, music -47.0 LUFS (30.9 dB apart) on the speech-like test input.
- **Loudness, two-pass loudnorm** (QA saw about -15.9 LUFS with one pass): pass 1 runs the same chain into `loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`; `parseLoudnormJson` takes the LAST `{…"input_i"…}` block from stderr (strings → numbers; `-inf` integrated = "The voice track is silent…" plain error; anything unreadable = plain error). Pass 2 (in the final command) passes `measured_I/TP/LRA/thresh` + `offset` (= pass-1 `target_offset`) with `linear=true`, then `aresample=48000` (loudnorm may run at 192 kHz). Values are clamped to ffmpeg 7.1's ranges. TP target -1.5 leaves 0.5 dB for the AAC encode under the -1 dBTP limit; no extra limiter was needed.
- **Measured on the final AAC** (`ebur128=peak=true`): speech-like input -13.9 LUFS / -7.6 dBTP (loudnorm "Linear"); a deliberately peaky, quiet input (-27.1 LUFS, 0 dBTP clicks) -14.8 LUFS / -1.5 dBTP (loudnorm falls back to dynamic mode there). Both inside -14 ±1 and ≤ -1 dBTP. Gate 4 allows ±1.5.
- **Permanent regression (p4-b3)**: the peaky case is `REGRESSION hard case` in `tests/integration/edit-extras-ffmpeg.test.ts`. The fixture is deterministic (`makeTalkingInput(…, "peaky")`: an `aevalsrc` formula, no noise, no seed). Asserted with literal numbers: -15 ≤ I ≤ -13 LUFS and TP ≤ -1.0 dBTP, plus "the input is still hard" (I ≤ -25, TP ≥ -0.5). Proved by mutation (not committed): pass-2 TP target -1.5 → 0 gave -15.1 LUFS / 0 dBTP and the test failed. Measured p4-b3: -14.8 LUFS / -1.5 dBTP (input -27.1 / 0).

## AI label and trial watermark (p4-b2, `EDIT_OVERLAYS` in `lib/edit.ts`)

- **AI label** "AI-generated": `drawtext`, Poppins SemiBold 34 px, white on a 55% black box (12 px padding), top-left of the safe zone (box from x 140, y 250). Drawn when the payload's `aiLabel` OR `videos.ai_label` is true (on by default; the customer can turn it off per video, then both are false). Absent when off (tested on real frames).
- **Trial watermark** "TRIAL PREVIEW", two marks (p4-b3): (1) a **big faint** one, Poppins Bold, `white@0.35` with a 2 px `black@0.2` border, horizontally centred `x=(w-tw)/2`. **p5-a3 (Rowan, replaces the p4-b3 middle-third placement): it sits in the lower-middle band between the face and the captions**, see the next bullets. Bounds `width_em` [7.2, 7.6] (measured) and `height_em` 0.85 (safe upper bound incl. the border) in `EDIT_OVERLAYS.watermark_centre`, checked by a unit test (safe box vs face + captions) and by the integration test (the drawn box). (2) the **small corner tag**, Poppins Bold 34 px, white on a `black@0.5` box (12 px padding), top-right of the safe zone, same row as the label. A screenshot can't crop the centre mark off. The publish guard needs BOTH in the real argv. **Where "trial" comes from**: `videos.watermark` (initial schema, default false), set to true when a trial preview's video row is made (PRODUCT.md: the free trial's 20-second preview is watermarked; Phase 7 sets it from `profiles.plan_status = 'trial'`). The editor draws it when the payload's `watermark` OR the row says so, so a payload can never remove it.
- The label and the corner tag both sit on a semi-opaque dark box (p4-b3), so they stay legible on light b-roll (artifact `after-talking-big_words-trial-broll.png`). They sit far above the caption band (y 1150–1500). Nothing covers captions or the face; `expansion=none` so the text is drawn exactly as written.
- **Centre mark placement (p5-a3).** Band = face zone bottom (`CAPTION_LAYOUT.face_zone.bottom`, 1150; no new constant, the face box already lives there) → the highest caption box of any style at `MAX_PAGE_LINES` = 2 lines (`captionBoxTop` in `lib/captions.ts`, the same maths as `estimatePageBox`): big_words 1228.4, small_box 1328, minimal 1364.4, so the band is 1150–1228.4 = 78.4 px. `gap_margin` 4 px on both sides leaves 70.4 px; size = floor(70.4 / 0.85) = **82 px**; y centre = round((1150 + 1228.4) / 2) = **1189**, drawtext `y=1189-th/2`. Safe box: y 1154.2–1223.9, x 228–852 (7.6 em × 82 = 623 px, inside the 140 px margins). Measured with the real ffmpeg 7.1: drawn box x 236–842 = **607 px (7.40 em, 56% of 1080)**, y **1156–1219** (64 px tall), 6 px below the face zone and 9 px above the captions. All numbers are derived in `centreMark()` (`lib/edit.ts`); a caption style or face-zone change moves/resizes the mark automatically and the unit test re-checks it. Integration test note: the trial-vs-not pixel diff also shows x264 noise at the caption edges (≤ 11 px a row); the mark is measured as one solid block of rows and every other row must stay ≤ 20 px.
- Check on the first real trial render (Gate 5) that the face really ends above y 1150 (face zone is an estimate).

## +faststart

- `-movflags +faststart` on every final file (QA-SPEC Gate 4): the moov box is written before mdat so a phone starts playing at once. The integration test reads the top-level MP4 boxes from the file bytes: `ftyp moov free mdat`.

## Publish guard (p4-b1, now checked on the real command)

- `notYetApplied(extras, args)` looks in the argv ffmpeg actually runs for each requested extra: b-roll (each clip is an input and one `overlay=enable=` per cut), music (the bed is an input, `sidechaincompress` + `amix`), loudness (`loudnorm … measured_I … linear=true`), AI label / watermark (their `drawtext` text), faststart (`-movflags +faststart`). Anything missing → `team_review` with a plain line per item ("AI label not added yet.", "Loudness not set yet.", …), never `final_qa`.
- The job always asks for: b-roll (the planned cuts), music, loudness, faststart, plus the label/watermark as above. With everything applied the video goes to `final_qa`.
- Proved by mutation (p4-b2, not committed): removing the label `drawtext` from the builder made the job return `needs_team` (video `team_review`) and 14 unit tests fail; restored, all green.

## Statuses

- Starts only for a post render (not a likeness test) in `rendered`, `audio_qa` or `editing` (a retry), with the payload's raw path equal to `videos.raw_path`. Otherwise "This video can't be edited: …" and nothing changes.
- **One run at a time (p4-b1, QA SF2)**: rpc `start_edit` claims the row for one run (`videos.edit_run_id` = the Trigger.dev run id, `edit_started_at`). Another run is refused while the claim is fresh; the same run (a Trigger.dev retry keeps its run id) may claim again; a claim older than `EDIT.claim_stale_s` (= the task's maxDuration, 1800 s: by then Trigger.dev has stopped that run) may be taken over. Every save (`finishEdit`) is only for the run that still owns the claim; a run that lost it returns `superseded` and touches nothing.
- Video and post → `editing`; success → `final_qa` (Gate 4 is next, Phase 5) with `videos.final_path` = `final/<brand>/<video>/runs/<run>.mp4` in the private `videos` bucket.
- **Run-scoped final files (p4-b3, QA SF1)**: each run uploads to its OWN object `final/<brand>/<video>/runs/<run id>.mp4` (run id = the Trigger.dev run id; letters, digits, `_`, `-` only). A retry of the same run overwrites it. `videos.final_path` points at it only after `finishEdit` (the claim re-check: one conditional UPDATE, still `editing` and still this run) succeeds, so the row never points at a file from a run that lost the claim. A run that lost the claim never writes, overwrites or deletes another run's file; it removes only its own object and returns `superseded`. **Chosen over copy/promote to one canonical path**: Storage has no atomic "copy only if I still own the claim", so a copy step would reopen the same race; Phase 5+ reads the path from the row anyway. A storage-js upload that answers after its timeout can still land later at the run's own path: an orphan in the private bucket, never at another run's path.
- **Publish guard (p4-b1, QA SF3, permanent)**: if any requested extra is missing from the real ffmpeg argv (`notYetApplied(extras, args)`: b-roll, music, loudness, AI label, watermark, faststart), the video is NOT `final_qa`: video and post → `team_review`, `videos.error` names what is missing ("AI label not added yet."), the file is kept (`final_path` saved) for the team. Since p4-b2 everything is drawn, so edits reach `final_qa`.
- Payload (p4-b2 additions): `format` (talking/story, default talking), `hook`, `cta` (required), `brollKeywords` (default []). Phase 5 fills them from `posts.format`, `scripts.hook/cta/broll_keywords`.
- Failure → plain error on `videos.error`, video and post → `team_review`, our uploaded final removed, temp folder always deleted. Only this run's own run-scoped object is ever removed (p4-b3), so a failing run can't delete a file another run finished.
- Storage (p4-b1, QA SF4): download and upload have a per-try timeout (`EDIT.storage_timeout_s` = 120 s; the download's request is aborted, storage-js has no abort for upload so a late upload answer is ignored and a retry overwrites the same path), at most `EDIT.storage_max_attempts` = 3 tries, wait `storage_backoff_ms` × 2^(try−1) plus up to one backoff of jitter. Only timeouts, network errors, 408, 429 and 5xx are retried; other 4xx fail at once. Worst case for download + upload + ffmpeg stays under the task's maxDuration (tested).
- **After the promotion (p5-a, QA SF1)**: once `finishEdit` has pointed `final_path` at this run's file, nothing may remove that file or report `superseded`/`failed`: a failing post update is logged ("the edit finished but the post status was not saved") and the outcome (`edited` / `needs_team`) stands. The post may then stay `editing` while the video is `final_qa`/`team_review`; Phase 5's pipeline should re-sync it.
- **Transcript (p5-a)**: `saveTranscript(id, run, transcript)` writes only while the row is `editing` and claimed by this run (same conditional UPDATE as `finishEdit`); a run that lost the claim during speech-to-text writes nothing and returns `superseded`.
- **Stray run files (p5-a)**: a crash between the upload and `finishEdit`/cleanup can leave `runs/<run>.mp4` that no row points at. Admin → Settings → "Clean up old edit files" (`lib/edit-cleanup.ts`, newest `EDIT.stray_run_videos_per_pass` edited videos) removes one only if its name is a run file, the row (re-read just before) does not point at it, its run does not hold the edit claim, and it is older than `EDIT.stray_run_min_age_s` (6 h; unknown age = kept). No scheduled task: nothing is deleted automatically.
- Not started automatically yet. Phase 5's pipeline will trigger `edit-video` after Gate 3 with idempotency key `edit-<video id>-<attempt>` (global scope).

## First-deploy checks (Rowan, p4-b1)

Check these on the first Trigger.dev deploy / first real render and write the answers here:

- [ ] **libass is in the Trigger ffmpeg extension**: the default `ffmpeg()` extension installs Debian's apt ffmpeg and its docs do not mention libass. Run `ffmpeg -filters` in a task once and look for `subtitles`. If it is missing, try `ffmpeg({ version: "7" })` (a static build; that is a trigger.config.ts change) and check again.
- [ ] **Fonts are found** at `path.join(process.cwd(), "assets/fonts")` in the deployed task (additionalFiles docs). The job checks they exist and fails with a plain error if not; the libass log should show `fontselect: (Anton, ...) -> Anton-Regular`.
- [ ] **A 60 s edit's time and peak memory on `large-1x`**. If it is killed for memory, use `large-2x`.
- [ ] **drawtext (libfreetype) is in the Trigger ffmpeg** (the AI label and watermark need it): `ffmpeg -filters` must list `drawtext`, `loudnorm`, `sidechaincompress`. Locally (ffmpeg 7.1.5, Debian) all are there.
- [ ] **Mock files are not in the Trigger build**: `tests/fixtures/broll` and `tests/fixtures/music` are not copied by `additionalFiles` (we did not change trigger.config.ts). A deployed edit therefore stops with the plain "B-roll search is not set up yet." / "No music beds are set up yet." (video → team review) until the Pexels client and the Storage music set exist. Intended: mock media never ships to customers. This is a **go-live blocker** in CLAUDE.md (p4-b3).
- [ ] **Face position y 300–1150 confirmed on the first real render** (`CAPTION_LAYOUT.face_zone`); captions must sit below the mouth. Until then it is our estimate.
- [ ] **Gate 5 face-zone check (p5-b4)**: on the first real HeyGen renders, confirm the face really ends above **y 1150** (`CAPTION_LAYOUT.face_zone.bottom`; Gate 5 sends "face below the face zone" straight to the team, and the trial centre mark sits just under it at y 1156–1219). If real faces sit lower, every video will go to the team: tell Zee before changing the number.
- [ ] **Gate 5 pixel thresholds (p5-b4)**: on the first real renders (with real backgrounds, not our flat fixtures), check that the AI label and the trial tag are reported "drawn" where they are and "absent" where they are not. Values to verify, all in `VISUAL_QA.pixel` (`lib/qa/config.ts`): `box_tolerance` 14, `min_contrast` 25, `text_min_luma` 180, `text_min_share` 0.02, `text_width_em` 0.45. A wrong "label missing" sends every video to the team; never change a value without Zee's OK.
