# Test fixtures

Sample files used in mock mode (`MOCK_HEYGEN=true`, `MOCK_STT=true`, `MOCK_CLAUDE=true`) and in tests, so development never spends money.

| File | Added in | What it is |
|---|---|---|
| `consent-good.mp4` | Phase 3 | 16 s, 1080x1920, 30 fps, bright flat colour + steady test tone. Passes every clip check. Also the mock "video" `lib/heygen.ts` hands out. |
| `consent-bad.mp4` | Phase 3 | 8 s, 720x1280, 24 fps, dark, 5 s of silence. Fails length, sharpness, smoothness, silence and light. |
| `consent-good.mov` | Phase 3 part B | `consent-good.mp4` re-wrapped as QuickTime (.mov), about 93 KB. The clip check converts it to mp4 (decision 5); it uses the `consent-good` vision sidecar. |
| `consent-corrupt.mov` | Phase 3 part B | 8 KB of text named .mov. Conversion fails, so the "Most Compatible" tip shows. |
| `consent-*.vision.json` | Phase 3 | Mock Claude face-check answers for the clip with the same name (bad = two faces in some frames). |
| `heygen/*.json` | Phase 3 | Mock HeyGen API answers, shaped like the v3 docs (see docs/HEYGEN-NOTES.md). |
| `heygen/create-video.json`, `heygen/webhook-endpoint.json` | Phase 3 part B step 2 | Mock answers for `POST /v3/videos` (the mock id becomes `video_mock_<our video id>`) and `POST /v3/webhooks/endpoints` (a fake secret, not real). |
| `heygen/webhooks/*.json` + `.sig` | Phase 3 part B step 2 | Signed HeyGen webhook payloads (success, fail) for the video `90000000-…0001`. `.sig` = hex HMAC-SHA256 of the exact file bytes with the TEST-ONLY secret `test-webhook-secret-not-real`. Re-sign after editing: `node scripts/sign-webhook-fixtures.mjs`. |
| `sample-heygen.mp4` / `.srt` | Phase 3 part B | A short real HeyGen render. The owner adds it after the first approved real render. |
| `stt/sample-transcript.json` | Phase 4 part A | The MOCK speech-to-text answer (`lib/stt.ts`, `MOCK_STT`): 19 word-timed words over 6 s, written like real STT output (lowercase, no punctuation, "three" for "3", "whats app" split, an extra "um", the word "a" missed). Matches `stt/sample-script.json` and the 6-second test video the edit tests make. |
| `stt/sample-script.json` | Phase 4 part A | The `display_text` and `edit_plan` that go with the mock transcript. |

Rebuild the clips with `npm run fixtures` (needs ffmpeg; script: `scripts/make-fixtures.sh`). No real person is in any fixture. Keep files small (under 10 MB each; the clips are under 100 KB). Never put a real client's video here.
