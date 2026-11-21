# Task: write the brand profile

Using the brand details in the system prompt, write the brand profile our scriptwriters will read before every script. They will rely on it for months, so make it specific to this client. Anything generic ("provides value", "engaging content") is wasted space.

Return:

- `profile_md`: Markdown, 300 to 900 words, with these sections:
  - `## Who they are` (2 to 4 sentences)
  - `## Who they talk to` (the audience, their problems, and what they want)
  - `## What they sell` (each offer in plain words, with prices exactly as given; never invent one)
  - `## How they sound` (voice rules drawn from the samples and sound answers: sentence length, favourite phrases, how they open and close, formality, humour)
  - `## Words to avoid` (phrases and styles that would sound unlike them; the banned-words list is sent separately with every request, so don't repeat those words here)
  - `## Facts we may use` (only facts stated in the brand details; write "None given yet" if there are none)
- `pillars`: 4 to 6 content pillars. Each has a short `name` (2 to 5 words) and a one or two sentence `description` of what posts in that pillar cover and why the audience cares. Pillars should be different enough that a month of posts doesn't feel repetitive, and every pillar should lead naturally to one of the offers.
