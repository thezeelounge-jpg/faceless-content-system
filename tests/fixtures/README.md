# Test fixtures

Sample files used in mock mode (`MOCK_HEYGEN=true`, `MOCK_STT=true`, `MOCK_CLAUDE=true`) and in tests, so development never spends money.

| File | Added in | What it is |
|---|---|---|
| `consent-good.mp4` | Phase 3 | 16 s, 1080x1920, 30 fps, bright flat colour + steady test tone. Passes every clip check. Also the mock "video" `lib/heygen.ts` hands out. |
| `consent-bad.mp4` | Phase 3 | 8 s, 720x1280, 24 fps, dark, 5 s of silence. Fails length, sharpness, smoothness, silence and light. |
| `consent-*.vision.json` | Phase 3 | Mock Claude face-check answers for the clip with the same name (bad = two faces in some frames). |
| `heygen/*.json` | Phase 3 | Mock HeyGen API answers, shaped like the v3 docs (see docs/HEYGEN-NOTES.md). |
| `sample-heygen.mp4` / `.srt` | Phase 3 part B | A short real HeyGen render. The owner adds it after the first approved real render. |
| `sample-transcript.json` | Phase 4 | Speech-to-text output for the sample video, with word timings. |

Rebuild the clips with `npm run fixtures` (needs ffmpeg; script: `scripts/make-fixtures.sh`). No real person is in any fixture. Keep files small (under 10 MB each; the clips are under 100 KB). Never put a real client's video here.
