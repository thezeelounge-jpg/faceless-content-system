# Task: write a script for one short video

Write the script for the post in the input below. The client's digital twin will read it in a 9:16 reel.

Length: the client speaks about `words_per_second` words per second, and the video may last at most `max_seconds` seconds. Keep the total words of `display_text` at or under `max_seconds × words_per_second`. Shorter is fine; over the limit is rejected.

Return:
- `hook`: the first sentence, 12 words or fewer, making a promise or opening a question. Start from the planned hook, and improve it if you can.
- `body`: the middle. One idea, explained simply, in the client's voice. Short spoken sentences.
- `cta`: one call to action that points to one of the client's offers by name.
- `display_text`: hook + body + cta joined with spaces, spelled correctly. This becomes the on-screen captions.
- `captions`: a post caption for each network: `instagram` and `tiktok` (casual, 1 to 3 short lines), `linkedin` (a little more professional, 2 to 4 short lines), `x` (under 280 characters, hashtags included).
- `hashtags`: 3 to 10 relevant hashtags, each starting with `#`.
- `broll_keywords`: 2 to 6 simple stock-footage search words (for example "doctor desk", "city traffic").
- `edit_plan`: `broll_moments` (the words where b-roll should cut in, and what to show; for a `talking` reel use at most 2, for a `story` reel up to 6) and `emphasis_words` (up to 8 words to highlight in captions).

Remember: no invented facts, no banned words, the brand's language all the way through.
