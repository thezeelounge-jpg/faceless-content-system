# QA spec

Claude Code: read this before building anything in the pipeline, and before changing any prompt, edit template or threshold.

## Principles

1. **Customers only ever see videos that passed QA.**
2. **Our failures are free.** QA failures and re-renders we trigger never count against the customer's plan.
3. **One automatic fix per gate.** If a gate fails, try one automatic fix. If it fails again, send it to the team QA queue, never to the customer.
4. **Every gate writes a `qa_reports` row:** gate, passed, score, issues (JSON list of {code, detail, at_seconds}), auto_fix.
5. **All thresholds live in `lib/qa/config.ts`.** The numbers below are starting values. Calibrate them on the first real videos (Phase 5, step 8; see "Calibration" below: we use 10, not 20).
6. **Development never spends real money by accident.** QA code is tested with `MOCK_HEYGEN=true` and `MOCK_STT=true` against fixture files in `tests/fixtures/`.

## The gates in order

```
Script written
  → Gate 1  Script QA
  → Gate 2  Pronunciation prep
  → HeyGen render
  → Gate 3  Audio and pronunciation QA
  → Edit (captions, b-roll, music, label)
  → Gate 4  Technical QA
  → Gate 5  Visual and realism QA
  → Gate 6  Human review (when required)
  → Customer review (Approve / Redo / Skip)
```

---

## Gate 1: Script QA (before any money is spent)

Run by Claude (MAIN), with a rubric that returns JSON validated by zod.

| Check | Rule | Type |
|---|---|---|
| Length | words ÷ brand.words_per_second ≤ plan max_seconds_per_video | hard |
| Hook | the first sentence is 12 words or fewer and makes a promise or opens a question | hard |
| Call to action | present and matches the brand's offers | hard |
| Banned words | none of brand.banned_words appear | hard |
| Made-up facts | every number, statistic, result or client claim comes from the brand profile or offers; anything else is removed or rephrased as opinion | hard |
| Risky niches | health, money and legal claims are softened or carry a short disclaimer; no promises of results | hard |
| Voice match | 1 to 10 score against the writing samples; pass at 7 or more | soft |
| Language | matches brand.language (English, Roman Urdu or Hinglish) all the way through | hard |
| Platform safety | nothing that breaks Instagram, TikTok, LinkedIn or X community rules | hard |

**On fail:** Claude rewrites once using the listed issues, then re-checks. A second fail goes to the team queue (managed brands) or shows "Needs you" with a plain reason (self-serve).

---

## Gate 2: Pronunciation prep (before render)

Every script has two texts:

- **display_text:** what the viewer reads in captions (correct spelling).
- **spoken_text:** what HeyGen speaks (spelled the way it should sound).

Steps:

1. **Find risky words:** names of people, brands, products and places; Urdu or Hindi words written in English letters; acronyms; numbers; prices and currency (Rs, PKR, AED, $); dates; times; percentages; URLs; @handles; symbols (&, %, +); emojis.
2. **Normalise for speech:** "Rs 2,999" → "two thousand nine hundred and ninety-nine rupees"; "50%" → "fifty percent"; "yourbrand.com" → "your brand dot com"; strip emojis; acronyms by rule ("CEO" → "C E O", "NASA" as a word).
3. **Apply the brand dictionary:** replace each approved `pronunciations.written` with `say_as` in spoken_text only.
4. **Unknown risky words:** Claude (FAST) suggests a phonetic respelling. Save it as `suggested`. Managed brands: the operator approves it in admin. Self-serve: show it in Settings → "How to say names".
5. Before coding, check the HeyGen docs (llms.txt) for any built-in pronunciation, phoneme or glossary feature. If one exists, use it as well as the respelling. (Checked Nov 2026: HeyGen v3 has a Brand Glossary passed as `brand_glossary_id` on video create. See docs/HEYGEN-NOTES.md; it is wired in Phase 3.)

Our reading of Gate 1 "voice match ... soft": a score under 7 is recorded (qa_reports.score plus a soft issue) and passed to any rewrite, but never fails the gate on its own. Gate 2 fails only when spoken_text still has characters a voice can't read; new words are soft notes.

---

## Gate 3: Audio and pronunciation QA (after render, before edit)

1. **Transcribe** the raw HeyGen audio with the speech-to-text API, with word-level timings. Save it to `videos.transcript`. The edit step reuses these timings for captions. HeyGen's own SRT is built from the script, so it cannot catch mispronunciations. Never use it for this gate.
2. **Compare** the transcript with spoken_text: lowercase, strip punctuation, turn numbers into words, align word by word, and compute word error rate (WER).
3. **Key terms must all match:** brand name, person's name, offer names, the call-to-action words and every dictionary term. If the transcript spells a key term differently, Claude (FAST) decides whether it is the same sound (for example Roman Urdu spelling variants) or a real mispronunciation.
4. **Audio health:** no silence longer than 1.0 s inside speech; no clipping; duration within ±15% of est_seconds and never over the plan maximum.

| Threshold (starting value) | English | Roman Urdu / Hinglish |
|---|---|---|
| Max WER | 8% | 15% (speech-to-text is less reliable here) |
| Key-term mismatches allowed | 0 | 0 |
| Max silence inside speech | 1.0 s | 1.0 s |

**On fail:** add or fix the dictionary respelling for the failed words, regenerate spoken_text, and re-render once (our cost). A second fail goes to the team queue with the exact words and timestamps.

---

## Gate 4: Technical QA (after edit)

Checked with ffprobe and ffmpeg filters. No AI needed.

| Check | Rule |
|---|---|
| Format | 1080x1920, 30 fps, H.264 (yuv420p), AAC 48 kHz, `+faststart` |
| Duration | ≤ plan max_seconds_per_video + 1 s |
| Loudness | -14 LUFS integrated (±1.5), true peak ≤ -1 dBTP |
| Music | music stem at least 15 dB quieter than the voice stem |
| Black frames | none longer than 0.5 s (blackdetect) |
| Frozen frames | none longer than 1.5 s (freezedetect) |
| Caption timing | each caption word within 150 ms of its speech-to-text timing |
| Caption text | matches display_text, with brand names spelled correctly |
| Caption layout | 2 lines at most; inside the safe zone (not in the top 12%, bottom 20% or right 12% of the frame) |
| B-roll | each cut-in lasts 1.5 to 3 s; total coverage within the format limit (talking ≤ 25%, story ≤ 60%); face visible for the hook and the call to action |
| Labels | "AI-generated" label present when ai_label is on; watermark present only on trial videos |
| File size | under 100 MB for 60 s |

**On fail:** rebuild the edit once with the fix (all edit settings come from code, so most fixes are automatic). Then send it to the team queue.

---

## Gate 5: Visual and realism QA (after edit)

Run by Claude (MAIN) with image input on frames sampled from the final video: one every 2 s, plus the first and last frames, plus one frame from each b-roll cut-in. Send the caption line spoken at each frame with it.

The rubric returns JSON:

| Field | Meaning | Rule |
|---|---|---|
| face_natural | no warping, melting, double edges, odd teeth or eye glitches | hard |
| mouth_area_clean | no blur or smearing around the mouth | hard |
| hands_ok | no extra or broken fingers or strange hand shapes | hard |
| background_stable | no flicker, wobble or objects appearing or vanishing | hard |
| captions_readable | strong contrast, not cut off | hard |
| captions_clear_of_face | captions never cover the eyes or mouth | hard |
| broll_matches_line | each b-roll frame fits the line being spoken | soft |
| no_stray_text | no watermarks, logos or random text from stock clips | hard |
| first_frame_strong | the first frame works as a thumbnail (face visible, hook caption on screen) | soft |
| realism_score | 1 to 10: would a viewer believe this is a real recording? | pass at 8 or more |

**On fail:** for a b-roll or caption problem, swap the clip or adjust the layout and re-edit once. For a face or realism problem, re-render once on the same engine. If it still fails, send it to the team queue. Repeated realism failures for one brand mean the twin needs a reshoot (docs/RECORDING-GUIDE.md).

**Known limit:** sampled frames cannot judge lip-sync or very short glitches. Gate 6 covers those.

---

## Gate 6: Human review

| When | Who |
|---|---|
| The first 5 videos of every new brand | Operator watches the whole video |
| Any video flagged by Gates 3 to 5 after its automatic fix | Operator |
| Any video with realism_score below 9 | Operator |
| A random 1 in 5 of all other videos | Operator |
| Every video of a managed (done-for-you) brand, until the operator turns this off for that brand | Operator |

The operator checklist in the admin QA queue has one tap per item: pronunciation, lip-sync, looks real, captions, b-roll, music, label. Rejecting a video means picking a reason, which is saved to `qa_reports` with gate `human`.

As built (p5-b4):
- "Flagged by Gates 3 to 5 after its automatic fix" includes a video that **passed** after its fix: it goes to the queue with the reason "Auto-fixed: …", never straight to the customer. A second failure goes to the queue too.
- The reject reason and the operator's note are **team only** (table `human_reviews`, shown on the admin client page and in the queue). The customer's post shows only "Taking a little longer. We're fixing it."
- A reject puts the post back to approved. Nothing is rendered automatically: the team presses Make video again (real renders still need the spend OK, the daily caps and the pause switch). The rejected video never counts.

## Calibration (Phase 5, step 8)

- **10 real videos, not 20.** This spec first said "the first 20 real videos"; PROMPTS.md Phase 5 said 10, and 10 was chosen (`CALIBRATION.min_real_videos` in `lib/qa/config.ts`) so the first look comes sooner. Mock videos never count.
- The calibration view (Admin → Usage and spend) only **shows** each gate's scores against the current threshold and **proposes** a value with the reason. It never writes.
- **Thresholds never change without Zee's OK.** A person edits `lib/qa/config.ts` after Zee agrees; the change is committed with the reason.

## Customer review

Approve, Redo or Skip. **Redo asks for one reason:** "Said something wrong", "Doesn't look like me", "Wrong topic", "Captions", "Music", "Other". Each reason is saved to `qa_reports` with gate `customer`. Pronunciation complaints add the word to the brand's suggested dictionary.

---

## Metrics (admin → Usage and spend → Quality)

| Metric | Target |
|---|---|
| First-time pass rate, per gate | over 85% |
| Automatic fix success rate | over 70% |
| Human reject rate | under 5% |
| Customer redo rate | under 10% |
| Average cost per delivered video (including re-renders) | track weekly |
| Time from approval to Ready | under 2 hours |
| Top 5 failure codes this week | review every Monday |

---

## Software QA

### Automated tests (`npm test` must pass before every commit)

- **Unit:** plan limits and usage ledger (including two renders at once), the spoken-text normaliser, dictionary replacement, word alignment and WER, the ffmpeg command builder, the caption builder, status transitions, webhook signature checks.
- **Pipeline:** the full flow from script to Ready with `MOCK_HEYGEN` and `MOCK_STT`, using the fixture video in `tests/fixtures/`. Includes a forced failure at every gate.
- **End to end (Playwright):** sign up → onboarding → consent upload → admin approve → plan → script → approve → mock video → QA → review → download → test checkout.
- **Security:** user A cannot read user B's rows (RLS); /admin is blocked for customers on the server; no secret key strings in the browser bundle (build-time scan); webhook replays are ignored.

### Prompt regression ("golden set")

`tests/golden/` holds 5 fake brands across niches and languages. `npm run eval:scripts` writes scripts for them and runs Gate 1. Run it whenever a prompt in `/prompts` changes, and compare the pass rate and voice score to the last run. It costs a few cents, so ask the owner before running it.

### Edit regression

Render the fixture video through the edit step and compare 5 sample frames to approved snapshots in `tests/snapshots/`. Run this when an edit template changes.

### Environments

Local (mocks on) → Vercel preview + a staging Supabase project (real services, small spend) → production.

### Release checklist (before every production deploy)

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass
- [ ] The Playwright suite passes on staging
- [ ] One real video goes end to end on staging and passes every gate
- [ ] No new environment variable is missing in Vercel or Trigger.dev production
- [ ] CLAUDE.md status is updated
