// The brand's "How to say names" dictionary (public.pronunciations), Gate 2 step 3.
//
// Only APPROVED entries are used; suggested ones wait for the operator (or,
// later, the customer). Matching is whole-word and ignores case; longer
// entries win ("Dr Ayesha Clinic" before "Ayesha"); every place is replaced
// in one pass, so a say-as form is never replaced again.
//
// spoken_text = dictionary first, then the normaliser (lib/pronunciation/normalise.ts).
// We apply the dictionary to the WRITTEN words first so entries like "PKLI"
// or "@zee_lounge" match before the normaliser spells or splits them, and we
// protect the say-as form so the normaliser never changes it.
import { z } from "zod";
import { normaliseForSpeech } from "@/lib/pronunciation/normalise";
import { wholeWordPattern } from "@/lib/qa/script-checks";

/** One dictionary row: `written` as it appears in display_text, `say_as` for spoken_text. */
export type PronunciationEntry = {
  written: string;
  say_as: string;
  status: "suggested" | "approved";
};

/** What the admin form accepts for one entry. */
export const pronunciationInput = z.object({
  written: z
    .string()
    .trim()
    .min(1, "Type the word as it is written.")
    .max(80, "Keep the written word under 80 characters.")
    .regex(/^[^\n\r]+$/, "Use one line."),
  say_as: z
    .string()
    .trim()
    .min(1, "Type how to say it.")
    .max(120, "Keep “say as” under 120 characters.")
    .regex(/^[^\n\r\d]+$/, "Write “say as” in letters only (no digits or new lines)."),
});

const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

function approvedLongestFirst(entries: PronunciationEntry[]): PronunciationEntry[] {
  return entries
    .filter((e) => e.status === "approved" && e.written.trim() && e.say_as.trim())
    .sort((a, b) => b.written.trim().length - a.written.trim().length);
}

function replaceEntries(text: string, entries: PronunciationEntry[], replace: (entry: PronunciationEntry) => string): string {
  const list = approvedLongestFirst(entries);
  if (list.length === 0) return text;
  const byKey = new Map(list.map((entry) => [key(entry.written), entry]));
  const pattern = new RegExp(list.map((entry) => wholeWordPattern(entry.written).source).join("|"), "giu");
  return text.replace(pattern, (match) => {
    const entry = byKey.get(key(match));
    return entry ? replace(entry) : match;
  });
}

/** Replaces every approved `written` with its `say_as`. Suggested entries are ignored. */
export function applyDictionary(text: string, entries: PronunciationEntry[]): string {
  return replaceEntries(text, entries, (entry) => entry.say_as.trim());
}

// Private-use characters stand in for say-as forms while the normaliser runs.
const SLOT_START = 0xe000;

/** display_text → spoken_text: approved dictionary entries, then the normaliser. display_text is not changed. */
export function buildSpokenText(displayText: string, entries: PronunciationEntry[]): string {
  const sayAs: string[] = [];
  const protectedText = replaceEntries(displayText, entries, (entry) => {
    sayAs.push(entry.say_as.trim());
    return String.fromCharCode(SLOT_START + sayAs.length - 1);
  });
  return normaliseForSpeech(protectedText).replace(/[-]/g, (slot) => sayAs[slot.charCodeAt(0) - SLOT_START] ?? "");
}
