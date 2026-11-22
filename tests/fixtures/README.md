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
| `stt/by-text.json` + `stt/gate3-*.json` | Phase 5 (p5-a2) | The MOCK speech-to-text picks a transcript by the text the voice was asked to say (first `contains` match, any case). Gate 3 test script "Hi, I'm Ayesha from Bright Smile Dental…": first render heard "asia" (`gate3-ayesha-misheard`), the re-render with the respelling "Aa-ee-sha" heard right (`gate3-ayesha-fixed`); the Sameer script is heard "summer" then "same ear" (a forced double fail). 20 words over 7.8 s. |
| `stt/key-term-judgements.json` | Phase 5 (p5-a2) | MOCK answers for the Claude FAST `key_term_check` task (same sound vs mispronounced, with respellings), incl. Roman Urdu spelling variants (Aisha, inshallah, bahut). |

| `broll/*.mp4` + `broll/catalogue.json` | Phase 4 part B | The MOCK B-roll set (`lib/broll.ts`, `MOCK_PEXELS`): 4 portrait clips, 3–4 s, no sound, each a flat colour with one white box in a different corner (`cafe-green` 720x1280, `cafe-blue` 1080x1920, `phone-magenta` 540x960, `city-orange` 640x1136: mixed sizes so the editor's scale + crop is exercised). The centre is always the flat colour (the integration test samples it). `catalogue.json` maps a lowercase keyword to clip ids (`default` when nothing matches). 27.6 KB in total. |
| `music/*.m4a` + `music/beds.json` | Phase 4 part B | The MOCK music set (`lib/music.ts`): `bed-calm` (24 s, sine chords C–Am–F–G), `bed-bright` (20 s, triangle chords D–G–A–G), `bed-soft` (30 s, low sine chords). Each chord swells up from and back to silence, so a bed loops without a click. Normalised to about -14 LUFS (measured -13.4 / -14.1 / -13.3), mono AAC 48 kHz. 326 KB in total. |

**Licence of the generated media:** every clip and music bed above (and the consent clips) is made by `scripts/make-fixtures.sh` from ffmpeg's built-in `lavfi` sources (flat colours, boxes, sine/triangle tones). Nothing is downloaded and no stock footage or real music is used, so they are our own work; we release them as CC0.

Rebuild the clips with `npm run fixtures` (needs ffmpeg; script: `scripts/make-fixtures.sh`). No real person is in any fixture. Keep files small (under 10 MB each; the clips are under 100 KB). Never put a real client's video here.
