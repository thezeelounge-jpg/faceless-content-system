# Product spec

Claude Code: read this before building any feature. If something here conflicts with a prompt, ask the owner.

## In one sentence

A creator records one clip, once. We turn it into a realistic digital twin and deliver finished, quality-checked short videos every week, written in their own voice, so they never have to film or edit again.

## Who it is for

- Experts who are shy on camera: coaches, consultants, doctors, freelancers, real-estate agents
- Busy founders and professionals with no time to film
- Creators who cannot pay for a studio, videographer or editor

First markets: Pakistan and the Gulf (English, Roman Urdu, Hinglish). Then everywhere.

## What we promise

1. **It looks and sounds like you.** A realistic twin, checked before every delivery.
2. **It sounds like you wrote it.** Scripts learn from your own writing.
3. **No filming, no editing.** Finished reels with captions, b-roll and music.
4. **Nothing goes out unchecked.** Every video passes our quality checks (docs/QA-SPEC.md).

## How we're different (use these points in website copy)

Competitors such as Brandios (see docs/COMPETITOR-NOTES.md) sell similar autopilot twins. Our differences:

- **Your real room, not a fake studio.** The twin is filmed where you actually work, so it looks like your normal videos.
- **Checked before you see it.** Pronunciation, lip-sync, captions and realism are checked on every video. Competitors leave quality checking to the customer.
- **One simple count.** "10 videos, each up to 60 seconds." No 15-second units, no 720p vs Full HD trade-off, no separate counts for pictures, remakes and packs.
- **The best look for everyone.** Every plan gets 1080p and the most realistic engine.
- **Honest by default.** An "AI-generated" label is on every video unless you turn it off.
- **Built for Pakistan and the Gulf.** Roman Urdu and Hinglish scripts, local posting times, local payments, and a done-for-you option.

## Simplicity rules (apply to every screen)

- One main button per screen.
- Plain words only. Customers never see: credits, seconds math, engines, tokens, webhooks, render, API.
- Show usage as "7 of 10 videos left this month".
- The customer app has 5 screens. No more.
- No animations, sliders, pop-ups, chat widgets, feature grids or dark patterns.
- Mobile first. Everything must work one-handed on a phone (test at 375 px wide).
- Errors are one plain sentence plus one next step. Technical details appear only in admin.
- Onboarding takes 10 minutes or less, one question per screen, and can be paused and resumed.
- One offer at a time. No stacked discounts, countdown timers or "spots left" counters.
- One video quality for everyone. Never trade quality for a higher video count.
- Users never pick posting hours. We use built-in best times (see Planning rules); changing them is optional, in Settings.

## Landing page (one page, nothing else)

1. **Hero:** headline "Post every week without filming every week." One sub-line naming who it's for (doctors, coaches, consultants, founders, real-estate agents). One button: "Start free".
2. **Demo:** one real reel made with the owner's own twin, with a small "Made with AI" note. Beside it, a static "your week" card: 5 posts with Ready and Needs you labels.
3. **How it works:** (1) Record one clip. (2) Approve your plan. (3) Get finished reels every week.
4. **Cost comparison:** one small table of what a videographer, editor and scriptwriter cost per month in Pakistan and the Gulf, against our plan. Fill in real local numbers before launch.
5. **Plans:** three cards (Creator, Pro, Agency): name, price, videos per month, max length, one button each.
6. **Trust:** nothing with your face goes out without your OK; every video is checked for pronunciation, lip-sync and captions before you see it; an AI label on every video; you own your videos; delete everything anytime; cancel anytime.
7. **FAQ (5 questions):** Will it look like me? Is it safe and legal? Which languages? What if I don't like a video? Can I cancel or get a refund?
8. **Footer:** Terms, Privacy, AI and consent, contact (WhatsApp link and email).

## Customer app: 5 screens

1. **Home:** "Needs you" list at the top, this week's posts with their status, "videos left this month".
2. **Calendar:** month view of planned posts. Tap a post to read its script or move its date.
3. **Review:** video player and caption. Buttons: Approve, Redo (pick a reason), Skip.
4. **Library:** ready videos. Download, Copy caption (per network), Add to my calendar (.ics), Mark as posted.
5. **Settings:** Brand (profile, topics, "How to say names"), Autopilot level, Plan and billing, Account (export data, delete account).

## Admin (operator) area

Clients, Consents and twins, Scripts, QA queue, Videos, Usage and spend, Payments, Settings (pause switches, QA thresholds view).

The admin area is built first (Phases 1 to 5). The owner uses it to run the done-for-you service before customers can sign up.

## Plans (prices decided later)

Three plans: **Creator, Pro, Agency.** Every value lives in one file, `lib/plans.ts`, so changing pricing is a one-file edit.

| Setting | Creator | Pro | Agency |
|---|---|---|---|
| videos_per_month | TBD | TBD | TBD |
| max_seconds_per_video | TBD | TBD | TBD |
| brands (each with its own twin) | 1 | 1 | TBD (several) |
| free_redos_per_video | TBD | TBD | TBD |
| price_usd / price_pkr | TBD | TBD | TBD |

**Temporary values for building and testing only** (replace after the pricing discussion): Creator 8 videos up to 45 s; Pro 16 videos up to 60 s; Agency 40 videos up to 60 s across up to 5 brands; 1 free redo per video.

Every plan uses the most realistic HeyGen engine the twin supports, picked in the likeness test (Phase 3). We never sell a lower-quality look.

Included in every plan, because they cost us very little: the monthly content plan, script rewrites before a video is made (fair use: 20 a day), captions for Instagram, TikTok, LinkedIn and X, and hashtags.

### Usage rules

- A video counts toward the plan only when it is **delivered** to the customer, after passing QA.
- QA failures, our errors and re-renders we trigger **never** count.
- Customer "Redo": the first `free_redos_per_video` are free. After that, a redo counts as a new video.
- Scripts are written to fit `max_seconds_per_video`. A script that is too long is rejected before the video is made.
- Videos reset on the billing date. Unused videos do not roll over.
- At zero left, show: "You've used all 10 videos this month. They renew on 12 Dec." and one button: "Upgrade".
- **Free trial = the brain, not the face:** brand profile, 30-day plan, 3 scripts, and one 20-second preview read by a HeyGen stock avatar (watermarked). No twin is made until a paid plan starts.

## Video formats (v1)

- **Talking reel:** face on screen most of the time. B-roll covers 25% or less.
- **Story reel:** face on screen for the hook and the call to action. B-roll and big captions in between (60% or less).

Both: 9:16 at 1080x1920, word-by-word captions, quiet music, and an "AI-generated" label (on by default, can be turned off per video). Claude picks the format for each post when planning, and the customer can switch it.

## Planning rules

- During onboarding the customer picks posting days, posts per week (1 to 14) and up to 3 audience countries (default: Pakistan).
- Posting times come from `lib/posting-times.ts`: starting values per network and per country, which the owner tunes over time. The customer never has to choose an hour. Settings has an optional override.
- **Friday:** in Pakistan and the GCC (UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman), avoid Jumu'ah prayer time (about 12:30 to 2:30 pm local). Other countries keep their Friday times. The weekend follows each country (Pakistan and UAE: Saturday and Sunday; Saudi Arabia and Qatar: Friday and Saturday).
- **Ramadan:** the admin sets the start and end dates each year in `app_settings`. During Ramadan, shift posts to after iftar and late evening, and lean the plan toward Ramadan-friendly topics.
- Plans run 4 weeks ahead. The daily scriptwriter keeps the next 7 days scripted.

## Pipeline and statuses

| Internal status (posts.status) | What the customer sees |
|---|---|
| planned | Planned |
| scripting | Writing |
| script_review | Needs you (only if the autopilot level asks for script review) |
| approved, rendering, editing | Making your video |
| audio_qa, final_qa, team_review | Checking quality |
| needs_you | Needs you |
| ready | Ready |
| posted | Posted |
| skipped | Skipped |
| problem | Taking a little longer. We're fixing it. |

## Autopilot levels (per brand)

1. **Review everything** (default): approve the script and the video.
2. **Review videos only:** scripts go straight to video.
3. **Full autopilot:** videos are approved automatically after 24 hours if not reviewed.

Done-for-you (managed) brands: the operator reviews; the customer approves finished videos only.

## Data model (Postgres, Row Level Security on every table)

Customers see only their own rows. Admins are listed in ADMIN_EMAILS and checked on the server.

- **profiles**(id = auth uid, email, full_name, role admin|customer, plan, plan_status, period_start, period_end, trial_used, created_at)
- **brands**(id, owner_id, name, niche, audience, offers, tone, sound_answers jsonb, samples text, banned_words text[], language en|roman_urdu|hinglish, pillars jsonb, posting_days int[], posts_per_week int, audience_countries text[], posting_times_override jsonb, autopilot_level, engine, words_per_second numeric default 2.4, is_managed bool, paused bool, profile_md, current_version int, created_at)
- **brand_versions**(id, brand_id, version, profile_md, pillars jsonb, created_at)
- **pronunciations**(id, brand_id, written, say_as, status suggested|approved, source manual|qa, created_at)
- **consents**(id, brand_id, person_legal_name, checkbox_at, words text[], words_expire_at, clip_path, clip_checks jsonb, admin_status pending|approved|rejected, admin_note, heygen_consent_status, heygen_consent_url, ip, user_agent, created_at)
- **avatars**(id, brand_id, consent_id, heygen_group_id, heygen_look_id, voice_id, supported_engines text[], chosen_engine, likeness_test jsonb, status training|consent_pending|likeness_test|ready|reshoot_needed|failed, created_at)
- **posts**(id, brand_id, scheduled_for timestamptz, pillar, title, hook, format talking|story, status, status_reason, created_at)
- **scripts**(id, post_id, version, display_text, spoken_text, hook, body, cta, est_seconds, captions jsonb, hashtags text[], broll_keywords text[], edit_plan jsonb, qa_status, approved_at, created_at)
- **videos**(id, brand_id, script_id, avatar_id, engine, attempt int, heygen_video_id, status, raw_path, transcript jsonb, final_path, duration_s, counts_toward_plan bool, ai_label bool, watermark bool, error, created_at)
- **qa_reports**(id, video_id, script_id, gate script|pronunciation_prep|audio|technical|visual|human|customer, passed bool, score numeric, issues jsonb, auto_fix text, created_at)
- **usage_ledger**(id, owner_id, period_start, delta int, reason reserve|confirm|release|admin, video_id, note, created_at)
- **subscriptions**(id, owner_id, provider lemonsqueezy|manual, external_id, plan, status, renews_at, ends_at)
- **manual_payments**(id, owner_id, method bank|jazzcash|easypaisa|other, reference, amount, currency, plan, period_start, period_end, marked_by, created_at)
- **webhook_events**(id, source heygen|lemonsqueezy, event_key unique, payload jsonb, processed_at)
- **ai_usage**(id, brand_id, task, model, input_tokens, output_tokens, cost_usd, created_at)
- **provider_usage**(id, provider heygen|stt|other, video_id, seconds, cost_usd, created_at)
- **app_settings**(key, value jsonb) for pause switches and spend caps

## Services we use

- **Claude API:** MAIN `claude-sonnet-5-5` (scripts, captions, QA judging, video frame review). PLANNER `claude-opus-5-5` (monthly plans; the Batch API for scheduled runs). FAST `claude-haiku-5-5` (hashtags, b-roll keywords, small checks).
- **HeyGen API v3:** twin, consent, looks, voices, videos, webhooks.
- **Speech-to-text API** (chosen in Phase 4): word timings for captions and pronunciation QA.
- **Pexels** for b-roll. A small royalty-free music set kept in Storage.
- **Lemon Squeezy** for card payments. **Manual payments** (bank, JazzCash, Easypaisa) marked in admin.
- **Resend** for email. **WhatsApp click-to-chat links** (free) for support.

## Not in v1 (likely next, roughly in this order)

1. **Auto-posting** to Instagram, TikTok, LinkedIn and X (start with a publishing service that already has platform approval).
2. **Voice reels:** the cloned voice over b-roll and pictures, with no face. Much cheaper to make; it could power a lower-priced plan. Check whether HeyGen's API can make voice-only audio with the twin's voice.
3. **Weekly learning loop:** read post stats and let Claude adjust next week's topics, hooks and times.
4. **WhatsApp approvals** (Approve or Redo from WhatsApp).
5. **Arabic** for the Gulf market.
6. **Wide 16:9 versions** for LinkedIn and X.

Later still: mobile app, team seats, Urdu-script (Nastaliq) captions, backgrounds and scenes, sound effects, top-up packs.
