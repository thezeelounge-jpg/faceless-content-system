# HeyGen notes (read before touching lib/heygen.ts)

Checked 22 Nov 2026 (Phase 3 part A), read only, through Context7's copy of developers.heygen.com (library `/websites/developers_heygen`). No request was made to any HeyGen host. **Re-check against https://developers.heygen.com/llms.txt before the first real call.** Anything marked UNCONFIRMED in `lib/heygen.ts` must be checked on that first call (staging, with the owner's OK).

All calls: base `https://api.heygen.com`, header `X-Api-Key`, API v3 only. Code: `lib/heygen.ts` only.

## Endpoints used in Phase 3 part A

| What | Call | Key fields | Source |
|---|---|---|---|
| Check the key | `GET /v3/users/me` | `billing_type` and a matching billing field (`wallet`, `subscription` or `usage_based`); scope `account:read`. Other fields (username, balance) **UNCONFIRMED** | API Key — https://developers.heygen.com/docs/api-key ; API Key Permission Scopes — https://developers.heygen.com/docs/api-key-permissions |
| Upload the clip (large files) | `POST /v3/assets/direct-uploads` (`filename`, `content_type`, `size_bytes`, `checksum_sha256`) → `upload_url`, `upload_headers`, `asset_id`; PUT the bytes to `upload_url`; `POST /v3/assets/{asset_id}/complete` (`{checksum_sha256}`, idempotent) | videos up to 200 MB | Direct Upload to S3 — https://developers.heygen.com/docs/direct-upload |
| Upload (small files) | `POST /v3/assets` multipart `file`, up to 50 MB (not used) | `asset_id` | Upload Assets — https://developers.heygen.com/docs/upload-assets |
| Create the twin | `POST /v3/avatars` with `type: "digital_twin"`, `name`, `file` (`{type:"url",url}` capped at 32 MB, `{type:"asset_id",asset_id}`, or base64 up to 16 MB); optional `avatar_group_id` (omit = new group) | `data.avatar_item` (`id` = look id, `group_id`, `status` "processing", `supported_api_engines`, `default_voice_id`), `data.avatar_group` (`id`, `status` e.g. `pending_consent`, `consent_status`, `default_voice_id`) | Video to Avatar — https://developers.heygen.com/docs/avatar-from-video ; Create Avatar — https://developers.heygen.com/docs/create-avatar |
| Start consent | `POST /v3/avatars/{group_id}/consent` (optional `reroute_url`; `consent_video` is Enterprise only) | `avatar_group.consent_status` (`pending` / `accepted` / `rejected`) and the consent page `url` (Level 1 webcam, valid 24 hours). Exact position of `url` in the answer **UNCONFIRMED**. No webhook for consent: poll the group | Avatar Consent — https://developers.heygen.com/docs/avatar-consent |
| Group status | `GET /v3/avatars/{group_id}` | `status` (`pending_consent` / `completed` / `failed`), `consent_status`, `default_voice_id` | Avatar Groups — https://developers.heygen.com/docs/avatars |
| Looks | `GET /v3/avatars/looks?group_id=…`, `GET /v3/avatars/looks/{look_id}` | look `id` (= `avatar_id` for renders), `status` (`processing` / `completed` / `failed`), **`supported_api_engines`** (`heygen-avatar-6`, `heygen-avatar-6-turbo`, `avatar_iii`, `avatar_iv`, `avatar_v`), `default_voice_id`. Asking for an engine the look doesn't list → `invalid_parameter` | Avatar Looks — https://developers.heygen.com/docs/avatar-looks |
| Video status | `GET /v3/videos/{video_id}` | `status` (only `completed` and `failed` documented), `video_url` (signed, expires), `duration`, `failure_code`, `failure_message` | Video Agent — https://developers.heygen.com/docs/video-agent ; Avatar 6 — https://developers.heygen.com/docs/models/avatar-6 |

Voice: the twin's voice is cloned automatically; use the group's `default_voice_id` (falls back to the look's). Source: Video to Avatar.

Training clip limits (used in `lib/qa/config.ts` CLIP_CHECKS and `lib/consent-flow.ts`): **15 to 600 seconds** (about 2 minutes recommended), long edge 640 to 4096 px (1080p recommended; we require 1080 on the short side), **mp4 or webm**, one person facing the camera the whole time, up to 200 MB with direct upload. Frame rate: **not in the docs** (we ask for 30 fps, minimum 25). Source: Video to Avatar.

Errors and limits: error envelope with `code`, `message`, `param`, `doc_url`, `request_id` (no full JSON example found; we read `error.code`). `429 rate_limit_exceeded` comes with `Retry-After` (not always, e.g. voice-provider limits), plus `X-RateLimit-*`. Concurrency: 10 videos on Pay-As-You-Go. Sources: Error Codes — https://developers.heygen.com/docs/error-codes ; Usage Limits — https://developers.heygen.com/docs/usage-limits

## (b) Sandbox or test mode

**None found.** No `test` flag or sandbox for v3 video or avatar endpoints. The only "free failure" noted: an unknown `brand_glossary_id` fails with 400 before rendering (no credits spent). So our only protection is `MOCK_HEYGEN` (mock unless exactly `false`). Sources: Brand Glossary apply — https://developers.heygen.com/docs/brand-glossary/apply ; HeyGen Voice Speech — https://developers.heygen.com/docs/voices/heygen-voice-speech

## (c) The text field on `POST /v3/videos`

**`script`** ("The script text to be spoken", up to 5,000 characters). `spoken_text` and `display_text` are our own column names; HeyGen never sees them. Phase 3 part B sends **our `scripts.spoken_text` into `script`** (never `display_text`). Other fields: `type: "avatar"`, `avatar_id` (look id), `voice_id`, `engine: {type}` (omitting it uses Avatar IV), `resolution` (`1080p`/`2k`), `aspect_ratio` (`9:16` for us; there is no `dimension` field), `callback_url`, `callback_id`, `brand_glossary_id`, `title`. Response: `data.video_id`. The callback is attempted once, so polling stays as backup. Sources: Avatar 6 — https://developers.heygen.com/docs/models/avatar-6 ; Usage Limits ; HeyGen Video — https://developers.heygen.com/docs/models/heygen-video ; Webhooks — https://developers.heygen.com/docs/webhooks ; Webhook Events — https://developers.heygen.com/docs/webhook-events

Docs disagree (check on first real call): default resolution (Avatar 6 page says 1080p, Usage Limits says 720p for `avatar`, so always send `1080p`); whether `voice_id` is required; PATCH group body `default_voice_id` vs `voice_id`; failed-look error key `error.code` vs `error.type`.

## (d) Brand Glossary scope: one per workspace

"Each workspace has one glossary, and it holds rules for any number of languages." Creating a second one returns `409 conflict`. So **one glossary per brand is not possible** in one workspace. Plan: one shared workspace glossary; we sync every brand's **approved** `pronunciations` into it (terms are whole-word, case-insensitive; watch for two brands needing different respellings of the same word, in which case keep the respelled `spoken_text` as the only fix for that word). Sources: Brand Glossary — https://developers.heygen.com/docs/brand-glossary ; Manage a Glossary — https://developers.heygen.com/docs/brand-glossary/manage

Glossary details (from Phase 2): `GET`/`POST /v3/brand-glossaries`, `PATCH /v3/brand-glossaries/{id}` (replaces each list in full); terms have `term`, `pronunciation`, optional `ipa` (needs per-account enablement) and `pronunciation_language`; pass `brand_glossary_id` (32-character hex) at the top level of `POST /v3/videos`; applies only to script-driven speech. Inline `<pron>` / `<break>` are documented for Text to Speech only. Sources: https://developers.heygen.com/docs/brand-glossary/pronunciations , https://developers.heygen.com/docs/voices/heygen-voice-speech
