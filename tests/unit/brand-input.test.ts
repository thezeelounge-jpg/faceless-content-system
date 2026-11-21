import { describe, expect, it } from "vitest";
import {
  brandInputFromFormData,
  brandInputSchema,
  brandInputToRow,
  joinSamples,
  soundAnswerList,
  splitSamples,
  SOUND_QUESTIONS,
  type BrandInput,
} from "@/lib/brand-input";

describe("onboarding answers on the brand page", () => {
  it("lists the 3 sound questions with their answers, in order, with a dash when missing", () => {
    expect(soundAnswerList({ phrases: "Seedhi baat", greeting: "Assalam o alaikum" })).toEqual([
      { question: "How do you usually start a video or a message?", answer: "Assalam o alaikum" },
      { question: "Which words or phrases do you say a lot?", answer: "Seedhi baat" },
      { question: "What would you never say?", answer: "—" },
    ]);
    expect(soundAnswerList(null)).toHaveLength(3);
  });
});

const SAMPLES = [
  "Most clinics lose patients at the front desk, not in the doctor's room.",
  "I stopped chasing every lead and my sales went up. Here is why.",
  "Your first property should be boring. Boring pays the bills.",
];

function validRaw(overrides: Record<string, unknown> = {}) {
  return {
    name: "Dr Ayesha Clinic",
    niche: "doctor",
    audience: "Busy parents in Lahore",
    offers: "Online consultation, Rs 2,999",
    tone: "Warm, direct, no jargon",
    sound_answers: { greeting: "Assalam o alaikum", phrases: "Seedhi baat", never_say: "Guaranteed cure" },
    samples: SAMPLES,
    banned_words: ["guaranteed", "miracle"],
    language: "en",
    posting_days: [1, 3, 5],
    posts_per_week: 3,
    audience_countries: ["PK"],
    autopilot_level: "review_everything",
    ...overrides,
  };
}

describe("brand onboarding schema", () => {
  it("accepts a complete answer", () => {
    const result = brandInputSchema.safeParse(validRaw());
    expect(result.success).toBe(true);
  });

  it("allows 1 to 14 posts per week only", () => {
    expect(brandInputSchema.safeParse(validRaw({ posts_per_week: 0 })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ posts_per_week: 15 })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ posts_per_week: 1, posting_days: [1] })).success).toBe(true);
    expect(
      brandInputSchema.safeParse(validRaw({ posts_per_week: 14, posting_days: [0, 1, 2, 3, 4, 5, 6] })).success,
    ).toBe(true);
    expect(brandInputSchema.safeParse(validRaw({ posts_per_week: 2.5 })).success).toBe(false);
  });

  it("allows at most 2 posts per chosen day", () => {
    const result = brandInputSchema.safeParse(validRaw({ posts_per_week: 5, posting_days: [1, 3] }));
    expect(result.success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ posts_per_week: 4, posting_days: [1, 3] })).success).toBe(true);
  });

  it("needs 3 to 5 writing samples", () => {
    expect(brandInputSchema.safeParse(validRaw({ samples: SAMPLES.slice(0, 2) })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ samples: [...SAMPLES, ...SAMPLES] })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ samples: [...SAMPLES, SAMPLES[0], SAMPLES[1]] })).success).toBe(true);
  });

  it("needs all 3 'how do you sound' answers", () => {
    expect(SOUND_QUESTIONS).toHaveLength(3);
    const missing = { greeting: "Hi", phrases: "", never_say: "x" };
    expect(brandInputSchema.safeParse(validRaw({ sound_answers: missing })).success).toBe(false);
  });

  it("allows 1 to 3 known audience countries and defaults to Pakistan", () => {
    expect(brandInputSchema.safeParse(validRaw({ audience_countries: ["PK", "AE", "SA", "QA"] })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ audience_countries: ["XX"] })).success).toBe(false);
    const parsed = brandInputSchema.parse(validRaw({ audience_countries: undefined }));
    expect(parsed.audience_countries).toEqual(["PK"]);
  });

  it("only accepts the 3 languages, the niche presets and the 3 autopilot levels", () => {
    for (const language of ["en", "roman_urdu", "hinglish"]) {
      expect(brandInputSchema.safeParse(validRaw({ language })).success).toBe(true);
    }
    expect(brandInputSchema.safeParse(validRaw({ language: "urdu" })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ niche: "astronaut" })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ autopilot_level: "yolo" })).success).toBe(false);
    expect(brandInputSchema.parse(validRaw({ autopilot_level: undefined })).autopilot_level).toBe("review_everything");
  });

  it("needs valid, unique posting days (0 = Sunday ... 6 = Saturday)", () => {
    expect(brandInputSchema.safeParse(validRaw({ posting_days: [] })).success).toBe(false);
    expect(brandInputSchema.safeParse(validRaw({ posting_days: [7] })).success).toBe(false);
    const parsed = brandInputSchema.parse(validRaw({ posting_days: [5, 1, 3, 1] }));
    expect(parsed.posting_days).toEqual([1, 3, 5]);
  });

  it("cleans banned words (trimmed, lower case, no repeats)", () => {
    const parsed = brandInputSchema.parse(validRaw({ banned_words: [" Miracle ", "miracle", "", "CURE"] }));
    expect(parsed.banned_words).toEqual(["miracle", "cure"]);
  });
});

describe("reading the form", () => {
  function form(entries: [string, string][]) {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return data;
  }

  it("turns form fields into the schema's shape", () => {
    const data = form([
      ["name", "  Dr Ayesha Clinic "],
      ["niche", "doctor"],
      ["audience", "Busy parents"],
      ["offers", "Online consultation"],
      ["tone", "Warm"],
      ["sound_greeting", "Hi"],
      ["sound_phrases", "Seedhi baat"],
      ["sound_never_say", "Cure"],
      ["sample_1", SAMPLES[0]],
      ["sample_2", SAMPLES[1]],
      ["sample_3", SAMPLES[2]],
      ["sample_4", "   "],
      ["sample_5", ""],
      ["banned_words", "miracle, guaranteed\ncure"],
      ["language", "roman_urdu"],
      ["posting_days", "1"],
      ["posting_days", "4"],
      ["posts_per_week", "2"],
      ["audience_countries", "PK"],
      ["audience_countries", "AE"],
      ["autopilot_level", "review_videos"],
    ]);
    const parsed = brandInputSchema.parse(brandInputFromFormData(data));
    expect(parsed).toMatchObject({
      name: "Dr Ayesha Clinic",
      samples: SAMPLES,
      banned_words: ["miracle", "guaranteed", "cure"],
      language: "roman_urdu",
      posting_days: [1, 4],
      posts_per_week: 2,
      audience_countries: ["PK", "AE"],
      autopilot_level: "review_videos",
      sound_answers: { greeting: "Hi", phrases: "Seedhi baat", never_say: "Cure" },
    });
  });

  it("uses Pakistan when no country is ticked", () => {
    const parsed = brandInputFromFormData(form([["name", "x"]]));
    expect(parsed.audience_countries).toBeUndefined();
  });
});

describe("saving a brand row", () => {
  it("maps the input to the brands table and keeps samples apart", () => {
    const input: BrandInput = brandInputSchema.parse(validRaw());
    const row = brandInputToRow(input, { ownerId: "owner-1", isManaged: true });
    expect(row).toMatchObject({
      owner_id: "owner-1",
      is_managed: true,
      name: "Dr Ayesha Clinic",
      posts_per_week: 3,
      posting_days: [1, 3, 5],
      audience_countries: ["PK"],
    });
    expect(splitSamples(row.samples)).toEqual(SAMPLES);
    expect(splitSamples(joinSamples(SAMPLES))).toEqual(SAMPLES);
    expect(splitSamples(null)).toEqual([]);
  });
});
