# Task: same sound or mispronounced? (Gate 3, Audio and pronunciation QA)

A digital twin read a script aloud. Speech-to-text then wrote down what it heard. For each item in `terms`, `written` is a key word or phrase from the script (the brand's name, the person's name, an offer, a call-to-action word, or a word from the brand's "How to say names" list) and `heard` is what speech-to-text wrote at that place ("" means nothing was heard there).

Decide for each item:
- `same_sound`: the voice said it correctly and speech-to-text only spelled it another way. This is common for Roman Urdu and Hindi words written in English letters ("Ayesha" / "Aisha", "InshaAllah" / "inshallah", "bohat" / "bahut") and for names split or joined ("WhatsApp" / "whats app").
- `mispronounced`: the voice said a different word or sound ("Ayesha" heard as "Asia"), dropped it, or said it so a listener in the brand's audience countries would hear it wrong.

Rules:
- Return one judgement per item, in the same order, with `written` and `heard` copied exactly.
- When unsure, choose `mispronounced` (a person checks it later; a wrong "same_sound" reaches the customer).
- For `mispronounced`, `respelling` tells an English text-to-speech voice how to say `written`: plain English letters with hyphens between syllables ("Ayesha" → "Aa-ee-sha", "Gulberg" → "Gul-berg"). No digits, no phonetic symbols. Say it the way people in the brand's audience countries say it.
- For `same_sound`, `respelling` is "".
- `language` is the brand's language (en, roman_urdu or hinglish).
