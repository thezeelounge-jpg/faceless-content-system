# Editor notes (Phase 4)

How the editor turns a raw HeyGen MP4 into a finished 9:16 reel. Part A (this file) = scale/crop, fps, word-by-word captions. Part B adds b-roll, music + loudness, the AI label, the trial watermark and `+faststart`.

## Files

| File | What it does |
|---|---|
| `lib/stt.ts` | Speech-to-text interface (`SttProvider`, `Transcript` zod schema). Only the mock exists. |
| `lib/captions.ts` | Aligns display_text with the transcript, makes caption pages, writes the `.ass` file. Styles and safe zone live here. |
| `lib/edit.ts` | Pure ffmpeg argv builder + filtergraph escaping. |
| `lib/edit-flow.ts` | The job: download → transcript → captions → ffmpeg → upload; plain errors on the row. |
| `lib/edit-store.ts` | Supabase store/storage for the job (secret key, task only). |
| `trigger/edit-video.ts` | `schemaTask` `edit-video`, `large-1x` (4 vCPU / 8 GB), maxDuration 1800 s, 2 attempts. |
| `assets/fonts/` | Anton + Poppins (SIL OFL 1.1), copied into the Trigger build by `additionalFiles`. |
| `tests/integration/edit-ffmpeg.test.ts` | Real local ffmpeg run, checked with ffprobe (part of `npm test`). |
| `scripts/p4-artifacts.ts` | `npm run p4:artifacts`: before/after files into `../logs/p4-artifacts/` (by hand only). |

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
| `big_words` (default) | Anton (`Anton-Regular.ttf`), UPPERCASE | 96 | white, 6 px black outline; the word being said in the brand colour | 15 chars, 6 words |
| `small_box` | Poppins Bold (`Poppins-Bold.ttf`) | 60 | white on an opaque near-black box (BorderStyle 3, 14 px padding) | 20 chars, 10 words |
| `minimal` | Poppins SemiBold (`Poppins-SemiBold.ttf`) | 54 | white, 2 px outline, 1 px shadow | 24 chars, 10 words |

- Highlight: `big_words` uses **one Dialogue event per word** (the whole page repeated, only the current word coloured with `{\c&HBBGGRR&}`), not karaoke `\k` tags, because `\k` leaves earlier words coloured. Brand colour must be `#RRGGBB`; otherwise `#FFD400`.
- `small_box` box is opaque because libass draws one box per line and the two lines overlap; a see-through box showed the overlap as a darker stripe.
- `Poppins-ExtraBold.ttf` is bundled but not used yet.
- No `.ass` injection: newlines/tabs become spaces, `\` becomes `/` (libass has no escape for a backslash), `{` `}` become `\{` `\}` (libass extension: literal braces).

## Safe zone (`CAPTION_LAYOUT`, 1080x1920)

| | px | Why |
|---|---|---|
| Top keep-out | 250 | QA-SPEC: not in the top 12% (230 px) |
| Bottom keep-out | 420 | QA-SPEC: not in the bottom 20% (384 px); platform buttons and caption text |
| Left / right | 140 / 140 | QA-SPEC: not in the right 12% (130 px); same on the left so captions stay centred |
| Face zone | y 300 – 1150 | Where a HeyGen talking head's face and mouth sit (our estimate, UNCONFIRMED until the first real render; Gate 5 checks) |
| Caption band | y 1150 – 1500 | Captions are bottom-centred (`Alignment 2`) with the bottom edge at 1500 |

The style's `MarginV` = 420 + outline + shadow, so the outline or box also stays inside. Dialogue events set no margins and no `\pos`/`\an`. `estimatePageBox()` estimates each page's box from average letter widths; tests check every page is inside the safe zone and below the face zone.

## The ffmpeg command (`buildEditArgs`)

```
ffmpeg -nostdin -hide_banner -nostats -loglevel info -y -i <raw.mp4>
  -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,subtitles=filename=<captions.ass>:fontsdir=<assets/fonts>[vout]"
  -map [vout] -map 0:a:0
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p
  -c:a aac -b:a 192k -ar 48000 -ac 2
  <final.mp4>
```

- Scale to cover, then crop from the centre: any input becomes 1080x1920 with no black bars.
- Always started with `execFile` (no shell), so there are only two escaping levels (ffmpeg-filters "Notes on filtergraph escaping"): level 1 in an option value escapes `\ ' :`; level 2 in the whole graph escapes `\ ' [ ] , ;`. Tested on the docs' own worked example, and for real in a temp folder named `a:b's [x],y;z\w`.
- `-loglevel info` so libass logs `fontselect: (Anton, 400, 0) -> Anton-Regular, ...`; the integration test checks that each style picks our own font file.
- ffmpeg time limit: `EDIT.ffmpeg_timeout_s` = 900 s (`lib/qa/config.ts`), then SIGKILL.
- Part B extension points: `EditExtras` (`broll`, `music`, `ai_label`, `watermark`, `faststart`). Today `notYetApplied()` lists any that were asked for and the args do not change; the job returns that list.

## Statuses

- Starts only for a post render (not a likeness test) in `rendered`, `audio_qa` or `editing` (a retry), with the payload's raw path equal to `videos.raw_path`. Otherwise "This video can't be edited: …" and nothing changes.
- Video and post → `editing`; success → `final_qa` (Gate 4 is next, Phase 5) with `videos.final_path` = `final/<brand>/<video>.mp4` in the private `videos` bucket.
- Failure → plain error on `videos.error`, video and post → `team_review`, any uploaded final removed, temp folder always deleted.
- Not started automatically yet. Phase 5's pipeline will trigger `edit-video` after Gate 3 with idempotency key `edit-<video id>-<attempt>` (global scope).

## Check on the first Trigger.dev deploy

- The default `ffmpeg()` extension installs Debian's apt ffmpeg. Its docs do not mention libass: run `ffmpeg -filters` in a task once and look for `subtitles`. If it is missing, try `ffmpeg({ version: "7" })` (a static build) and check again.
- The fonts arrive at `path.join(process.cwd(), "assets/fonts")` (additionalFiles docs). The job checks they exist and fails with a plain error if not.
- How long a 60 s reel takes on `large-1x`, and its peak memory. If it is killed for memory, use `large-2x`.
