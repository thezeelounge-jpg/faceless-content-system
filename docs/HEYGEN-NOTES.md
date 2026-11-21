# HeyGen notes (read before Phase 3)

## Pronunciation: Brand Glossary (QA-SPEC Gate 2, step 5)

Checked 22 Nov 2026, read only, through Context7's copy of developers.heygen.com. A direct fetch of llms.txt was blocked, so **re-check against https://developers.heygen.com/llms.txt before coding**. No HeyGen code was written in Phase 2.

Pages read:
- https://developers.heygen.com/docs/brand-glossary
- https://developers.heygen.com/docs/brand-glossary/apply
- https://developers.heygen.com/docs/brand-glossary/manage
- https://developers.heygen.com/docs/brand-glossary/pronunciations
- https://developers.heygen.com/docs/voices/heygen-voice-speech

What exists (v3):
- **Brand Glossary**: `GET` and `POST /v3/brand-glossaries`, `PATCH /v3/brand-glossaries/{brand_glossary_id}`. The docs say to find the workspace glossary or create one, which suggests one per workspace. Body fields: `name`, `terms`, `do_not_translate_terms`, `forced_translations`. PATCH replaces each list in full.
- Each term has `term`, `pronunciation` (a respelling such as "hey-jen"), an optional `ipa` and an optional `pronunciation_language` (`{scope: "specific", code: "fr"}`). `ipa` only works if HeyGen enables it per account; otherwise it returns `400 invalid_parameter`. Repeating a term for the same language returns `409`.
- Pass `brand_glossary_id` (32-character hex) at the top level of `POST /v3/videos`. An unknown id fails with `400` before rendering, so no credits are spent. It only applies when the speech comes from a script, not from uploaded audio.
- Text to Speech limits: a term can be up to 128 characters; matching is whole-word and ignores case; up to 100 pronunciations per request.
- Inline `<pron ipa="/.../">word</pron>` and `<break time="0.5s"/>` are documented for the Text to Speech endpoint only. "Other SSML is not supported." It is **not confirmed** that they work inside video scripts.

Plan for Phase 3 (per QA-SPEC: "use it as well as the respelling"):
- Keep our respelled `spoken_text` as the main fix; it works with any voice.
- Also sync each brand's **approved** `pronunciations` rows into a HeyGen glossary and pass `brand_glossary_id` on renders. Because there may be only one glossary per workspace, check whether we need one glossary per brand before building this.
- **Open question:** the doc examples send the text as `script`, while CLAUDE.md says "send `spoken_text`, never `display_text`". The rule means *our* spoken_text goes into whatever field v3 uses for the voice text. Confirm the exact field name in the v3 `POST /v3/videos` docs.
