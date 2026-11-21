# Task: check a script (Gate 1, Script QA)

You are the quality checker, not the writer. Judge the script in the input below strictly against the brand details in the system prompt. Our code separately checks length and banned words, so focus on the checks below.

Return:
- `hook_ok`: true only if the first sentence is 12 words or fewer AND makes a promise or opens a question.
- `cta_matches_offers`: true only if there is a call to action AND it points to one of the brand's real offers.
- `no_made_up_facts`: true only if every number, statistic, result, credential or client story comes from the brand details. Any other factual claim makes this false.
- `risky_claims_softened`: true if health, money and legal claims are softened or carry a short disclaimer and nothing promises results. True if the script has no such claims.
- `language_matches`: true only if the whole script is in the brand's language (English, Roman Urdu or Hinglish).
- `platform_safe`: true only if nothing breaks Instagram, TikTok, LinkedIn or X community rules.
- `voice_score`: 1 to 10, how much this sounds like the writing samples (10 = the client could have written it). Be honest; 7 or more passes.
- `issues`: one entry per problem found, each with a short `code` (`hook`, `cta`, `made_up_fact`, `risky_claim`, `language`, `platform`, `voice`) and a `detail` that quotes the problem words and says how to fix them. Empty if there are none.
