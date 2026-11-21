# CLAUDE.md

Next.js version rules (read before writing Next.js code): @AGENTS.md

## What this app is
A done-for-you plus self-serve tool for creators who don't want to film. They record one clip once; HeyGen makes a realistic digital twin; Claude plans, writes and checks; we deliver finished 9:16 reels that pass a full QA pipeline.

Full spec: `docs/PRODUCT.md`. Quality rules: `docs/QA-SPEC.md`. Client recording guide: `docs/RECORDING-GUIDE.md`. Read the relevant one before working on a feature.

## Owner
Non-coder on Windows (PowerShell). Explain every step in one plain sentence. When the owner must do something (sign up, click, paste a key), say exactly what to do and wait. **Ask before anything that spends money**: paid plans, real HeyGen renders, speech-to-text calls, Claude calls in loops or evals.

## Stack
Next.js App Router + TypeScript + Tailwind + shadcn/ui on Vercel. Supabase (Postgres, Auth, Storage, Row Level Security on every table). Trigger.dev v4 for background jobs, with the ffmpeg build extension (2 GB RAM or more for edits). Anthropic TypeScript SDK. HeyGen API v3 only. One speech-to-text API (chosen in Phase 4). Pexels. Lemon Squeezy plus manual payments. Resend.

## Claude API rules
- Models come from env: MAIN `claude-sonnet-5-5`, PLANNER `claude-opus-5-5`, FAST `claude-haiku-5-5`.
- Never send `thinking: {type: "disabled"}` or `budget_tokens` to Sonnet 5.5 or Opus 5.5; both return a 400. Leave thinking at its default.
- Set `output_config.effort` explicitly on every call (start: medium for scripts and plans, low for FAST tasks). Opus 5.5 defaults to medium; Sonnet 5.5 defaults to high.
- Do not set `temperature`, `top_p` or `top_k`. Do not prefill the assistant message. Both return a 400.
- Do not force tool use (`tool_choice` any/tool), which returns a 400 on these models. For JSON, use the SDK's structured outputs (`output_config.format` with a zod schema). Read the SDK docs for the exact helper; do not guess.
- Check `stop_reason` before reading content. Handle `"refusal"` with a plain error. Stable Messages API only (no beta server-side fallbacks for now); if MAIN or PLANNER is still overloaded (529) after retries, `lib/claude.ts` makes one FAST call and logs it as `<task>:fallback_fast`.
- Stream long outputs (monthly plans) and use the SDK's final-message helper.
- Put the brand profile in a cached system block (prompt caching). Use the Batch API for scheduled monthly planning.
- Log tokens and cost for every call to `ai_usage`. Keep every prompt as a file in `/prompts`.

## HeyGen rules
- v3 only. Base `https://api.heygen.com`, header `X-Api-Key`. Read `https://developers.heygen.com/llms.txt` before touching HeyGen code, and never guess field names.
- No twin before admin approval of the consent clip. No render with a customer's twin before HeyGen consent_status is accepted. (Trial previews use a HeyGen stock avatar and are exempt.)
- Use the engine saved on the brand from the likeness test (the most realistic one). Never fall back to a lower-quality engine without asking the owner.
- Send `spoken_text` to HeyGen, never `display_text`.
- Webhooks: verify the signature on the raw body, store in `webhook_events`, ignore duplicates. Polling is the backup. Download the video at once (URLs expire).
- At most 10 renders at once. On a 429, wait for Retry-After.
- All HeyGen calls live in `lib/heygen.ts` only.

## QA rules (details in docs/QA-SPEC.md)
- Gates in order: Script QA → Pronunciation prep → render → Audio and pronunciation QA → edit → Technical QA → Visual and realism QA → Human review (when required) → customer.
- Customers only see videos that passed. One automatic fix per gate, then the team queue.
- Our failures never count against the customer's plan.
- Thresholds live only in `lib/qa/config.ts`. Every gate writes `qa_reports`.

## Next.js 16 and database rules (learned in Phase 1)
- Next.js 16.4 with Cache Components on. Middleware is `proxy.ts`. Anything that reads cookies, headers or searchParams must sit inside `<Suspense>`; read the bundled docs in `node_modules/next/dist/docs/` first.
- Auth: `lib/auth.ts` (`getCurrentUser`, `requireUser`, `requireAdmin`). Check permissions in every page, Server Action and Route Handler, not only in layouts or the proxy.
- Admin pages use `components/admin/admin-page.tsx`; load admin data inside its children.
- Database: customers can only READ their own rows (RLS). All writes go through server code using `lib/supabase/admin.ts` (secret key) after a permission check. New tables need RLS, an explicit grant, and a test in `tests/db/rls.test.ts`.
- Migrations live in `supabase/migrations/`; `npm test` runs them against an in-memory Postgres.

## Plan and usage rules
- Three plans: Creator, Pro, Agency. All limits live only in `lib/plans.ts` (prices TBD).
- A video counts only when delivered. Reserve a slot when the render starts; confirm it on delivery; release it on failure.
- Usage changes go through `usage_ledger` only, using Postgres functions called via `rpc` with row locks (supabase-js cannot run transactions).

## Simplicity rules
5 customer screens. One main button per screen. Plain words: never show credits, seconds math, engines or technical errors to customers. Mobile first (375 px). See docs/PRODUCT.md.

## Money-safety and mock mode
- `MOCK_HEYGEN=true` and `MOCK_STT=true` in local development: return fixture files from `tests/fixtures/` and spend nothing.
- `MOCK_CLAUDE=true` too: `lib/claude.ts` returns sample answers from `lib/claude-mocks.ts`, builds no client and calls nothing. All three switches mean "mock" unless set to exactly `false` (`lib/config.ts`).
- Real renders happen only when the owner says yes, and only on staging or production.
- Pause switches (`app_settings`): `renders_paused` (global) and `brands.paused`. Daily spend caps email the admin and pause renders.

## Commands
- Bundle secret scan: `npm run build` then `npm run test:bundle` (fails without a build). `npm test` also scans `.next/static` when it exists.
- `npm run dev` | `npm run lint` | `npm run typecheck` | `npm test` | `npm run test:e2e` (Phase 9) | `npm run eval:scripts` (golden set; mock by default, live only when `MOCK_CLAUDE=false`, which costs cents, so ask first)
- `npm run trigger:dev` (local jobs) | `npm run trigger:deploy` (production jobs)
- `npm run db:push` (migrations; needs `npx supabase login` and `npx supabase link` once)
- `npm run test:staging` (opt-in, real STAGING Supabase, only with `RUN_STAGING_TESTS=1`; see Status). Tests never reach the network otherwise (`tests/setup/no-network.ts`).

## Coding rules
- Small steps. After each step: lint, typecheck and tests; explain the change in plain words; give the owner 3 things to click; commit with a clear message.
- No secrets in code, logs, screenshots or chat. `.env.local` is never committed. API keys are used in server code only.
- Every external call has a timeout, retry with backoff, and a clear error saved on the row.
- Simple code a beginner can follow. Few libraries.
- If unsure about an API, read its docs first.

## Status (update at the end of every session)
- Phase: 3 (the face), branch `phase-3-twin`. **Part A (items 1-5) done in mock mode, QA PASS (`logs/qa-phase3a-20261122-0254.md`). Part B step 1 (session p3-b1: QA SF1-SF6, spend guard, Rowan's decisions 1-7, opt-in staging test) done.** Part B step 2 (items 6-9: likeness test, render task, webhooks, webhook script) NOT started. Phase 2 passed QA (`logs/qa-phase2b-r2-20261122-0148.md`).
- Done (Phase 3 part B step 1): every test runs with `globalThis.fetch` replaced by a thrower (`tests/setup/no-network.ts`, vitest `setupFiles`); create-twin claim `avatars.create_started_at` (no second paid twin on retry; HeyGen documents no idempotency key that we found); poll errors saved (redacted) to `avatars.error`; confirm re-checks the words window (2-min grace, Supabase upload tokens last 2 h and take no expiry); clip checks bound to `clip_path`; Retry-After honoured up to 15 min (pages 30 s), above that a plain retry-later error; **HeyGen spend guard** `lib/heygen-spend.ts` (`renders_paused`, `app_settings.heygen_daily_caps` per Asia/Karachi day, `provider_usage` rows reserved → succeeded/failed, rpc `reserve_heygen_spend`; render in step 2 MUST go through `withHeygenSpend`). Decisions: `trigger.config.ts` ffmpeg extension + `react-server` condition; clip checks in `trigger/check-clip.ts` (`runClipCheckJob`, `consents.clip_check_status`; inline only without a Trigger key); `voice_id`/`default_voice_id` both read, `HEYGEN_VIDEO_RESOLUTION = "1080p"`; 50 MB cap (browser + prepare + confirm, bucket `file_size_limit`) in `lib/consent-upload-rules.ts`; `.mov` allowed and converted to mp4 in the check; consent link → client (`brands.contact_email`, set on the start-consent form) + admin copies, reshoot tips → admins only. Details: `docs/HEYGEN-NOTES.md` (e).
- Staging test (opt-in, Rowan only, after `npm run db:push` to STAGING): `RUN_STAGING_TESTS=1 STAGING_BRAND_ID=<test brand id> npm run test:staging`. Runs `tests/staging/*.staging.test.ts` against real staging Supabase, creates and deletes one consent/avatar/outbox row. Never part of `npm test`; never against production.
- Done (Phase 3 part A): `lib/heygen.ts` (all HeyGen calls; v3; mock answers from `tests/fixtures/heygen/*.json` through the same parsers, never fetch; timeout, GET retry with backoff, Retry-After on 429, POSTs not retried except 429; `HeygenError` plain messages); admin-only `GET /api/admin/heygen-check` (users/me; Settings → "Check HeyGen"). Consent: `lib/consent-words.ts` (3 server words, 30 min), `lib/consent-flow.ts` (start, new words, signed upload into the private `consent-clips` bucket, server size/type checks on request AND on the stored file, mp4/webm ≤ 200 MB, 5-min signed playback, approve/reject; approve is the only place an avatar row starts and needs passing clip checks). Clip checks: `lib/clip-checks/media.ts` (ffprobe/ffmpeg via execFile, no shell), `evaluate.ts` (plain tips from RECORDING-GUIDE), `run.ts`; face check = Claude task `clip_face_check` (images in `ClaudeContext.images`, prompt `prompts/clip-face-check.md`; mock answer from `tests/fixtures/<clip>.vision.json`). Thresholds: `CLIP_CHECKS` in `lib/qa/config.ts`. Twin: `lib/twin.ts` (`createTwin` refuses unless consent approved; upload → twin → HeyGen consent → consent-link "email"; `pollTwinUntilReady` bounded 60 s → 30 min, saves look id, voice id, `supported_engines`, status → `likeness_test`); thin tasks `trigger/create-twin.ts` (idempotency key = consent id, global) and `trigger/poll-twin.ts`. Emails are never sent: `email_outbox` table (server only, status always `mocked`). Pages: Admin → client → "Consent clip and twin", `/admin/consents`, `/admin/consents/[id]`. Store: `lib/consent-store.ts`; tests use `tests/helpers/consent-memory.ts`. Fixtures: `npm run fixtures` (`scripts/make-fixtures.sh`). HeyGen doc findings with sources: `docs/HEYGEN-NOTES.md` (text field is `script`; no sandbox; one glossary per workspace).
- Phase 2 summary (A/B1): MOCK_CLAUDE switch; onboarding form (`components/onboarding/brand-form.tsx`, `lib/brand-input.ts`) + New client; `lib/claude.ts` (only entry `runClaudeTask`, stable API, one FAST fallback on 529, mocks in `lib/claude-mocks.ts`, prompts in `/prompts`); brand profile + versions (`save_brand_version` rpc); `lib/plans.ts`; `lib/posting-times.ts`; `lib/planner.ts` + "Plan next 4 weeks"; `lib/scripts.ts` + "Write script"; bundle secret scan; plain admin errors (`PlainError`).
- Done (B2): Gate 1 = `lib/qa/script-checks.ts` (our checks + Claude rubric; voice is soft) and `lib/qa/script-pipeline.ts` (`runScriptChecks`: Gate 1 with one rewrite → Gate 2; every run writes `qa_reports`). Thresholds in `lib/qa/config.ts`. Post after passing: managed or "review everything" → `script_review`, else `approved`. Failing twice: managed → `team_review`, self-serve → `needs_you` (plain `status_reason`). Gate 2 = `lib/pronunciation/normalise.ts` (rules listed at the top of the file), `dictionary.ts` (approved only), `risky-words.ts` + Claude FAST suggestions saved as `suggested`/`qa`. "Write script" runs both gates; "Run checks" re-runs them. Admin → client → "How to say names" (`/admin/clients/[id]/names`). DB writes go through `lib/qa/store.ts`; tests use `tests/helpers/memory-store.ts`. Mock failing drafts: `runClaudeTask(..., { mockScenario })`. Golden set: `tests/golden/` (5 brands) + sample snapshot `tests/golden/__snapshots__/sample-mock-script.json`. HeyGen glossary finding: `docs/HEYGEN-NOTES.md`.
- Fix pass p2-fix (after QA FAIL `logs/qa-phase2b-20261122-0126.md`): a throwing Gate 1 rewrite leaves v1 `pending`; "Run checks" page button and `checkScript` share `lib/qa/can-run-checks.ts`; action errors saved to `posts.status_reason` (`savePostProblem`); `logAdminError` logs the redacted cause chain; `getPost` rejects non-UUIDs; Friday prayer shift only PK + GCC (`JUMUAH_COUNTRIES`); posting times labelled "defaults, pending review before launch".
- In progress: nothing.
- Next: QA review of part B step 1; then part B step 2 (likeness test — ASK before any render; render task sends our `spoken_text` into HeyGen's `script` with `resolution: HEYGEN_VIDEO_RESOLUTION`, through `withHeygenSpend({ kind: "render" })`; webhooks; webhook setup script; one shared workspace Brand Glossary).
- Phase 3 open items: first Trigger.dev deploy must confirm the `react-server` condition does not break other packages, and that `@/` paths resolve in tasks; fields marked UNCONFIRMED in `lib/heygen.ts` (users/me fields, consent `url` position) must be checked on the first real call; Context7 was unavailable in p3-b1, so HeyGen idempotency/voice/resolution findings rest on part A notes (re-check llms.txt); an admin "I checked HeyGen, create again" reset for a stuck SF2 claim does not exist yet (clear `avatars.create_started_at` by hand after checking HeyGen).
- Known issues / deferred: Phase 6: customers must see plain customer wording for `posts.status_reason` (today it holds admin wording like "Press Run checks"), or nothing while a post is in `scripting`; brand handover to the customer (Phase 6); one-question-per-screen onboarding wizard (Phase 6); /prompts folder in the Trigger.dev build (Phase 8); "Write script" runs the writer and both gates in one Server Action (move to a Trigger.dev task in Phase 8); QA SHOULD FIX 4 (non-admin 404 test) parked until .env.local exists; Claude price estimates in `lib/ai-prices.ts` still to be checked by Rowan; live checks blocked on the Supabase and Anthropic keys; `eval:scripts` never run live (needs Sunny/Zee OK).
- QA thresholds last calibrated: never.
