# Claude Code prompts, one per phase

How to use: open PowerShell in your project folder, run `claude`, and paste one phase. A phase can take several sessions; if you start a new session, paste the same phase again and say "continue". Don't move on until every "Done when" item works.

- **Phases 1 to 5 build the engine.** You use it from the admin area to run the done-for-you service.
- **Phases 6 to 9 add the self-serve SaaS** around the same engine.

---

## Phase 1: Foundation

```
PHASE 1: Foundation. Read CLAUDE.md and docs/PRODUCT.md first.

This folder already has CLAUDE.md, START-HERE.md, PROMPTS.md and docs/. Keep them. Do not delete or overwrite them.

1. Create a Next.js app (App Router, TypeScript, Tailwind, shadcn/ui) in this folder without removing the existing files. If create-next-app refuses because the folder is not empty, scaffold in a temp folder and move the files in. Add .gitignore (including .env.local). Create .env.example from START-HERE.md (no real values).
2. Connect Supabase. Add Supabase Auth with email magic link and Google. Server-side role check: admins are the emails in ADMIN_EMAILS.
3. Write SQL migrations for every table in the docs/PRODUCT.md data model, with Row Level Security so customers only see their own rows, plus a trigger that creates a profiles row on sign-up. Push them.
4. Set up Trigger.dev v4 with one hello-world task, plus a lib/config.ts that reads MOCK_HEYGEN and MOCK_STT.
5. Create the /admin area, guarded on the server, with empty pages: Clients, Consents and twins, Scripts, QA queue, Videos, Usage and spend, Payments, Settings.
6. Create tests/fixtures/ with a README explaining which sample files go there (I will add a sample HeyGen video later).
7. Push to my GitHub repo and connect Vercel previews. Tell me which env vars to add in Vercel and wait while I add them.

At the end, update the CLAUDE.md status and give me a 5-point test checklist.
```

**Done when:**
- You can log in with a magic link, and /admin opens for your email only (on the server, not just hidden).
- The Supabase Table Editor shows every table and your profile row.
- A second test account cannot see your rows.
- The Trigger.dev dashboard shows the hello-world run.
- A Vercel preview link works.

**Common fixes:** the magic link goes to the wrong URL → set the Site URL and Redirect URLs in Supabase Auth. The Vercel build fails → env vars are missing in Vercel.

---

## Phase 2: The brain (profile, plan, scripts, script QA)

```
PHASE 2: The brain. Read CLAUDE.md, docs/PRODUCT.md and docs/QA-SPEC.md (Gates 1 and 2).

1. Admin → Clients → "New client": an onboarding form built as a reusable component (Phase 6 reuses it for customers): niche preset (coach, consultant, founder, freelancer, agency, real estate, doctor, business story), audience, offers, tone, 3 "how do you sound" questions, 3 to 5 writing samples, banned words, language (English, Roman Urdu, Hinglish), posting days, posts per week (1 to 14), up to 3 audience countries (default Pakistan), autopilot level. Saves a brand with is_managed = true.
2. lib/claude.ts following every rule in CLAUDE.md "Claude API rules": structured outputs with zod, models from env, explicit effort, refusal handling, the brand profile in a cached system block, and token and cost logging to ai_usage. Prompts live in /prompts as files.
3. Brand profile: Claude (MAIN) writes profile_md and 4 to 6 content pillars. Each edit saves a new brand_versions row.
4. Monthly plan: an admin button "Plan next 4 weeks". Claude (PLANNER) returns posts (date, pillar, title, hook, format: talking or story) that respect posting days and posts per week. Set each post's time from lib/posting-times.ts, following the "Planning rules" in docs/PRODUCT.md (per-network times per country, Friday prayer time, local weekends, Ramadan dates from app_settings). Show the posts as a month grid and a list.
5. Script writer (MAIN): display_text, hook, body, cta, est_seconds (from brand.words_per_second), captions for Instagram, TikTok, LinkedIn and X, hashtags, broll_keywords, edit_plan (b-roll moments and words to emphasise). It must fit the plan's max_seconds_per_video (use the temporary values in lib/plans.ts).
6. Gate 1, Script QA, exactly as in docs/QA-SPEC.md, with one automatic rewrite, writing qa_reports.
7. Gate 2, Pronunciation prep: the spoken-text normaliser, the pronunciations table, an admin page "How to say names" per brand (add, approve, edit), and spoken_text generation. Unit tests for the normaliser (numbers, rupees, %, URLs, @handles, emojis, acronyms).
8. Golden set: 5 fake brands in tests/golden/ (mixed niches and languages) and `npm run eval:scripts`. Ask me before running it.

Test with one fake brand and show me one full script with its QA report.
```

**Done when:**
- A new client gets a profile that sounds like their samples, and editing it creates version 2.
- "Plan next 4 weeks" only uses the chosen days and count.
- Each script has display_text, spoken_text, hook, CTA, 4 captions, hashtags, an edit plan and a passing QA report.
- "Rs 2,999" in display_text becomes words in spoken_text, and a dictionary word gets its "say as" form.
- `npm run eval:scripts` shows the pass rate for the 5 golden brands.

**Common fixes:** a 404 model error → check the model env vars. A 400 about thinking or tool_choice → re-read the CLAUDE.md Claude API rules. Generic scripts → add more writing samples and banned words.

---

## Phase 3: The face (consent, twin, likeness test, render)

```
PHASE 3: The face. Read CLAUDE.md, docs/PRODUCT.md and docs/RECORDING-GUIDE.md. Before coding, read https://developers.heygen.com/llms.txt and the docs for avatar from video, avatar consent, avatar looks, generating avatar videos and webhooks. Also check for a test or sandbox mode and for any pronunciation or glossary feature, and tell me what you found.

1. lib/heygen.ts: typed helpers for every endpoint we use, plus a MOCK_HEYGEN mode that returns the fixture video from tests/fixtures/. Add a test route that checks GET /v3/users/me.
2. Consent page per brand (in admin now; customers in Phase 6): legal name + consent checkbox; 3 random words that expire in 30 minutes; the recording guide; an in-browser recorder or file upload to a private bucket; a consents row with admin_status pending.
3. Automatic clip checks, saved to consents.clip_checks: duration within HeyGen's limits, resolution of 1080 or more, fps, loudness, no long silences, and one clearly visible face (Claude vision on 6 sampled frames). Show the results to the admin with plain reshoot tips when something fails.
4. Admin approval: a video player, the 3 words, and the clip checks; Approve or Reject with a note. Approve starts a Trigger.dev task that creates the digital twin, saves heygen_group_id, starts HeyGen's consent flow, and emails the consent link.
5. A polling task waits until the twin is ready, then saves the look id, voice id and supported engines.
6. Likeness test: for each realistic engine the look supports, render the same 15-second line. ASK ME BEFORE RENDERING; this spends money. An admin page shows the videos side by side with buttons "Use this engine" and "Needs reshoot" (which emails docs/RECORDING-GUIDE.md tips). Save the choice to brands.engine (and avatars.chosen_engine for history).
7. Render task: given an approved script, call POST /v3/videos with spoken_text, the brand's chosen engine, 1080p, vertical, and callback_id = our video id. Save heygen_video_id. Plan-slot reservation is a stub until Phase 7. After each successful render, update brands.words_per_second from the real duration (rolling average of the last 10), so script lengths get more accurate over time.
8. /api/webhooks/heygen: verify the signature on the raw body, store the event, ignore duplicates; on success, download the MP4 to Storage at once; on failure, save the reason. Add a polling backup (every 30 s for up to 30 min), a cap of 10 renders at once, and Retry-After handling on 429.
9. A one-time script that creates the HeyGen webhook endpoint. Tell me to paste the secret into .env.local myself.

Work with MOCK_HEYGEN=true until I approve real renders.
```

**Done when:**
- A clip with bad light or two faces gets clear reshoot tips; a good clip passes.
- Admin approval creates the twin, and the HeyGen consent link arrives by email.
- The likeness test shows each engine side by side, and you can pick the most realistic one.
- One real script renders on the chosen engine and the raw MP4 plays from Storage.
- Webhook events appear once each, even when HeyGen sends one twice.

**Common fixes:** 401 → wrong HEYGEN_API_KEY. download_failed → the clip URL must be signed and point straight at the file. invalid_parameter on engine → the look doesn't list that engine. Webhooks don't arrive on localhost → use polling locally or test on the Vercel preview.

---

## Phase 4: The editor

```
PHASE 4: The editor. Read CLAUDE.md, docs/PRODUCT.md (Video formats) and docs/QA-SPEC.md (Gate 4).

1. Speech-to-text: compare APIs that support English, Urdu and Hindi with word-level timings (for example ElevenLabs Scribe, Deepgram, AssemblyAI and OpenAI transcription). Show me a short table of price per minute, language support and word-timing quality, recommend one, and wait for my OK before I sign up. Then build lib/stt.ts with a MOCK_STT mode.
2. The edit task in Trigger.dev (ffmpeg build extension, 2 GB RAM or more). Inputs: the raw MP4, the transcript, the script's display_text and edit_plan, the brand colour, the caption style, ai_label and watermark.
3. Scale and crop to 1080x1920 at 30 fps.
4. Captions: word timings from the speech-to-text transcript, text from display_text (aligned word by word). 3 styles (big words as the default, small box, minimal), at most 2 lines, inside the safe zone. Bundle the font files in the project.
5. B-roll: 2 to 4 vertical Pexels clips chosen from broll_keywords, cut in at edit_plan moments for 1.5 to 3 s while the voice keeps playing. Keep the face on screen for the hook and the call to action. Respect the format coverage limits (talking 25% or less, story 60% or less).
6. Music: a small royalty-free set in Storage, ducked under the voice; normalise the final mix to -14 LUFS with a true peak of -1 dBTP or lower.
7. The "AI-generated" label when ai_label is on; a watermark only for trial videos. Export with +faststart.
8. Keep the ffmpeg command builder in lib/edit.ts with unit tests for the filter strings.

Show me before and after files from the fixture video.
```

**Done when:**
- The final video is 1080x1920 and plays on your phone.
- The captions follow the voice word by word and never cover the mouth.
- B-roll appears while the voice keeps going, and the face is on screen for the hook and the CTA.
- The music is clearly quieter than the voice.
- The AI label shows when the toggle is on and disappears when it's off.

**Common fixes:** the task is killed for memory → use a bigger Trigger.dev machine. Captions drift → use the speech-to-text timings, not estimates. Font errors → bundle the font file.

---

## Phase 5: QA engine

```
PHASE 5: QA engine. Read docs/QA-SPEC.md in full before writing code.

1. A pipeline orchestrator that runs the gates in order and moves posts through the statuses in docs/PRODUCT.md. Every gate writes qa_reports. Thresholds live only in lib/qa/config.ts.
2. Gate 3, Audio and pronunciation QA (after render, before edit): reuse the Phase 4 transcription, then normalise, align, WER, key-term check (Claude FAST for spelling variants), audio health. On fail: fix the dictionary respelling, regenerate spoken_text, re-render once, then the team queue.
3. Gate 4, Technical QA (after edit), with ffprobe and ffmpeg filters, as specified.
4. Gate 5, Visual and realism QA: sample frames as specified, Claude (MAIN) with image input and the JSON rubric, realism_score. On fail: re-edit or re-render once, then the team queue.
5. The usage rule: QA failures and our re-renders never count against the plan. Mark videos.counts_toward_plan correctly.
6. Gate 6 in admin → QA queue: a video player, the reason it is in the queue, the gate reports, and a one-tap checklist (pronunciation, lip-sync, looks real, captions, b-roll, music, label). Approve or Reject with a reason. Apply the docs/QA-SPEC.md rules for which videos need human review.
7. Admin → Usage and spend → Quality: the metrics table from docs/QA-SPEC.md.
8. Calibration: after the first 10 real videos, show me each gate's scores and propose threshold changes. Don't change thresholds until I agree.
9. Tests: a pipeline test with mocks, including a forced failure at every gate.

Ask me before any real render or speech-to-text call.
```

**Done when:**
- A script with a mispronounced name is caught by Gate 3, fixed with a respelling and re-rendered once automatically.
- A video with captions over the mouth fails Gate 5 and is fixed automatically.
- A forced double failure lands in the QA queue, not with the customer, and doesn't count against the plan.
- The first 5 videos of a new brand always go to the QA queue.
- The Quality page shows pass rates per gate.

**Engine complete.** Run your done-for-you clients through the admin area for a few weeks before Phase 6. Note which steps still take your time; they are what Phases 6 to 8 automate.

---

## Phase 6: Customer app (keep it simple)

```
PHASE 6: Customer app. Read docs/PRODUCT.md "Simplicity rules" and "Customer app: 5 screens" first. Follow them strictly.

1. Public sign-up and login. Onboarding reuses the Phase 2 form as a wizard: one question per screen, a progress bar, save and continue later, 10 minutes or less.
2. Self-serve consent and recording: the recording guide, the 3 words with a timer, recorder or upload (warn against WhatsApp-compressed files), automatic clip checks with plain reshoot tips. Admin approval stays.
3. Exactly 5 screens: Home, Calendar, Review, Library, Settings, as specified. One main button per screen.
4. Review: player, caption, Approve, Redo (one reason from the list in docs/QA-SPEC.md), Skip. Script review only when the autopilot level asks for it.
5. Library: download MP4, copy the caption per network, add to calendar (.ics), mark as posted.
6. Show customers only the status words in docs/PRODUCT.md and plain error messages. Technical details stay in admin.
7. Check every screen at 375 px wide.
```

**Done when:**
- A new user can go from sign-up to "consent submitted" in under 15 minutes on a phone.
- There are no more than 5 screens, and none of them shows credits, engines or technical errors.
- Approve moves a video to the Library, and Redo asks for one reason.
- Download, Copy caption and the .ics reminder all work on your phone.

---

## Phase 7: Plans and billing

```
PHASE 7: Plans and billing. Read docs/PRODUCT.md "Plans" and "Usage rules".

1. lib/plans.ts: Creator, Pro and Agency, with every limit in one place (keep the temporary values; I will set prices later).
2. Usage ledger as Postgres functions called via rpc with row locks: reserve a slot when the render starts, confirm it on delivery, release it on failure; reset on period start; no rollover. Unit tests, including two renders at once and the free-redo rule.
3. Script writing and QA enforce max_seconds_per_video. The Agency plan allows several brands, each with its own consent and twin.
4. Lemon Squeezy: tell me exactly which 3 subscription products to create and wait while I create them. Checkout with the user id in custom data, a customer portal link, and /api/webhooks/lemonsqueezy (verify X-Signature on the raw body, store, ignore duplicates) for subscription created, updated, payment success, cancelled and expired.
5. Manual payments: admin → Payments → "Mark as paid" (method, reference, amount, plan, period). It writes manual_payments, sets the plan, and sends a receipt email.
6. Free trial, as in docs/PRODUCT.md: brand profile, 30-day plan, 3 scripts, one watermarked 20-second preview with a HeyGen stock avatar. No twin before a paid plan.
7. The Settings → Plan screen: plan name, "7 of 10 videos left this month", renewal date, one button.

Use Lemon Squeezy test mode and give me the test card steps.
```

**Done when:**
- A test checkout for Creator sets the plan and shows the right number of videos.
- A delivered video uses one slot; a failed one gives it back; a QA re-render uses nothing.
- At zero videos left, the customer sees the plain message and the Upgrade button.
- "Mark as paid" activates a plan without a card.
- A trial user gets scripts and a stock-avatar preview, but no twin.

---

## Phase 8: Autopilot

```
PHASE 8: Autopilot. Read docs/PRODUCT.md "Pipeline and statuses" and "Autopilot levels".

1. Trigger.dev scheduled tasks:
   - Monthly planner: on the 1st, or on each brand's renewal, plan the next 4 weeks with the Batch API (PLANNER model).
   - Daily scriptwriter: each morning, write and QA scripts for posts in the next 7 days that don't have one.
   - Render dispatcher: send approved scripts to render, respecting plan slots, the 10-render cap and pause switches.
   - Post-time reminder: email "Your reel is ready to post" at the planned time.
   - Stuck-job sweeper: anything stuck for more than 60 minutes is retried once, then sent to the QA queue.
2. Autopilot levels per brand: Review everything, Review videos only, Full autopilot (auto-approve after 24 h). Managed brands keep operator review.
3. Emails (Resend): Needs you, Ready, Taking longer, Low videos left, Renewal. Each email has a WhatsApp click-to-chat support link (WHATSAPP_NUMBER).
4. Safety: the global renders_paused switch, a per-brand pause, and daily spend caps (HeyGen and Claude) that email the admin and pause renders when they are hit.
5. Admin → Usage and spend: daily HeyGen seconds and cost by engine, Claude cost by task, speech-to-text cost, and cost per delivered video.
```

**Done when:**
- A brand on Full autopilot gets a planned, scripted, rendered, QA'd video in Ready without anyone clicking.
- Turning on renders_paused stops new renders straight away.
- Hitting a low test spend cap pauses renders and emails you.
- The spend page shows the cost per delivered video.

---

## Phase 9: Landing page and launch

```
PHASE 9: Landing page and launch. Read docs/PRODUCT.md "Landing page" and docs/QA-SPEC.md "Software QA".

1. The landing page exactly as specified: one page, 7 sections, no animations, a fast load. The demo reel comes from Storage (I'll upload my own).
2. Terms, Privacy, and AI and consent pages in plain words (videos are AI-generated; a twin needs the person's consent; delete anytime).
3. Settings → Account: export my data, and delete my account (deletes Storage files, deletes the avatar at HeyGen, removes rows, and cancels the subscription through the Lemon Squeezy API).
4. The full QA pass from docs/QA-SPEC.md: Playwright end-to-end suite on staging, RLS cross-account tests, a scan for secrets in the browser bundle, webhook replay tests, a mock load test with 20 videos at once, and Lighthouse 90+ on the landing page.
5. Production: Vercel, Trigger.dev deploy and the production Supabase project. List every env var I must add and wait. Point the HeyGen and Lemon Squeezy webhooks at the production URLs.
6. One real video end to end on production, from a fresh account.
7. BETA.md: steps for 10 beta users and a 5-question feedback form.

Update the CLAUDE.md status.
```

**Done when:**
- The landing page loads fast on a phone and has exactly one button per section.
- Deleting an account removes the twin and the files.
- The release checklist in docs/QA-SPEC.md passes.
- 10 beta users are invited.

---

## When you're stuck, paste this

```
I am stuck. Do not guess and do not start rewriting things.
1. Read CLAUDE.md and the last 3 git commits.
2. Here is exactly what I did and what I see: [describe the click, paste the error text or a screenshot. NEVER paste keys]
3. Find the root cause first. Show me the 1 to 3 most likely causes in plain words and how you will check each.
4. Check the official docs for any API involved (HeyGen llms.txt, Anthropic, Supabase, Trigger.dev, Lemon Squeezy, our speech-to-text provider) before changing code.
5. Make the smallest fix, run lint, typecheck and tests, and tell me how to confirm it works.
6. If the fix fails twice, stop, roll back to the last working commit with git, and explain my options.
7. Never print or ask for my secret keys. If a key might be wrong, tell me which env var to re-check myself.
```

## Once a month, paste this

```
Monthly API check. Read https://developers.heygen.com/llms.txt, the Anthropic models and deprecations pages, and the changelogs for Trigger.dev, Supabase, Lemon Squeezy and our speech-to-text provider. List anything deprecated, renamed or repriced that affects our code or our cost per video, and propose fixes. Change nothing until I agree.
```
