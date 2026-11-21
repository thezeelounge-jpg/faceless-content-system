# Task: suggest how to say tricky words (Gate 2, Pronunciation prep)

A text-to-speech twin will read these words aloud for this brand. For each word in `words` (names of people, brands, places, Urdu or Hindi words in English letters, acronyms), suggest a respelling that an English text-to-speech voice will say correctly.

Rules:
- Return one suggestion per word, in the same order, with `written` copied exactly.
- `say_as` uses plain English letters and hyphens between syllables, for example "Ayesha" → "aa-ye-sha", "Gulberg" → "gul-berg". No phonetic symbols.
- Use how people in the brand's audience countries say the word, not an anglicised guess.
- Acronyms said letter by letter get spaces ("CEO" → "C E O"); acronyms said as a word stay a word ("NASA" → "nasa").
