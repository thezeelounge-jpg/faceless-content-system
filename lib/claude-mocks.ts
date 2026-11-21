// Sample Claude answers for MOCK_CLAUDE=true. They cost nothing and make no
// network calls, but they follow the brand's rules (offers in the call to
// action, no banned words, the exact dates and time limit asked for), so the
// code after them is really tested. Same input → same answer, every time.
import type {
  BrandProfileOutput,
  PlanOutput,
  PronunciationOutput,
  ScriptOutput,
  ScriptQaOutput,
} from "@/lib/ai-schemas";
import { firstSentence } from "@/lib/qa/script-checks";

/**
 * Test-only switch for mock mode, so the Gate 1 rewrite path can be exercised
 * without spending anything:
 * - "good" (default): drafts that pass;
 * - "bad_first_draft": the first draft breaks the rules, the rewrite fixes it;
 * - "always_bad": the first draft and the rewrite both break the rules.
 */
export type MockScenario = "good" | "bad_first_draft" | "always_bad";

export type MockBrand = {
  name: string;
  niche: string | null;
  audience: string | null;
  offers: string | null;
  tone: string | null;
  sound_answers: Record<string, string>;
  banned_words: string[];
  words_per_second: number;
  samples?: string | null;
  profile_md?: string | null;
};

const NICHE_PILLARS: Record<string, string[]> = {
  coach: ["Mindset shifts", "Small daily habits", "Client wins", "Myths I disagree with", "Behind the sessions"],
  consultant: ["Costly mistakes", "Simple frameworks", "Industry myths", "Client stories", "Quick wins"],
  founder: ["Building in public", "Lessons from failure", "Team and hiring", "Money and growth", "Founder habits"],
  freelancer: ["Finding clients", "Pricing your work", "Process and tools", "Client stories", "Freelance life"],
  agency: ["Campaign breakdowns", "Common mistakes", "Tools we use", "Client results", "Behind the scenes"],
  real_estate: ["Buying basics", "Area guides", "Money and loans", "Common mistakes", "Property tours"],
  doctor: ["Everyday health myths", "When to see a doctor", "Prevention habits", "Clinic life", "Patient questions"],
  business_story: ["How it started", "Hard lessons", "Customer stories", "Behind the scenes", "What's next"],
};
const DEFAULT_PILLARS = ["Common mistakes", "Quick tips", "Stories", "Myths", "Questions I get"];

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes banned words (whole words, any case) and tidies the spaces left behind. */
export function removeBannedWords(text: string, banned: string[]): string {
  let out = text;
  for (const word of banned) {
    if (!word.trim()) continue;
    out = out.replace(new RegExp(`\\b${escape(word.trim())}\\b`, "gi"), "");
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();
}

function clean<T>(value: T, banned: string[]): T {
  if (typeof value === "string") return removeBannedWords(value, banned) as T;
  if (Array.isArray(value)) return value.map((item) => clean(item, banned)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, banned)])) as T;
  }
  return value;
}

/** The first offer's name, without its price: "Online consultation for Rs 2,999" → "Online consultation". */
export function mainOffer(offers: string | null): string {
  const first = (offers ?? "").split(/[,\n;]/)[0]?.trim() ?? "";
  const name = first.split(/\s+(?:for|at|@|-|–)\s+/i)[0]?.trim();
  return name || "free call";
}

/** The first offer as written, starting lower case: "Online consultation for Rs 2,999" → "online consultation for Rs 2,999". */
export function firstOffer(offers: string | null): string {
  const first = (offers ?? "").split(/[\n;]/)[0]?.split(/,(?!\d)/)[0]?.trim() ?? "";
  return first ? first.charAt(0).toLowerCase() + first.slice(1) : "free call";
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const firstWords = (text: string, n: number) => words(text).slice(0, n).join(" ");
const short = (text: string | null, n: number, fallback: string) => firstWords(text ?? "", n) || fallback;

function hashtag(text: string): string | null {
  const tag = text.replace(/[^\p{L}\p{N}]/gu, "");
  return tag ? `#${tag.toLowerCase()}` : null;
}

function hashtags(brand: MockBrand, extra: string[]): string[] {
  const banned = new Set(brand.banned_words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
  const tags = [brand.niche ?? "", ...extra, "tips", "reels", "learn", "smallbusiness"]
    .map(hashtag)
    .filter((tag): tag is string => tag !== null && !banned.has(tag.slice(1)));
  return [...new Set(tags)].slice(0, 6);
}

export function mockBrandProfile(brand: MockBrand): BrandProfileOutput {
  const pillarNames = NICHE_PILLARS[brand.niche ?? ""] ?? DEFAULT_PILLARS;
  const audience = brand.audience ?? "their audience";
  const sound = brand.sound_answers;
  const profile = [
    `## Who they are`,
    `${brand.name} works in ${brand.niche?.replace("_", " ") ?? "their field"} and shares practical advice in short videos.`,
    ``,
    `## Who they talk to`,
    `${audience}. They want clear answers without jargon.`,
    ``,
    `## What they sell`,
    `${brand.offers ?? "Offers not given yet."}`,
    ``,
    `## How they sound`,
    `Tone: ${brand.tone ?? "friendly"}. Usually opens with "${sound.greeting ?? "Hi"}". Often says "${sound.phrases ?? "-"}". Short spoken sentences.`,
    ``,
    `## Words to avoid`,
    `Anything that sounds like "${sound.never_say ?? "hype"}", hype, or big promises.`,
    ``,
    `## Facts we may use`,
    `Only what is listed under "What they sell". None given yet beyond that.`,
  ].join("\n");
  return clean(
    {
      profile_md: profile,
      pillars: pillarNames.map((name) => ({
        name,
        description: `${name} for ${short(audience, 8, "the audience")}, leading to ${mainOffer(brand.offers)}.`,
      })),
    },
    brand.banned_words,
  );
}

export function mockPlan(brand: MockBrand, input: { slots: string[]; pillars: string[] }): PlanOutput {
  const audience = short(brand.audience, 4, "people");
  return clean(
    {
      posts: input.slots.map((date, i) => {
        const pillar = input.pillars[i % input.pillars.length];
        return {
          date,
          pillar,
          title: `${firstWords(pillar, 8)}: idea ${i + 1}`,
          hook: `What do ${audience} get wrong about ${firstWords(pillar, 5).toLowerCase()}?`,
          format: i % 3 === 2 ? ("story" as const) : ("talking" as const),
        };
      }),
    },
    brand.banned_words,
  );
}

function fitScript(brand: MockBrand, parts: { hook: string; body: string; cta: string }, maxSeconds: number, wps: number) {
  const budget = Math.floor(maxSeconds * wps);
  let hook = firstWords(parts.hook, 12);
  if (!/[.?!]$/.test(hook)) hook += "?";
  const cta = parts.cta;
  const room = Math.max(0, budget - words(hook).length - words(cta).length);
  let body = firstWords(parts.body, room);
  if (body && !/[.!?]$/.test(body)) body += ".";
  return { hook, body: body || "Here is the one thing to remember.", cta };
}

function scriptExtras(brand: MockBrand, core: { hook: string; body: string; cta: string }, pillar: string, format: string) {
  const display_text = [core.hook, core.body, core.cta].join(" ");
  const tags = hashtags(brand, [pillar]);
  const xCaption = `${core.hook} ${tags.slice(0, 3).join(" ")}`;
  return {
    ...core,
    display_text,
    captions: {
      instagram: `${core.hook}\n\n${core.cta}`,
      tiktok: `${core.hook} ${core.cta}`,
      linkedin: `${core.hook}\n\n${core.body}\n\n${core.cta}`,
      x: xCaption.length <= 280 ? xCaption : xCaption.slice(0, 280),
    },
    hashtags: tags,
    broll_keywords: [firstWords(pillar, 2).toLowerCase(), brand.niche?.replace("_", " ") ?? "office", "phone screen"],
    edit_plan: {
      broll_moments:
        format === "story"
          ? [
              { at_words: firstWords(core.body, 3) || core.hook, keyword: firstWords(pillar, 2).toLowerCase() },
              { at_words: firstWords(core.cta, 2), keyword: "phone screen" },
            ]
          : [{ at_words: firstWords(core.body, 3) || core.hook, keyword: firstWords(pillar, 2).toLowerCase() }],
      emphasis_words: words(core.hook).slice(-2),
    },
  };
}

type ScriptRequest = {
  title: string;
  hook: string;
  pillar: string;
  format: string;
  max_seconds: number;
  words_per_second: number;
};

export function mockScript(brand: MockBrand, input: ScriptRequest, scenario: MockScenario = "good"): ScriptOutput {
  if (scenario !== "good") return badDraft(brand, input);
  const hook = /[?.!]$/.test(input.hook.trim()) ? input.hook.trim() : `${input.hook.trim()}?`;
  const body =
    `${brand.sound_answers.greeting ?? "Hi"}. Let's talk about ${input.title.toLowerCase()}. ` +
    `Most ${short(brand.audience, 4, "people")} only hear the loud advice. ` +
    `Here is the simple version: start small, stay consistent, and ask for help early. ` +
    `${brand.sound_answers.phrases ?? ""}`.trim();
  const cta = `Book your ${firstOffer(brand.offers)} today.`;
  const core = fitScript(brand, { hook, body, cta }, input.max_seconds, input.words_per_second);
  return clean(scriptExtras(brand, core, input.pillar, input.format), brand.banned_words);
}

/** A draft that breaks the rules on purpose: long hook, banned word, made-up result, no offer in the CTA. */
function badDraft(brand: MockBrand, input: ScriptRequest): ScriptOutput {
  const banned = brand.banned_words.find((word) => word.trim());
  const core = {
    hook: "Listen carefully because this is the one simple thing that nobody in your city ever tells you.",
    body: `${banned ? `This ${banned} trick changes everything. ` : ""}9 out of 10 of my clients see results in one week.`,
    cta: "Follow for more.",
  };
  return scriptExtras(brand, core, input.pillar, input.format);
}

const NUMBER = /\d[\d,.]*/g;
const plainNumber = (n: string) => n.replace(/[,.]+$/, "").replace(/,/g, "");

/** Numbers we may say: the ones in the brand's offers, profile and samples ("2,999" → "2999"). */
function knownNumbers(brand: MockBrand): Set<string> {
  const facts = [brand.offers, brand.profile_md, brand.samples].join(" ");
  return new Set((facts.match(NUMBER) ?? []).map(plainNumber));
}

const sentences = (text: string) => text.split(/(?<=[.?!])\s+/).filter(Boolean);

/** Sentences with a number that isn't in the brand details (a made-up fact). */
function unsupportedSentences(brand: MockBrand, text: string): string[] {
  const known = knownNumbers(brand);
  return sentences(text).filter((sentence) => (sentence.match(NUMBER) ?? []).some((n) => !known.has(plainNumber(n))));
}

/** Sounds like them: the greeting or a favourite phrase is in the script. */
function soundsLikeThem(brand: MockBrand, text: string): boolean {
  const marks = [brand.sound_answers.greeting, brand.sound_answers.phrases].filter((m): m is string => Boolean(m?.trim()));
  return marks.length === 0 || marks.some((mark) => text.toLowerCase().includes(mark.trim().toLowerCase()));
}

export function mockScriptQa(
  brand: MockBrand,
  input: { script: { hook: string; body: string; cta: string; display_text: string } },
): ScriptQaOutput {
  const hookWords = words(firstSentence(input.script.display_text)).length;
  const hookOk = hookWords <= 12;
  const ctaOk = input.script.cta.toLowerCase().includes(mainOffer(brand.offers).toLowerCase());
  const madeUp = unsupportedSentences(brand, input.script.display_text);
  const issues = [
    ...(hookOk ? [] : [{ code: "hook", detail: `The first sentence has ${hookWords} words; keep it to 12.` }]),
    ...(ctaOk ? [] : [{ code: "cta", detail: `The call to action should point to "${mainOffer(brand.offers)}".` }]),
    ...madeUp.map((sentence) => ({ code: "made_up_fact", detail: `"${sentence}" is not in the brand details. Remove it.` })),
  ];
  return {
    hook_ok: hookOk,
    cta_matches_offers: ctaOk,
    no_made_up_facts: madeUp.length === 0,
    risky_claims_softened: true,
    language_matches: true,
    platform_safe: true,
    voice_score: soundsLikeThem(brand, input.script.display_text) ? 8 : 6,
    issues,
  };
}

export function mockScriptRewrite(
  brand: MockBrand,
  input: { script: ScriptOutput; max_seconds: number; words_per_second: number },
  scenario: MockScenario = "good",
): ScriptOutput {
  if (scenario === "always_bad") return input.script;
  const pillar = input.script.broll_keywords[0] ?? "tips";
  const unsupported = new Set(unsupportedSentences(brand, input.script.body));
  let body = removeBannedWords(
    sentences(input.script.body)
      .filter((sentence) => !unsupported.has(sentence))
      .join(" "),
    brand.banned_words,
  );
  const greeting = brand.sound_answers.greeting;
  if (greeting && !soundsLikeThem(brand, body)) body = `${greeting}. ${body}`.trim();
  const hook =
    words(input.script.hook).length > 12
      ? `${firstWords(input.script.hook, 10).replace(/[.,!?]+$/, "")}?`
      : input.script.hook;
  const core = fitScript(
    brand,
    { hook, body: body || "Here is the one thing to remember.", cta: `Book your ${firstOffer(brand.offers)} today.` },
    input.max_seconds,
    input.words_per_second,
  );
  return clean(scriptExtras(brand, core, pillar, "talking"), brand.banned_words);
}

/** "Ayesha" → "ay-es-ha", "CEO" → "C E O". */
export function mockRespell(word: string): string {
  if (/^[A-Z]{2,5}$/.test(word)) return word.split("").join(" ");
  const lower = word.toLowerCase();
  return lower.match(/.{1,2}/g)?.join("-") ?? lower;
}

export function mockPronunciation(input: { words: string[] }): PronunciationOutput {
  return { suggestions: input.words.map((written) => ({ written, say_as: mockRespell(written) })) };
}
