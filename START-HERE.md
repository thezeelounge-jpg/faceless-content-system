# Start here: Faceless Content System build kit

This kit replaces the "7-Day Build Kit". It builds the system in two stages:

1. **The engine (Phases 1 to 5):** profile, plan, scripts, twin, render, edit and full QA, run from an admin area. You use it to sell a **done-for-you service** and earn while you build.
2. **The SaaS (Phases 6 to 9):** sign-up, a simple customer app, plans and billing, autopilot and a landing page, all around the same engine.

## What's in the kit

| File | What it is |
|---|---|
| `START-HERE.md` | This guide: order, setup, costs, safety |
| `CLAUDE.md` | Rules Claude Code reads at the start of every session |
| `PROMPTS.md` | One copy-paste prompt per phase, with "Done when" checks |
| `docs/PRODUCT.md` | What we're building: screens, plans, statuses, data model |
| `docs/QA-SPEC.md` | Quality gates: script, pronunciation, audio, edit, visual, human, software tests |
| `docs/RECORDING-GUIDE.md` | What customers read before recording their clip |
| `docs/COMPETITOR-NOTES.md` | Brandios: what we're taking, what we're avoiding, numbers for the pricing discussion |

## Order and rough timing (part-time, with Claude Code)

| Step | Time |
|---|---|
| Setup (below) | 1 day |
| Phases 1 to 5: engine | 3 to 5 weeks |
| Run done-for-you clients through the admin area | 2 to 4 weeks (runs alongside) |
| Phases 6 to 9: SaaS | 4 to 6 weeks |

Pricing: three plans (Creator, Pro, Agency) with a video count and a maximum length. Prices are decided later; until then the code uses temporary values in one file (`lib/plans.ts`).

---

## Setup checklist

1. **Node.js LTS:** nodejs.org → Windows Installer (.msi) → Next on every screen. Check in PowerShell: `node -v`
2. **Git for Windows:** git-scm.com/downloads/win, with the default options. Check: `git --version`
3. **Claude Code:** in PowerShell, run `irm https://claude.ai/install.ps1 | iex`, then open a new window and run `claude --version`.
4. **Project folder:** put the kit files in `C:\Projects\facelessapp`, then run `cd C:\Projects\facelessapp` and then `claude`.
5. **GitHub (free):** create an empty private repo named `facelessapp`. Turn on two-factor login.
6. **Vercel:** sign up with GitHub. Hobby is free while building; switch to Pro ($20/mo) before you take payments.
7. **Supabase:** sign up with GitHub. Create a project in a region close to your users (Mumbai or Singapore). Save the database password in your password manager. Later, create a second project for staging.
8. **Anthropic API key:** console.anthropic.com → add billing, about $10 to $20 of credit, and create a key named `facelessapp`. This is separate from your Claude subscription, which cannot power a product.
9. **HeyGen API:** platform.heygen.com/api-keys → create a key and add credit to the API wallet. This is separate from HeyGen app plans.
10. **Trigger.dev:** sign up on the free plan and create a project.
11. **Pexels API:** pexels.com/api → request a free key.
12. **Resend:** sign up (free tier) and verify your domain.
13. **Domain:** buy one (about $15 a year) for the app and email.
14. **Later:** speech-to-text provider (Phase 4, Claude Code helps you choose); Lemon Squeezy (Phase 7, test mode first; Paddle is the backup).

**Keys go in `.env.local` only.** Claude Code creates `.env.example`. Copy it to `.env.local`, open it in Notepad and paste the real values yourself. Never paste keys into any chat.

```
# .env.example (copy to .env.local, then paste real values yourself in Notepad)
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Supabase (Project Settings > API)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=                 # server only

# Google login (turn on after Google is set up in Supabase Auth > Providers)
NEXT_PUBLIC_GOOGLE_LOGIN=false

# Claude API
ANTHROPIC_API_KEY=
CLAUDE_MODEL_MAIN=claude-sonnet-5-5
CLAUDE_MODEL_PLANNER=claude-opus-5-5
CLAUDE_MODEL_FAST=claude-haiku-5-5

# HeyGen API v3
HEYGEN_API_KEY=
HEYGEN_WEBHOOK_SECRET=

# Background jobs
TRIGGER_SECRET_KEY=

# Speech-to-text (chosen in Phase 4)
STT_PROVIDER=
STT_API_KEY=

# Stock b-roll and email
PEXELS_API_KEY=
RESEND_API_KEY=
EMAIL_FROM="Your App <hello@yourdomain.com>"

# Payments (Phase 7)
LEMONSQUEEZY_API_KEY=
LEMONSQUEEZY_STORE_ID=
LEMONSQUEEZY_WEBHOOK_SECRET=
LS_VARIANT_CREATOR=
LS_VARIANT_PRO=
LS_VARIANT_AGENCY=

# Admin and support
ADMIN_EMAILS=                        # comma-separated
WHATSAPP_NUMBER=                     # digits with country code, for click-to-chat links

# Money safety: keep these true on your laptop
MOCK_HEYGEN=true
MOCK_STT=true
```

---

## Costs while building (estimates)

| Item | Build period | Note |
|---|---|---|
| Claude subscription (Claude Code) | $0 extra | You already pay for it |
| Anthropic API credit | $10 to $20 | Scripts and QA cost cents each |
| HeyGen API wallet | $30 to $50 | Realistic engines cost about 8x the basic one (your earlier document listed about $4.83 a minute for Avatar IV). Covers likeness tests and about 20 test videos |
| Speech-to-text | under $5 | A few cents per video at most |
| Vercel, Supabase, Trigger.dev, Resend, Pexels, GitHub | $0 | Free plans while building |
| Domain | about $15 a year | |
| **At launch** | about $45 a month | Vercel Pro ($20) + Supabase Pro ($25), plus usage |

Mock mode keeps development free: real renders happen only when you say yes.

**Cost per delivered video** (shown in admin from Phase 8) is the number to watch when we set prices. Realistic twins make HeyGen the main cost. Claude, speech-to-text and editing add only cents.

---

## Security checklist

- [ ] Keys live only in `.env.local`, Vercel and Trigger.dev settings. Never in code, chat, screenshots or GitHub.
- [ ] `.env.local` is in `.gitignore`, and GitHub shows no `.env` file.
- [ ] HeyGen, Claude, speech-to-text, Lemon Squeezy and Supabase secret keys are used only in server code.
- [ ] Row Level Security is on for every table. A second test account cannot see the first account's data.
- [ ] Every webhook checks its signature and ignores repeats.
- [ ] /admin is checked on the server, not just hidden in the menu.
- [ ] Consent clips are in a private bucket and opened only with short signed links.
- [ ] No twin without admin approval; no render before HeyGen consent is accepted.
- [ ] Spend alerts are set: Anthropic Console limit, small HeyGen wallet top-ups, Trigger.dev usage alerts, plus the app's own daily caps.
- [ ] Two-factor login is on for GitHub, Vercel, Supabase, HeyGen, Anthropic, Trigger.dev and Lemon Squeezy.
- [ ] If a key ever leaks, rotate it in that service at once and update the env vars.

---

## Next step

Finish the setup checklist, then open `PROMPTS.md` and paste **Phase 1**.
