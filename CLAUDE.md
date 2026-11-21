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

## Coding rules
- Small steps. After each step: lint, typecheck and tests; explain the change in plain words; give the owner 3 things to click; commit with a clear message.
- No secrets in code, logs, screenshots or chat. `.env.local` is never committed. API keys are used in server code only.
- Every external call has a timeout, retry with backoff, and a clear error saved on the row.
- Simple code a beginner can follow. Few libraries.
- If unsure about an API, read its docs first.

## Status (update at the end of every session)
- Phase: 2 (the brain), branch `phase-2-brain`. **Phase 2 code done in mock mode** (parts A, B1, B2). Waiting for QA review and live checks.
- Done (A/B1): MOCK_CLAUDE switch; onboarding form (`components/onboarding/brand-form.tsx`, `lib/brand-input.ts`) + New client; `lib/claude.ts` (only entry `runClaudeTask`, stable API, one FAST fallback on 529, mocks in `lib/claude-mocks.ts`, prompts in `/prompts`); brand profile + versions (`save_brand_version` rpc); `lib/plans.ts`; `lib/posting-times.ts`; `lib/planner.ts` + "Plan next 4 weeks"; `lib/scripts.ts` + "Write script"; bundle secret scan; plain admin errors (`PlainError`).
- Done (B2): Gate 1 = `lib/qa/script-checks.ts` (our checks + Claude rubric; voice is soft) and `lib/qa/script-pipeline.ts` (`runScriptChecks`: Gate 1 with one rewrite → Gate 2; every run writes `qa_reports`). Thresholds in `lib/qa/config.ts`. Post after passing: managed or "review everything" → `script_review`, else `approved`. Failing twice: managed → `team_review`, self-serve → `needs_you` (plain `status_reason`). Gate 2 = `lib/pronunciation/normalise.ts` (rules listed at the top of the file), `dictionary.ts` (approved only), `risky-words.ts` + Claude FAST suggestions saved as `suggested`/`qa`. "Write script" runs both gates; "Run checks" re-runs them. Admin → client → "How to say names" (`/admin/clients/[id]/names`). DB writes go through `lib/qa/store.ts`; tests use `tests/helpers/memory-store.ts`. Mock failing drafts: `runClaudeTask(..., { mockScenario })`. Golden set: `tests/golden/` (5 brands) + sample snapshot `tests/golden/__snapshots__/sample-mock-script.json`. HeyGen glossary finding: `docs/HEYGEN-NOTES.md`.
- Fix pass p2-fix (after QA FAIL `logs/qa-phase2b-20261122-0126.md`): a throwing Gate 1 rewrite leaves v1 `pending`; "Run checks" page button and `checkScript` share `lib/qa/can-run-checks.ts`; action errors saved to `posts.status_reason` (`savePostProblem`); `logAdminError` logs the redacted cause chain; `getPost` rejects non-UUIDs; Friday prayer shift only PK + GCC (`JUMUAH_COUNTRIES`); posting times labelled "defaults, pending review before launch".
- In progress: nothing.
- Parked for Phase 3: which HeyGen v3 field carries the spoken words (`script` vs our `spoken_text`; check llms.txt); Brand Glossary plan: one glossary per brand if HeyGen allows, else one shared glossary with per-brand terms.
- Next: QA re-review of `phase-2-brain`; then live checks once keys exist (one real script with its QA report; eval:scripts live with OK); then Phase 3 (wire the HeyGen Brand Glossary, see docs/HEYGEN-NOTES.md).
- Known issues / deferred: Phase 6: customers must see plain customer wording for `posts.status_reason` (today it holds admin wording like "Press Run checks"), or nothing while a post is in `scripting`; brand handover to the customer (Phase 6); one-question-per-screen onboarding wizard (Phase 6); /prompts folder in the Trigger.dev build (Phase 8); "Write script" runs the writer and both gates in one Server Action (move to a Trigger.dev task in Phase 8); QA SHOULD FIX 4 (non-admin 404 test) parked until .env.local exists; Claude price estimates in `lib/ai-prices.ts` still to be checked by Rowan; live checks blocked on the Supabase and Anthropic keys; `eval:scripts` never run live (needs Sunny/Zee OK).
- QA thresholds last calibrated: never.
