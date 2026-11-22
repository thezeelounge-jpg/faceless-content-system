# QA engine (Phase 5): orchestrator, Gates 3 to 6, Quality, calibration

Built in p5-a2 / p5-b2 / p5-b3 (22 Nov 2026). Rules come from `docs/QA-SPEC.md`; every number lives in `lib/qa/config.ts` (`AUDIO_QA`, `TECH_QA`, `VISUAL_QA`, `HUMAN_REVIEW`, `QUALITY`, `CALIBRATION`, plus the existing `BROLL`, `MUSIC`, `LOUDNESS`).

## The pipeline (`lib/qa/pipeline.ts`)

| After | Runs | Next (Trigger.dev task, global idempotency key) |
|---|---|---|
| render finished (`poll-render`, also after a webhook) | — | `audio-qa` (`audio-qa-<video>`) for post videos only |
| `audio-qa`: Gate 3 passed | `lib/qa/audio-gate.ts` | `edit-video` (`edit-<video>-1`), payload from the rows (`editJobFor`) |
| Gate 3 failed once (fixable) | respell + `create_qa_rerender` + `renderVideo` | `poll-render` for the new video (`render-video` when all 10 slots were busy) |
| `edit-video` reached `final_qa` | `lib/edit-flow.ts` | `technical-qa` (`technical-qa-<video>-<edit run>`) |
| `technical-qa`: Gate 4 failed once | `lib/qa/technical-gate.ts` | `edit-video` again (`edit-<video>-rebuild-1`) |
| Gate 4 passed | — | `visual-qa` (`visual-qa-<video>-<edit run>`), p5-b2 |
| `visual-qa`: Gate 5 passed | `lib/qa/visual-gate.ts` | nothing: delivered (`ready`, counted) or the QA queue (`team_review`, not counted) |
| Gate 5 failed once (captions / b-roll) | re-edit | `edit-video` (`edit-<video>-visual-1`) → Gate 4 → Gate 5 again |
| Gate 5 failed once (face / realism) | `create_visual_rerender` + `renderVideo` | `poll-render` for the new video (`render-video` when all slots are busy) → Gates 3, 4, 5 |
| a second failure, or one a fix can't help | — | nothing: video + post `team_review` with a plain team reason |
| p5-b1: `audio-qa` / `technical-qa` failed for good (crash after the last retry, or a refusal) | `onFailure` → `gateCrashed` | nothing: a video still in `audio_qa` / `final_qa` + its post → `team_review` (`GATE_CRASH_REASONS`); safe to repeat |
| p5-b1: after every `edit-video` run (and a refused retry) | `resyncAfterEdit` (`syncAfterEdit`) | a post stuck in `editing` while its video is promoted (`final_path`, `final_qa` / `team_review`) is moved on; `technical-qa` with the SAME key as above (`edit_run_id`), so Gate 4 never starts twice |

Statuses: video and post `rendering → audio_qa → editing → final_qa`; failures after the one automatic fix → `team_review`, never `needs_you`. Tasks trigger each other by id (`trigger/next-step.ts`), so no task file imports another. New tasks: `trigger/audio-qa.ts`, `trigger/technical-qa.ts` (both `medium-1x`). **trigger.config.ts is unchanged.**

Every gate run writes ONE `qa_reports` row: `gate` (`audio` / `technical`), `passed`, `score` (Gate 3: WER as a fraction; Gate 4: integrated LUFS), `issues` (`{code, detail, at_seconds, severity}`), `auto_fix` (the fix that led to THIS run, as in Gate 1: null on a first run).

## Gate 3: audio and pronunciation (`lib/qa/audio-checks.ts`, `lib/qa/audio-gate.ts`)

1. Transcript: the one on `videos.transcript` (a retry never pays twice), else speech-to-text on the raw MP4 (`lib/stt.ts`; `spoken_text` goes along as `expectedText`). Saved on the row; the editor reuses it. HeyGen's SRT is never used.
2. Normalise both sides with the Gate 2 normaliser, lowercase, no punctuation, hyphens split words. The reference is `spoken_text` with every APPROVED respelling turned back into the written word (speech-to-text writes "Ayesha", not "Aa-ee-sha").
3. Word alignment (Levenshtein over words) → WER. Limits: `AUDIO_QA.max_wer` (en 8%, roman_urdu / hinglish 15%).
4. Key terms: brand name, each word of the person's name (`consents.person_legal_name`), offer names (from `brands.offers`), CTA content words, every approved dictionary word. A term matches when the heard letters join up to the written or respelled form ("whats app" = WhatsApp). Each place is reported once. Mismatches go to Claude FAST task `key_term_check` (`prompts/key-term-check.md`, effort low): `same_sound` → a soft note; `mispronounced` → a hard `key_term` issue with the exact words and `at_seconds`. If Claude can't answer, every mismatch counts as mispronounced (fail safe).
5. Audio health: silence over 1.0 s inside speech (word gaps AND `silencedetect`, merged), clipping (`astats`: peak ≥ -0.1 dBFS reached ≥ 8 times), duration within ±15% of `est_seconds`, never over the plan maximum.
6. **Auto-fix (once):** first render + every hard problem is one a re-render can fix (`key_term`, `wer`, `silence`, `clipping`): each mispronounced word is saved to `pronunciations` as **status `approved`, source `qa`** (only approved rows are applied by `lib/pronunciation/dictionary.ts`; the operator sees the `qa` source in How to say names and can change it), `spoken_text` is rebuilt, rpc `create_qa_rerender` marks this video `failed` and inserts attempt 2 (`counts_toward_plan = false`, `rerender_of`, `qa_fix_note`), which goes through the normal `renderVideo` (spend guard; mock rows recorded, never counted; no plan slot reserved for attempt 2). Duration problems go straight to the team.
7. **Real HeyGen:** the automatic re-render is NOT sent without the admin's spend OK. `renderVideo` refuses before any call; the re-render stays `queued` and the post goes back to `approved` with the reason, so "Make video" finds it (`existing`) and asks for "I agree to spend".

## Gate 4: technical (`lib/qa/technical-checks.ts`, `lib/qa/technical-gate.ts`)

The editor now saves `videos.edit_manifest` (`lib/qa/edit-manifest.ts`): caption pages with word times and the speech-to-text words they came from, b-roll cuts + the protected hook/CTA window, the music bed + its gain, label/watermark, `not_applied`. Gate 4 checks:

| Check | How |
|---|---|
| Format | ffprobe: 1080x1920, 30 fps, h264 yuv420p, AAC 48 kHz; the file's top-level boxes: `moov` before `mdat` (+faststart) |
| Duration / size | ≤ plan max + 1 s; ≤ 100 MB per 60 s (proportional) |
| Loudness | one ffmpeg pass: `ebur128=peak=true` → -14 ±1.5 LUFS, true peak ≤ -1 dBTP |
| Black / frozen | same pass: `blackdetect` (> 0.5 s fails), `freezedetect` (> 1.5 s fails; a freeze open at the end runs to the end) |
| Music | **stem method:** the editor's own audio chain (`audioFilterGraph`: same bed, `bed_gain_db`, sidechain ducking) run twice on the raw voice + bed, rendering only the voice stem, then only the music stem, each measured with ebur128; gap ≥ 15 dB. Loudnorm is left out on purpose: in linear mode it is one constant gain on the mix, so it moves both stems equally |
| Captions | timing: words heard as themselves (matched / substituted / merged) start within 150 ms of their speech-to-text start (split and unheard words have no own time); text = display_text; brand name + approved dictionary words spelled right; ≤ 2 lines; `estimatePageBox` inside the safe zone (not top 12%, bottom 20%, right 12%) |
| B-roll | each cut 1.5–3 s; coverage ≤ 25% (talking) / 60% (story); no cut over the hook or the CTA |
| Labels | AI label when `videos.ai_label` (and not in `not_applied`, i.e. really in the ffmpeg argv); watermark only and always when `videos.watermark` |

**Auto-fix (once):** the video goes back to `audio_qa` and the edit is rebuilt. All edit settings come from code, so the rebuild re-runs the editor; a problem in the code fails again and goes to the team. An edit made before p5-a2 has no manifest (`no_manifest`) and is rebuilt.

## Gate 5: visual and realism (p5-b2, `lib/qa/visual-checks.ts`, `lib/qa/visual-gate.ts`, task `trigger/visual-qa.ts`)

Started by `technical-qa` when Gate 4 passed (key `visual-qa-<video>-<edit run>`); the video and post stay `final_qa` while it runs.

1. **Frames** (one ffmpeg pass over the final file): one every 2 s, the first and the last, one in the middle of each b-roll cut (`framePlan`, at most `VISUAL_QA.max_frames`). Each frame twice: a 540 px JPEG for Claude and a full-width gray strip (y 240–320) for the pixel checks.
2. **Claude MAIN** task `visual_qa` (prompt `prompts/visual-qa.md`, effort medium, images + zod rubric `visualQaOutput`): the QA-SPEC fields, `realism_score`, the face and mouth boxes, issues with a frame index (→ `at_seconds`). Each frame goes with its time, kind and the caption line on screen. If Claude can't answer: hard `visual_judge_failed` → team (fail safe).
3. **No AI:** the AI label (when `ai_label`) and the small trial tag (only and always when `watermark`) must really be drawn: the box rows above the text must be the background beside the box darkened by the drawtext alpha, and the text rows must hold bright letters (`overlayDrawn`: drawn / absent / unknown; a near-black frame is "unknown" and counts neither way; if no frame could be checked: a soft `*_unverified` note). The face box must end above `CAPTION_LAYOUT.face_zone.bottom` (1150): below it → hard `face_zone_estimate` with a plain team reason ("the face-zone estimate is wrong"), never auto-fixed (trial: says whether it reaches the TRIAL PREVIEW strip).
4. ONE `qa_reports` row (gate `visual`, score = realism, `auto_fix` = the fix that made this video).
5. **Passed** → QA-SPEC Gate 6 rules (`humanReviewReasons`): one of the brand's first 5 posts to pass Gate 5, realism under 9, a managed brand while `brand_qa_settings.team_reviews_every_video` is on (no row = on), **p5-b4: passed only after an automatic fix** (`auto_fixed`: the script has any failed Gate 3, 4 or 5 report, so a re-render, rebuild or re-edit happened; reason "Auto-fixed: …"), else a stable random 1 in 5 (`sampledForReview`, by video id). Any → video + post `team_review` (the QA queue) with the reason (`HUMAN_REVIEW_TEXT`). None → rpc `deliver_post_video`: video + post `ready`, and this video is the post's ONE counted video (`counts_toward_plan = true`, every other video of the post false); `confirmPlanSlot` (stub until Phase 7).
6. **Failed**, and the script has not used its one Gate 5 fix (failed `visual` reports counted per SCRIPT, so a re-render shares the budget): `classifyFix`: face/realism problem → re-render once (rpc `create_visual_rerender`: attempt + 1, `counts_toward_plan = false`, `rerender_gate = 'visual'`, through `renderVideo`; real HeyGen waits for the admin's spend OK exactly like Gate 3); captions over the face / unreadable → re-edit once with the next lower caption style (`VISUAL_QA.caption_fix_styles`: big_words → small_box → minimal); stray text in a b-roll frame → re-edit with that clip avoided (`avoidBrollClips`, kept in the manifest's `avoid_clips`). Re-edit = video back to `audio_qa`, post `editing`, `edit-video` key `edit-<video>-visual-1`; `editJobFor` takes the caption style and avoided clips from the manifest, so a later Gate 4 rebuild keeps the fix. Anything else (face zone, label/tag pixels, stray text on the face, Claude unavailable, no lower caption style) or a second failure → `team_review` with the reason.
7. Crash after the last retry → `onFailure` → `gateCrashed("visual")`: a video still in `final_qa` + its post → `team_review`.

**Usage rule:** `counts_toward_plan` is set ONLY by `deliver_post_video` and, for a queue video, by a Gate 6 approval (`review_queued_video`, same rule, p5-b3). Failed attempts, QA re-renders, re-edits, rejected videos and videos waiting in the QA queue never count. Migration `20261123000000` (re-runnable): `videos.rerender_gate`, table `brand_qa_settings` (server only), rpcs `create_visual_rerender`, `deliver_post_video` (both under the per-post render lock, service_role only).

## Gate 6: human review, Admin → QA queue (p5-b3)

Files: `app/admin/qa/page.tsx`, `app/admin/qa/actions.ts`, `lib/qa/human-review.ts` (checklist, reasons, zod, `reviewQueuedVideo`), `lib/qa/queue-store.ts` (list + rpc), `components/admin/qa-queue-item.tsx`, `components/admin/qa-review-form.tsx`.

- **Who is in the queue:** every post video with status `team_review`, oldest first (at most 30 shown): the Gate 5 human-review rules above, a second failure at Gates 3-5, a fix that can't help, or a crash.
- **Each card:** a player (10-minute signed link to the final edit, made on the server; the raw render, labelled, when there is no edit yet), why it is there (`posts.status_reason`, plus `videos.error`), every gate report of the video and of its script (Gates 1-2 are per script), and the checklist: pronunciation, lip-sync, looks real, captions, b-roll, music, label.
- **Approve** (offered only with a finished edit): every box ticked. **Reject**: one reason (a checklist item or "other") + an optional note.
- **Server Action** `reviewVideoAction`: `requireAdmin()` first, then zod (`humanReviewFromForm`), then rpc `review_queued_video` (migration `20261123010000`, service_role only, per-post render lock + video row lock):
  - only a post video still in `team_review`, else `not_in_queue` (a double submit changes nothing);
  - approve: every checklist key `true` (checked again in SQL) and `final_path` set → the usage rule exactly as `deliver_post_video` (this video `ready` + `counts_toward_plan = true`, every other video of the post false), post `ready`, `videos.delivered_at = now()`; then `confirmPlanSlot` (stub until Phase 7);
  - reject (p5-b4, migration `20261123020000` re-states the rpc): video `failed` (never counted, `videos.error` = the reason, no note), post back to **`approved`** with the neutral `status_reason` "Taking a little longer. We're fixing it." (`REJECT_CUSTOMER_REASON`; customers can read `status_reason`, so never the reason or note). **No automatic re-render**: the team presses Make video again (real mode: spend OK, caps, `renders_paused`, as always);
  - both: ONE `qa_reports` row (gate `human`; reject issue code `human_<reason>`), ONE `human_reviews` row (p5-b4: decision, reason, note, admin, time) and ONE `provider_usage` audit row (provider `other`, kind `human_review`, cost 0; the note is no longer copied there), in the same transaction.
- `deliver_post_video` is re-stated in 010000 to also set `delivered_at`.
- **`human_reviews` (p5-b4)**: server only (RLS on, no policies, nothing granted to anon / authenticated; tested with the owner, a second account and anon). Admins see it on the client page (each post: "QA queue decisions (team only)", `components/admin/review-history.tsx`, with "rejected, press Make video to try again" on an approved post) and in the queue card ("Earlier decisions on this post").

## Quality: Admin → Usage and spend (p5-b3)

`lib/qa/quality.ts` (pure `computeQuality`, `parseQualityRange`), `lib/qa/quality-store.ts` (read-only query, service role after `requireAdmin`), `components/admin/quality-table.tsx`. Date range `?from=YYYY-MM-DD&to=YYYY-MM-DD` (UTC days; default the last `QUALITY.default_range_days` = 28). Targets `QUALITY.targets` (QA-SPEC's numbers).

| QA-SPEC metric | How it is computed |
|---|---|
| First-time pass rate, per gate (Gates 1-6) | `qa_reports` with `auto_fix` null: passed / runs (gate 6 = approved / reviewed) |
| Automatic fix success rate | `qa_reports` with `auto_fix` set (the run right after a fix): passed / runs |
| Human reject rate | gate `human`: rejected / reviewed (target is strictly under 5%) |
| Customer redo rate | gate `customer` (written from Phase 6; "No data" until then) |
| Average cost per delivered video | real (non-mock, succeeded) HeyGen `render` spend + `ai_usage` cost in the range, re-renders included, / videos with `delivered_at` in the range |
| Time from approval to Ready | `scripts.approved_at` (p5-b4: stamped by trigger `posts_stamp_script_approved` when the post becomes `approved` before it has any post video, so the checks' approval and any later person's approval are both covered; never overwritten) → `delivered_at`; old rows without it: the post's first post video (`created_at`, "Make video"); average hours |
| Top 5 failure codes this week | hard issue codes of failed reports in the last `QUALITY.top_failure_days` (7) days of the range |

**Paging (p5-b4, QA SF3):** the Quality and Calibration loaders read every row with `lib/qa/paging.ts` (`.range()` 1000 rows at a time, stable order by id, until an EMPTY page, so even a smaller server cap can't cut it short; `.in()` id lists split into 100s). No silent 1000-row truncation.

## Calibration (p5-b3, read only)

`lib/qa/calibration.ts` (pure `calibrate`), `lib/qa/calibration-store.ts` (read-only), `components/admin/calibration-view.tsx`, shown under Quality.

- A **real video** = a post video with a succeeded, non-mock HeyGen `render` row in `provider_usage`. Mock videos never count and their scores are left out. Below `CALIBRATION.min_real_videos` (10): "N of 10 real videos so far … after M more".
- From 10: per gate, each real video's latest score vs the CURRENT value read from `lib/qa/config.ts`: Gate 1 voice match (`SCRIPT_QA.voice_pass_score`), Gate 3 WER per language (`AUDIO_QA.max_wer`), Gate 4 loudness (`TECH_QA` band, shown only, never re-proposed), Gate 5 realism (`VISUAL_QA.pass_realism_score`). Lowest / middle / highest, how many pass.
- **Proposal rule:** videos a person REJECTED in the QA queue whose score still passed the gate → one step past the worst of them (realism / voice +1, max 10; WER −0.01), with the reason. None → keep.
- **Never writes:** no Server Action, form or button; the loader is tested on a client where any write throws; a test checks `lib/qa/config.ts` is unchanged. The owner agrees, then a person edits `lib/qa/config.ts`.

## What is mocked

- `MOCK_STT`: transcripts from `tests/fixtures/stt/`, picked by the spoken text (`by-text.json`); otherwise `sample-transcript.json`. p5-b1: embedded as static JSON imports in `lib/stt.ts` (bundled; works in a Trigger build with no `tests/` folder). A new keyed file must be added to `KEYED_TRANSCRIPTS` too.
- `MOCK_CLAUDE`: `key_term_check` answers from `tests/fixtures/stt/key-term-judgements.json` (unknown pair → mispronounced), embedded the same way (`lib/qa/key-term-mock.ts`).
- `MOCK_CLAUDE` (Gate 5): `visual_qa` answers from `tests/fixtures/visual/answers.json` (embedded), picked by display text; any other text → a good answer (realism 9). "captions-over-mouth" covers the mouth only for the caption styles it lists, so the re-edit really changes the answer. Tests inject the frames (`tests/helpers/visual-frames.ts`); `tests/integration/visual-gate-ffmpeg.test.ts` runs the real sampler and pixel checks on real edits.
- `MOCK_HEYGEN`: the re-render uses the mock client (fixture answers, provider_usage row with `mock = true`, cost 0, never counted toward the daily cap).
- Tests inject the audio measurements (Gate 3) and ffprobe/ffmpeg output (Gate 4); `tests/integration/technical-gate-ffmpeg.test.ts` runs the real local ffmpeg (about 6 s).
- **Known mock artefact:** the MOCK_PEXELS b-roll clips are flat colours, so in a local mock run a b-roll cut longer than 1.5 s is a real freeze and Gate 4 sends it back once, then to the team. Real stock clips move. The integration test uses a moving clip.

## Prompts in the Trigger build (p5-b4, QA SF1)

`loadPrompt` reads `lib/prompts-bundle.ts` (every `/prompts/*.md` as a string, generated by `npm run prompts:bundle`), never the disk, so `visual_qa` and `key_term_check` work in a deployed Trigger task with `MOCK_CLAUDE=false`. `tests/unit/prompts-bundle.test.ts`: byte-for-byte equal to the files (edit a prompt → run the script, or the test fails), and `loadPrompt` works with an empty working folder. trigger.config.ts unchanged. Go-live blocker in CLAUDE.md: verify on the first real-Claude Trigger run.

## Tests

p5-b4: `prompts-bundle.test.ts`; `paging.test.ts`, `quality-store.test.ts` + `calibration.test.ts` (a fake client with a 1000-row cap, more rows than that); `human-review.test.ts` (reject message, `lastReject`, `ReviewHistory`); `visual-checks.test.ts` (`auto_fixed`); `qa-pipeline-gate5.test.ts` (Done-when (a) and the Gate 3 / Gate 4 usage cases now end in the queue, uncounted); `quality-store.test.ts` (time to Ready from `approved_at`, fallback); `tests/db/rls.test.ts` "p5-b4" (admin-only reject note for owner / second account / anon, neutral `status_reason`, reject → approved with no new video or spend row, Make video again + approve, the usage walk Gate 3 re-render → Gate 5 re-render → re-edit → reject → Make video → approve = ONE counted video, `approved_at` stamping), 020000 re-runnable.

p5-b3: `human-review.test.ts` (zod, lib, Server Action), `qa-queue-view.test.ts` (card render), `quality.test.ts` (metrics + the Done-when "the Quality page shows pass rates per gate"), `quality-store.test.ts`, `calibration.test.ts` (incl. "nothing writes"); `tests/db/rls.test.ts` "p5-b3: review_queued_video" (approve / reject / double submit / checklist / grants), `delivered_at` server only, 010000 re-runnable. Helper `tests/helpers/read-only-db.ts`.

p5-b2: `visual-checks.test.ts`, `visual-mock.test.ts`, `visual-gate.test.ts`, `qa-pipeline-gate5.test.ts` (full mocked pipeline + Done-when), `tests/integration/visual-gate-ffmpeg.test.ts`. Earlier: `tests/unit/audio-checks.test.ts`, `key-term-check.test.ts`, `audio-gate.test.ts` (incl. the Done-when), `technical-checks.test.ts`, `technical-gate.test.ts`, `qa-pipeline.test.ts`, `qa-tasks.test.ts`, `pipeline-store.test.ts`; `tests/db/rls.test.ts` (create_qa_rerender, new server-only columns); `tests/integration/technical-gate-ffmpeg.test.ts`.
