// Gate 2, steps 1 and 4: find words the voice may say wrong and that the
// brand dictionary doesn't cover yet. Claude (FAST) then suggests a
// respelling for each, saved as "suggested" for the operator to approve.
//
// A simple, documented rule (numbers, money, URLs, handles, emojis and common
// acronyms are already handled by the normaliser, so they are not "risky"):
// - names: a capitalised word that is NOT the first word of a sentence and
//   not a day, month, title or "I";
// - every word of the brand name that appears in the text;
// - acronyms (2 to 6 capitals) that aren't common ones (CEO, SEO, ...) or
//   said as a word by the normaliser (NASA, FREE, ...);
// - minus anything already in the dictionary (approved OR suggested), including
//   single words of a multi-word entry.
// Roman Urdu / Hindi words at the start of a sentence can slip through; Gate 3
// (audio QA) catches those and adds them to the dictionary.
import { PRONUNCIATION_PREP } from "@/lib/qa/config";
import { isReadAsWord } from "@/lib/pronunciation/normalise";

const COMMON_ACRONYMS = new Set([
  "CEO", "CFO", "CTO", "COO", "SEO", "ROI", "KPI", "USA", "UK", "UAE", "AI", "PDF", "FAQ", "DIY", "HR", "IT", "PR",
  "CV", "ATM", "GPS", "TV", "PM", "AM", "ID", "MBA", "DM", "DMs", "VIP", "SMS", "URL", "EMI", "GST", "VAT", "PKR",
  "AED", "USD", "INR", "B2B", "B2C", "FYI", "BTW",
]);

const NOT_NAMES = new Set([
  "I", "I'm", "I'll", "I've", "I'd",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
  "Dr", "Mr", "Mrs", "Ms", "Rs", "Doctor", "Sir", "Madam",
]);

const WEB_BITS = /(?:https?:\/\/)?(?:www\.)?[\p{L}\p{N}._-]*[\p{L}\p{N}]\.[a-z]{2,6}(?:\/\S*)?|[@#][\p{L}\p{N}_.]+/giu;
const WORD = /[\p{L}][\p{L}'’]*/gu;

/** The risky words in `text` the dictionary doesn't know yet, as first written, at most the configured number. */
export function findRiskyWords(text: string, opts: { brandName: string; known: string[] }): string[] {
  // A whole entry and each word in it ("Zee Lounge" covers "Zee" and "Lounge").
  const known = new Set(opts.known.flatMap((w) => [w.trim().toLowerCase(), ...w.trim().toLowerCase().split(/\s+/)]));
  const clean = text.replace(WEB_BITS, " ");
  const found = new Map<string, string>();
  const add = (word: string) => {
    const lower = word.toLowerCase();
    if (!known.has(lower) && !found.has(lower)) found.set(lower, word);
  };

  for (const sentence of clean.split(/(?<=[.?!])\s+/)) {
    const words = [...sentence.matchAll(WORD)].map((m) => m[0].replace(/['’]s$/, ""));
    words.forEach((word, index) => {
      if (/^[A-Z]{2,6}$/.test(word)) {
        if (!COMMON_ACRONYMS.has(word) && !isReadAsWord(word)) add(word);
        return;
      }
      if (index === 0 || NOT_NAMES.has(word) || word.length < 3) return;
      if (/^\p{Lu}\p{Ll}+$/u.test(word)) add(word);
    });
  }

  const inText = new Set([...clean.matchAll(WORD)].map((m) => m[0].toLowerCase()));
  for (const word of opts.brandName.match(WORD) ?? []) {
    if (word.length >= 3 && !NOT_NAMES.has(word) && inText.has(word.toLowerCase())) add(word);
  }

  return [...found.values()].slice(0, PRONUNCIATION_PREP.max_suggestions_per_script);
}
