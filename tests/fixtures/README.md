# Test fixtures

Sample files used in mock mode (`MOCK_HEYGEN=true`, `MOCK_STT=true`) and in tests, so development never spends money.

| File | Added in | What it is |
|---|---|---|
| `sample-heygen.mp4` | Phase 3 | A short real HeyGen render (about 15 s, vertical). The owner adds it after the first approved real render. |
| `sample-heygen.srt` | Phase 3 | The SRT that came with that render. |
| `sample-transcript.json` | Phase 4 | Speech-to-text output for the sample video, with word timings. |
| `sample-clip.mp4` | Phase 3 | A short consent-style clip for testing the automatic clip checks. |

Keep files small (under 10 MB each). Never put a real client's video here.
