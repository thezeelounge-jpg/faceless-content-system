// The onboarding answers for a brand. Shared by the browser form and the
// server, so both check the same rules. Phase 6 reuses this for customers.
import { z } from "zod";

export const NICHE_PRESETS = [
  { value: "coach", label: "Coach" },
  { value: "consultant", label: "Consultant" },
  { value: "founder", label: "Founder" },
  { value: "freelancer", label: "Freelancer" },
  { value: "agency", label: "Agency" },
  { value: "real_estate", label: "Real estate" },
  { value: "doctor", label: "Doctor" },
  { value: "business_story", label: "Business story" },
] as const;

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "roman_urdu", label: "Roman Urdu" },
  { value: "hinglish", label: "Hinglish" },
] as const;

/** Countries we plan posting times for (ISO codes, as stored in brands.audience_countries). */
export const COUNTRIES = [
  { value: "PK", label: "Pakistan" },
  { value: "AE", label: "UAE" },
  { value: "SA", label: "Saudi Arabia" },
  { value: "QA", label: "Qatar" },
  { value: "KW", label: "Kuwait" },
  { value: "OM", label: "Oman" },
  { value: "BH", label: "Bahrain" },
  { value: "IN", label: "India" },
  { value: "GB", label: "United Kingdom" },
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
] as const;

export const AUTOPILOT_LEVELS = [
  { value: "review_everything", label: "Review everything", about: "Approve the script and the video." },
  { value: "review_videos", label: "Review videos only", about: "Scripts go straight to video." },
  { value: "full_autopilot", label: "Full autopilot", about: "Videos approve themselves after 24 hours." },
] as const;

/** 0 = Sunday ... 6 = Saturday, same as the database. */
export const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const;

/** The 3 "how do you sound" questions. Answers are saved in brands.sound_answers. */
export const SOUND_QUESTIONS = [
  { key: "greeting", question: "How do you usually start a video or a message?" },
  { key: "phrases", question: "Which words or phrases do you say a lot?" },
  { key: "never_say", question: "What would you never say?" },
] as const;

/** The 3 sound questions with the brand's answers, in form order ("—" when missing). */
export function soundAnswerList(answers: Record<string, string> | null | undefined) {
  return SOUND_QUESTIONS.map((q) => ({ question: q.question, answer: answers?.[q.key]?.trim() || "—" }));
}

export const MAX_POSTS_PER_DAY = 2;

type Values<T extends readonly { value: unknown }[]> = T[number]["value"];
const values = <T extends readonly { value: string }[]>(list: T) =>
  list.map((item) => item.value) as [Values<T>, ...Values<T>[]];

const text = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} is too long (${max} characters at most).`);

export const brandInputSchema = z
  .object({
    name: text("Name", 80),
    niche: z.enum(values(NICHE_PRESETS), { error: "Pick a niche." }),
    audience: text("Audience", 500),
    offers: text("Offers", 1000),
    tone: text("Tone", 300),
    sound_answers: z.object({
      greeting: text("This answer", 300),
      phrases: text("This answer", 300),
      never_say: text("This answer", 300),
    }),
    samples: z
      .array(z.string().trim().min(20, "Each writing sample needs at least 20 characters.").max(3000))
      .min(3, "Add at least 3 writing samples.")
      .max(5, "Add at most 5 writing samples."),
    banned_words: z
      .array(z.string())
      .max(50, "Add at most 50 banned words.")
      .default([])
      .transform((words) => [...new Set(words.map((word) => word.trim().toLowerCase()).filter(Boolean))]),
    language: z.enum(values(LANGUAGES), { error: "Pick a language." }).default("en"),
    posting_days: z
      .array(z.number().int().min(0).max(6), { error: "Pick at least one posting day." })
      .min(1, "Pick at least one posting day.")
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    posts_per_week: z
      .number({ error: "Posts per week must be a number." })
      .int("Posts per week must be a whole number.")
      .min(1, "Posts per week must be 1 to 14.")
      .max(14, "Posts per week must be 1 to 14."),
    audience_countries: z
      .array(z.enum(values(COUNTRIES)), { error: "Pick a country from the list." })
      .min(1, "Pick at least one country.")
      .max(3, "Pick up to 3 countries.")
      .default(["PK"]),
    autopilot_level: z.enum(values(AUTOPILOT_LEVELS)).default("review_everything"),
  })
  .refine((brand) => brand.posts_per_week <= brand.posting_days.length * MAX_POSTS_PER_DAY, {
    path: ["posts_per_week"],
    message: `Pick more posting days, or fewer posts per week (${MAX_POSTS_PER_DAY} a day at most).`,
  });

export type BrandInput = z.infer<typeof brandInputSchema>;

/** Starting values for the form (all optional). */
export type BrandFormDefaults = Partial<{
  name: string;
  niche: string;
  audience: string;
  offers: string;
  tone: string;
  sound_answers: Record<string, string>;
  samples: string[];
  banned_words: string[];
  language: string;
  posting_days: number[];
  posts_per_week: number;
  audience_countries: string[];
  autopilot_level: string;
}>;

/**
 * What the onboarding Server Action sends back to the form. `values` refills the
 * form after an error (React clears forms after each submit), and `attempt`
 * changes on every submit so the form redraws with them.
 */
export type BrandFormState = {
  status: "idle" | "error";
  message: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  values?: BrandFormDefaults;
  attempt?: number;
};

/** Turns zod problems into one list of messages per field, e.g. "sound_answers.greeting". */
export function brandFieldErrors(error: z.ZodError): Partial<Record<string, string[]>> {
  const out: Partial<Record<string, string[]>> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.filter((part) => typeof part !== "number").join(".") : "form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

const str = (data: FormData, key: string) => {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
};

/** Reads the onboarding form into the shape brandInputSchema expects (not yet checked). */
export function brandInputFromFormData(data: FormData): BrandFormDefaults {
  const countries = data.getAll("audience_countries").map(String).filter(Boolean);
  const postsPerWeek = str(data, "posts_per_week").trim();
  return {
    name: str(data, "name"),
    niche: str(data, "niche"),
    audience: str(data, "audience"),
    offers: str(data, "offers"),
    tone: str(data, "tone"),
    sound_answers: Object.fromEntries(SOUND_QUESTIONS.map((q) => [q.key, str(data, `sound_${q.key}`)])),
    samples: [1, 2, 3, 4, 5].map((n) => str(data, `sample_${n}`).trim()).filter(Boolean),
    banned_words: str(data, "banned_words")
      .split(/[,\n]/)
      .map((word) => word.trim())
      .filter(Boolean),
    language: str(data, "language") || undefined,
    posting_days: data.getAll("posting_days").map((day) => Number(day)),
    posts_per_week: postsPerWeek === "" ? undefined : Number(postsPerWeek),
    audience_countries: countries.length > 0 ? countries : undefined,
    autopilot_level: str(data, "autopilot_level") || undefined,
  };
}

// Samples are stored in one text column, separated by this line.
const SAMPLE_SEPARATOR = "\n\n-----\n\n";

export function joinSamples(samples: string[]): string {
  return samples.join(SAMPLE_SEPARATOR);
}

export function splitSamples(samples: string | null | undefined): string[] {
  if (!samples) return [];
  return samples
    .split(SAMPLE_SEPARATOR)
    .map((sample) => sample.trim())
    .filter(Boolean);
}

/** The row to insert into public.brands. */
export function brandInputToRow(input: BrandInput, opts: { ownerId: string; isManaged: boolean }) {
  return {
    owner_id: opts.ownerId,
    is_managed: opts.isManaged,
    name: input.name,
    niche: input.niche,
    audience: input.audience,
    offers: input.offers,
    tone: input.tone,
    sound_answers: input.sound_answers,
    samples: joinSamples(input.samples),
    banned_words: input.banned_words,
    language: input.language,
    posting_days: input.posting_days,
    posts_per_week: input.posts_per_week,
    audience_countries: input.audience_countries,
    autopilot_level: input.autopilot_level,
  };
}
