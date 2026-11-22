import { describe, expect, it } from "vitest";
import {
  alignTokens,
  audioHealthIssues,
  compareTranscript,
  keyTermsFor,
  maxWerFor,
  parseAstats,
  parseSilenceRanges,
  referenceText,
  speechTokens,
  wordErrorRate,
  type HeardWord,
} from "@/lib/qa/audio-checks";
import { AUDIO_QA } from "@/lib/qa/config";

// Gate 3 pure checks (QA-SPEC Gate 3): normalise, align, WER, key terms, audio health.

/** STT-style words, one every 0.4 s from 0.2 s. */
const heard = (text: string, gapAfter: Record<number, number> = {}): HeardWord[] => {
  let at = 0.2;
  return text.split(" ").map((w, i) => {
    const word = { text: w, start_s: Math.round(at * 1000) / 1000, end_s: Math.round((at + 0.32) * 1000) / 1000 };
    at += 0.4 + (gapAfter[i] ?? 0);
    return word;
  });
};

describe("speechTokens (the Gate 2 normaliser, then lowercase, no punctuation)", () => {
  it("lowercases, strips punctuation and accents, turns numbers into words, splits hyphens", () => {
    expect(speechTokens("Stop scrolling! 3 tips for your café's check-up.")).toEqual([
      "stop", "scrolling", "three", "tips", "for", "your", "cafes", "check", "up",
    ]);
    expect(speechTokens("Rs 2,999 only")).toEqual(["two", "thousand", "nine", "hundred", "and", "ninety", "nine", "rupees", "only"]);
    expect(speechTokens("I'm here")).toEqual(["im", "here"]);
  });
});

describe("alignTokens + wordErrorRate (Levenshtein over words)", () => {
  it("counts substitutions, deletions and insertions against the reference length", () => {
    const ref = ["book", "your", "free", "call", "today"];
    const hyp = ["book", "a", "free", "call", "today", "now"];
    const ops = alignTokens(ref, hyp);
    expect(ops.map((o) => o.op)).toEqual(["same", "sub", "same", "same", "same", "ins"]);
    expect(wordErrorRate(ops, ref.length)).toBeCloseTo(2 / 5, 5);
    expect(wordErrorRate(alignTokens(ref, ["book", "free", "call", "today"]), ref.length)).toBeCloseTo(1 / 5, 5);
    expect(wordErrorRate(alignTokens(ref, ref), ref.length)).toBe(0);
  });

  it("thresholds per language come from lib/qa/config.ts (unknown → English)", () => {
    expect(maxWerFor("en")).toBe(AUDIO_QA.max_wer.en);
    expect(maxWerFor("roman_urdu")).toBe(0.15);
    expect(maxWerFor("hinglish")).toBe(0.15);
    expect(maxWerFor("xx")).toBe(0.08);
  });
});

describe("referenceText: spoken_text with approved respellings turned back into the written word", () => {
  it("speech-to-text writes names the usual way, so a respelled name is compared as written", () => {
    const entries = [
      { written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" as const },
      { written: "Zee", say_as: "Zeee", status: "suggested" as const },
    ];
    expect(referenceText("Hi, I'm Aa-ee-sha from Zee.", entries)).toBe("Hi, I'm Ayesha from Zee.");
  });
});

describe("keyTermsFor", () => {
  it("brand name, each word of the person's name, offer names, CTA content words, every approved dictionary word", () => {
    const terms = keyTermsFor({
      brandName: "Bright Smile Dental",
      personName: "Ayesha Khan",
      offers: "Free check-up for new patients, Whitening for Rs 9,999",
      cta: "Book your free check-up today.",
      entries: [{ written: "Clifton", say_as: "Klif-tun", status: "approved" }, { written: "Zee", say_as: "Z", status: "suggested" }],
    });
    const by = (kind: string) => terms.filter((t) => t.kind === kind).map((t) => t.written);
    expect(by("brand")).toEqual(["Bright Smile Dental"]);
    expect(by("person")).toEqual(["Ayesha", "Khan"]);
    expect(by("offer")).toEqual(["Free check-up", "Whitening"]);
    expect(by("cta")).toEqual(["Book", "free", "check-up", "today"]);
    expect(terms.filter((t) => t.kind === "dictionary")).toEqual([{ written: "Clifton", kind: "dictionary", sayAs: "Klif-tun" }]);
  });
});

describe("compareTranscript", () => {
  const terms = keyTermsFor({ brandName: "Bright Smile Dental", personName: "Ayesha Khan", offers: null, cta: "Book today.", entries: [] });
  const reference = "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day. Book today.";

  it("a clean transcript: WER 0, no key-term mismatch", () => {
    const out = compareTranscript({ reference, heard: heard("hi i'm ayesha from bright smile dental brush twice a day book today"), terms });
    expect(out).toMatchObject({ wer: 0, refWords: 13, mismatches: [] });
  });

  it("a misheard name: the exact words and the time it was said", () => {
    const words = heard("hi i'm asia from bright smile dental brush twice a day book today");
    const out = compareTranscript({ reference, heard: words, terms });
    expect(out.mismatches).toEqual([
      { term: { written: "Ayesha", kind: "person", sayAs: null }, expected: "ayesha", heard: "asia", at_seconds: words[2].start_s },
    ]);
    expect(out.wer).toBeCloseTo(1 / 13, 5);
  });

  it("a word heard as two (whats app) still matches when the letters join up; a respelling heard as spelled matches too", () => {
    const t = keyTermsFor({
      brandName: "WhatsApp Pro", personName: null, offers: null, cta: "Call.",
      entries: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }],
    });
    const out = compareTranscript({ reference: "Use WhatsApp Pro with Ayesha. Call.", heard: heard("use whats app pro with aa ee sha call"), terms: t });
    expect(out.mismatches).toEqual([]);
  });

  it("extra words heard right at the term are part of what was heard (and the time is where they start)", () => {
    const words = heard("hi i'm same ear from bright smile dental brush twice a day book today");
    const t = keyTermsFor({ brandName: "Bright Smile Dental", personName: "Sameer", offers: null, cta: "Book today.", entries: [] });
    const out = compareTranscript({ reference: reference.replace("Ayesha", "Sameer"), heard: words, terms: t });
    expect(out.mismatches.map((m) => [m.expected, m.heard, m.at_seconds])).toEqual([["sameer", "same ear", words[2].start_s]]);
  });

  it("one place is reported once, even when the word is two kinds of key term (person + dictionary)", () => {
    const t = keyTermsFor({
      brandName: "Bright Smile Dental", personName: "Ayesha Khan", offers: null, cta: "Book today.",
      entries: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }],
    });
    const out = compareTranscript({ reference, heard: heard("hi i'm asia from bright smile dental brush twice a day book today"), terms: t });
    expect(out.mismatches.map((m) => [m.term.kind, m.heard])).toEqual([["person", "asia"]]);
  });

  it("a key term missing from the audio is a mismatch heard as nothing", () => {
    const out = compareTranscript({ reference, heard: heard("hi i'm from bright smile dental brush twice a day book today"), terms });
    expect(out.mismatches.map((m) => [m.expected, m.heard])).toEqual([["ayesha", ""]]);
    expect(out.mismatches[0].at_seconds).not.toBeNull();
  });
});

// Literal ffmpeg 7.1 output (captured from silencedetect and astats runs).
const SILENCE_STDERR = `[silencedetect @ 0x7f707c006c80] silence_start: 0.499979
[silencedetect @ 0x7f707c006c80] silence_end: 2.000042 | silence_duration: 1.500062
[silencedetect @ 0x7f707c006c80] silence_start: 4.499979
`;
const ASTATS_CLIPPED = `[Parsed_astats_0 @ 0x7f3110002f40] Max level: 1.000000
[Parsed_astats_0 @ 0x7f3110002f40] Peak level dB: 0.000000
[Parsed_astats_0 @ 0x7f3110002f40] Flat factor: 37.235216
[Parsed_astats_0 @ 0x7f3110002f40] Peak count: 64007.000000
[Parsed_astats_0 @ 0x7f3110002f40] Abs Peak count: 64007.000000`;
const ASTATS_CLEAN = `[Parsed_astats_0 @ 0x7f42dc002f40] Peak level dB: -0.915150
[Parsed_astats_0 @ 0x7f42dc002f40] Peak count: 80.000000`;

describe("ffmpeg parsers", () => {
  it("silencedetect: every range; one still open at the end runs to the end", () => {
    expect(parseSilenceRanges(SILENCE_STDERR, 5)).toEqual([
      { start_s: 0.5, end_s: 2 },
      { start_s: 4.5, end_s: 5 },
    ]);
    expect(parseSilenceRanges("", 5)).toEqual([]);
  });

  it("astats: overall peak level and peak count", () => {
    expect(parseAstats(ASTATS_CLIPPED)).toEqual({ peakDb: 0, peakCount: 64007 });
    expect(parseAstats(ASTATS_CLEAN)).toEqual({ peakDb: -0.92, peakCount: 80 });
    expect(parseAstats("nothing")).toEqual({ peakDb: null, peakCount: null });
  });
});

describe("audioHealthIssues", () => {
  const ok = { silences: [], astats: { peakDb: -3, peakCount: 2 }, estSeconds: 5, maxSeconds: 60 };

  it("healthy audio: no issues", () => {
    expect(audioHealthIssues({ ...ok, words: heard("one two three four five six seven eight nine ten eleven twelve"), durationS: 5 })).toEqual([]);
  });

  it("a word gap over 1.0 s inside speech fails, with the time it starts", () => {
    const words = heard("one two three four five six", { 2: 1.2 });
    const issues = audioHealthIssues({ ...ok, words, durationS: 5 });
    expect(issues).toEqual([expect.objectContaining({ code: "silence", severity: "hard", at_seconds: words[2].end_s })]);
  });

  it("silencedetect: a long silence inside speech fails; one before the first word or after the last does not", () => {
    const words = heard("one two three four five six seven eight nine ten eleven twelve");
    const inside = audioHealthIssues({ ...ok, words, silences: [{ start_s: 1.1, end_s: 2.3 }], durationS: 5 });
    expect(inside).toEqual([expect.objectContaining({ code: "silence", at_seconds: 1.1 })]);
    const edges = audioHealthIssues({ ...ok, words, silences: [{ start_s: 0, end_s: 0.19 }, { start_s: 4.9, end_s: 7 }], durationS: 5 });
    expect(edges).toEqual([]);
  });

  it("clipping: loud flat tops fail; a clean loud peak does not", () => {
    const words = heard("one two three four five six seven eight nine ten eleven twelve");
    expect(audioHealthIssues({ ...ok, words, astats: { peakDb: 0, peakCount: 64007 }, durationS: 5 }).map((i) => i.code)).toEqual(["clipping"]);
    expect(audioHealthIssues({ ...ok, words, astats: { peakDb: -0.05, peakCount: 2 }, durationS: 5 })).toEqual([]);
  });

  it("duration: more than ±15% off est_seconds fails; over the plan maximum always fails", () => {
    const words = heard("one two three");
    expect(audioHealthIssues({ ...ok, words, durationS: 5.74 })).toEqual([]);
    expect(audioHealthIssues({ ...ok, words, durationS: 5.8 }).map((i) => i.code)).toEqual(["duration_estimate"]);
    expect(audioHealthIssues({ ...ok, words, durationS: 4.2 }).map((i) => i.code)).toEqual(["duration_estimate"]);
    expect(audioHealthIssues({ ...ok, words, estSeconds: 59, durationS: 61 }).map((i) => i.code)).toEqual(["duration_max"]);
  });
});
