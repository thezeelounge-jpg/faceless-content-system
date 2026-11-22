// Gate 3 checks (QA-SPEC "Gate 3: Audio and pronunciation QA"). Pure functions:
// no files, no processes, no network. lib/qa/audio-gate.ts runs them on the
// speech-to-text transcript (lib/stt.ts; never HeyGen's SRT) and the ffmpeg
// measurements of the raw render.
//
// 1. Normalise both texts the same way: the Gate 2 normaliser
//    (lib/pronunciation/normalise.ts: numbers, money, symbols → words), then
//    lowercase, no accents, no punctuation; hyphens split words.
// 2. The reference is spoken_text with every APPROVED respelling turned back into
//    the written word: speech-to-text writes "Ayesha", not "Aa-ee-sha".
// 3. Align word by word (Levenshtein over words) → WER = (subs + dels + ins) / reference words.
// 4. Key terms (brand name, each word of the person's name, offer names, CTA
//    content words, every approved dictionary word) must be heard exactly; a term
//    matches when the heard letters join up to the written OR the respelled form
//    ("whats app" = "WhatsApp"). Anything else is a mismatch, which Claude (FAST)
//    then judges: same sound (a spelling variant) or a real mispronunciation.
// 5. Audio health: no silence over AUDIO_QA.max_silence_s inside speech (word
//    gaps and silencedetect), no clipping (astats), duration within ±15% of
//    est_seconds and never over the plan maximum.
import { applyDictionary, type PronunciationEntry } from "@/lib/pronunciation/dictionary";
import { normaliseForSpeech } from "@/lib/pronunciation/normalise";
import { AUDIO_QA } from "@/lib/qa/config";
import type { QaIssue } from "@/lib/qa/script-checks";

export type HeardWord = { text: string; start_s: number; end_s: number };
export type AlignOp = { op: "same" | "sub" | "del" | "ins"; ref: number | null; hyp: number | null };
export type KeyTermKind = "brand" | "person" | "offer" | "cta" | "dictionary";
export type KeyTerm = { written: string; kind: KeyTermKind; sayAs: string | null };
export type TermMismatch = { term: KeyTerm; expected: string; heard: string; at_seconds: number | null };
export type TimeRange = { start_s: number; end_s: number };
export type Astats = { peakDb: number | null; peakCount: number | null };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Gate 2's normaliser, then lowercase words without accents or punctuation (hyphens split words). */
export function speechTokens(text: string): string[] {
  return normaliseForSpeech(text)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Word-level Levenshtein alignment of the reference (what should be said) with what was heard. */
export function alignTokens(ref: string[], hyp: string[]): AlignOp[] {
  const n = ref.length;
  const m = hyp.length;
  const cost = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diagonal = cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cost[i][j] = Math.min(diagonal, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && cost[i][j] === cost[i - 1][j - 1]) {
      ops.push({ op: "same", ref: --i, hyp: --j });
    } else if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + 1) {
      ops.push({ op: "sub", ref: --i, hyp: --j });
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      ops.push({ op: "del", ref: --i, hyp: null });
    } else {
      ops.push({ op: "ins", ref: null, hyp: --j });
    }
  }
  return ops.reverse();
}

/** (substitutions + deletions + insertions) / reference words. */
export function wordErrorRate(ops: AlignOp[], refLength: number): number {
  const errors = ops.filter((o) => o.op !== "same").length;
  return errors / Math.max(refLength, 1);
}

/** AUDIO_QA.max_wer for brands.language; anything unknown is held to the English limit. */
export function maxWerFor(language: string): number {
  const table: Record<string, number> = AUDIO_QA.max_wer;
  return table[language] ?? AUDIO_QA.max_wer.en;
}

/** spoken_text with each APPROVED respelling turned back into its written word. */
export function referenceText(spokenText: string, entries: PronunciationEntry[]): string {
  const flipped = entries
    .filter((e) => e.status === "approved" && e.say_as.trim() && e.written.trim())
    .map((e) => ({ written: e.say_as, say_as: e.written, status: "approved" as const }));
  return applyDictionary(spokenText, flipped);
}

/** Small words a call to action always has; they are not key terms. */
const CTA_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "at", "for", "with", "your", "you", "our", "my", "me", "we", "us",
  "is", "are", "be", "this", "that", "it", "its", "from", "by", "and", "can", "will",
]);

/** "Free check-up for new patients, Whitening for Rs 9,999" → ["Free check-up", "Whitening"] (names, no prices). */
function offerNames(offers: string | null): string[] {
  return (offers ?? "")
    .split(/[\n;]/)
    .flatMap((line) => line.split(/,(?!\d)/))
    .map((offer) => offer.trim().split(/\s+(?:for|at|@|-|–)\s+/i)[0]?.trim() ?? "")
    .filter((name) => name && name.split(/\s+/).length <= 6);
}

/** The words that must be heard exactly. Terms that are not in the script are simply not checked. */
export function keyTermsFor(input: {
  brandName: string;
  personName: string | null;
  offers: string | null;
  cta: string;
  entries: PronunciationEntry[];
}): KeyTerm[] {
  const approved = input.entries.filter((e) => e.status === "approved" && e.written.trim() && e.say_as.trim());
  const sayAsOf = (written: string) => approved.find((e) => e.written.trim().toLowerCase() === written.toLowerCase())?.say_as.trim() ?? null;
  const term = (written: string, kind: KeyTermKind): KeyTerm => ({ written, kind, sayAs: sayAsOf(written) });
  const bare = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

  const terms: KeyTerm[] = [];
  if (input.brandName.trim()) terms.push(term(input.brandName.trim(), "brand"));
  for (const word of (input.personName ?? "").split(/\s+/).map(bare)) {
    if (word.length >= 2) terms.push(term(word, "person"));
  }
  for (const name of offerNames(input.offers)) terms.push(term(name, "offer"));
  for (const word of input.cta.split(/\s+/).map(bare)) {
    if (word.replace(/[^\p{L}]/gu, "").length >= 3 && !CTA_STOPWORDS.has(word.toLowerCase())) terms.push(term(word, "cta"));
  }
  for (const e of approved) terms.push({ written: e.written.trim(), kind: "dictionary", sayAs: e.say_as.trim() });
  return terms;
}

type HeardToken = { token: string; start_s: number };

/** Places (first..last reference index) where `want` appears as a run of reference tokens. */
function occurrences(ref: string[], want: string[]): [number, number][] {
  if (want.length === 0) return [];
  const hits: [number, number][] = [];
  for (let k = 0; k + want.length <= ref.length; k++) {
    if (want.every((w, x) => ref[k + x] === w)) hits.push([k, k + want.length - 1]);
  }
  return hits;
}

/** WER and the key terms that were not heard as written (or as respelled). */
export function compareTranscript(input: { reference: string; heard: HeardWord[]; terms: KeyTerm[] }): {
  wer: number;
  refWords: number;
  mismatches: TermMismatch[];
} {
  const ref = speechTokens(input.reference);
  const hyp: HeardToken[] = [...input.heard]
    .sort((a, b) => a.start_s - b.start_s)
    .flatMap((w) => speechTokens(w.text).map((token) => ({ token, start_s: w.start_s })));
  const ops = alignTokens(ref, hyp.map((h) => h.token));
  const mismatches: TermMismatch[] = [];
  /** One report per place: a word that is two kinds of key term (person + dictionary) is listed once. */
  const reported = new Set<string>();

  for (const term of input.terms) {
    const want = speechTokens(term.written);
    const accepted = new Set([want.join(""), ...(term.sayAs ? [speechTokens(term.sayAs).join("")] : [])]);
    for (const [first, last] of occurrences(ref, want)) {
      const k1 = ops.findIndex((o) => o.ref === first);
      const k2 = ops.findIndex((o) => o.ref === last);
      const words = (from: number, to: number) =>
        ops.slice(from, to + 1).flatMap((o) => (o.hyp === null ? [] : [hyp[o.hyp].token]));
      // Extra words heard right before or after (no reference word of their own) may complete
      // the term: "whats app" for "whatsapp", "aa ee sha" for a respelled "Aa-ee-sha".
      const insBefore = (k: number) => (k > 0 && ops[k - 1].op === "ins" ? 1 : 0);
      let before = 0;
      while (before < 2 && insBefore(k1 - before)) before++;
      let after = 0;
      while (after < 2 && ops[k2 + after + 1]?.op === "ins") after++;
      let matched = false;
      for (let p = 0; p <= before && !matched; p++) {
        for (let f = 0; f <= after && !matched; f++) {
          if (accepted.has(words(k1 - p, k2 + f).join(""))) matched = true;
        }
      }
      if (matched || reported.has(`${first}-${last}`)) continue;
      reported.add(`${first}-${last}`);
      // What was heard there: the aligned words plus extra words right next to them ("same ear").
      const from = k1 - before;
      const to = k2 + after;
      const core = ops.slice(from, to + 1).filter((o) => o.hyp !== null);
      const nearest =
        core[0] ??
        ops
          .slice(0, from)
          .reverse()
          .find((o) => o.hyp !== null) ??
        ops.slice(to + 1).find((o) => o.hyp !== null);
      mismatches.push({
        term,
        expected: want.join(" "),
        heard: words(from, to).join(" "),
        at_seconds: nearest && nearest.hyp !== null ? hyp[nearest.hyp].start_s : null,
      });
    }
  }
  return { wer: wordErrorRate(ops, ref.length), refWords: ref.length, mismatches };
}

// ---------------------------------------------------------------------------
// ffmpeg output parsers
// ---------------------------------------------------------------------------

/** silencedetect ranges (seconds, 2 decimals); one still open at the end runs to durationS. */
export function parseSilenceRanges(stderr: string, durationS: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (start) open = Math.max(0, Number(start[1]));
    const end = line.match(/silence_end:\s*(\d+(?:\.\d+)?)/);
    if (end && open !== null) {
      ranges.push({ start_s: round2(open), end_s: round2(Number(end[1])) });
      open = null;
    }
  }
  if (open !== null) ranges.push({ start_s: round2(open), end_s: round2(durationS) });
  return ranges;
}

/** astats (measure_perchannel=none): the overall "Peak level dB" and "Peak count" (the last ones printed). */
export function parseAstats(stderr: string): Astats {
  const level = [...stderr.matchAll(/Peak level dB:\s*(-?(?:inf|\d+(?:\.\d+)?))/g)].at(-1)?.[1];
  const count = [...stderr.matchAll(/(?<!Abs )Peak count:\s*(\d+(?:\.\d+)?)/g)].at(-1)?.[1];
  return {
    peakDb: level === undefined ? null : level.endsWith("inf") ? -Infinity : round2(Number(level)) || 0,
    peakCount: count === undefined ? null : Number(count),
  };
}

// ---------------------------------------------------------------------------
// Audio health
// ---------------------------------------------------------------------------

const hard = (code: string, detail: string, at: number | null): QaIssue => ({ code, detail, at_seconds: at, severity: "hard" });

/** Silences inside speech (word gaps and silencedetect ranges within the first..last word), merged. */
function silencesInSpeech(words: HeardWord[], ranges: TimeRange[]): TimeRange[] {
  const sorted = [...words].sort((a, b) => a.start_s - b.start_s);
  if (sorted.length === 0) return [];
  const from = sorted[0].start_s;
  const to = Math.max(...sorted.map((w) => w.end_s));
  const found: TimeRange[] = [];
  for (let k = 1; k < sorted.length; k++) found.push({ start_s: sorted[k - 1].end_s, end_s: sorted[k].start_s });
  for (const r of ranges) found.push({ start_s: Math.max(r.start_s, from), end_s: Math.min(r.end_s, to) });
  const merged: TimeRange[] = [];
  for (const r of found.filter((x) => x.end_s > x.start_s).sort((a, b) => a.start_s - b.start_s)) {
    const last = merged.at(-1);
    if (last && r.start_s <= last.end_s) last.end_s = Math.max(last.end_s, r.end_s);
    else merged.push({ ...r });
  }
  return merged;
}

export function audioHealthIssues(input: {
  words: HeardWord[];
  silences: TimeRange[];
  astats: Astats;
  durationS: number;
  estSeconds: number;
  maxSeconds: number;
}): QaIssue[] {
  const issues: QaIssue[] = [];
  for (const s of silencesInSpeech(input.words, input.silences)) {
    const length = round2(s.end_s - s.start_s);
    if (length > AUDIO_QA.max_silence_s) {
      issues.push(hard("silence", `${length} s of silence in the middle of speech (limit ${AUDIO_QA.max_silence_s} s).`, round2(s.start_s)));
    }
  }
  const { peakDb, peakCount } = input.astats;
  if (peakDb !== null && peakCount !== null && peakDb >= AUDIO_QA.clip_peak_dbfs && peakCount >= AUDIO_QA.clip_min_peak_count) {
    issues.push(hard("clipping", `The voice clips (peak ${peakDb} dBFS reached ${peakCount} times).`, null));
  }
  const d = round2(input.durationS);
  if (d > input.maxSeconds) {
    issues.push(hard("duration_max", `The video is ${d} s long; the plan allows ${input.maxSeconds} s.`, null));
  }
  if (input.estSeconds > 0 && Math.abs(input.durationS - input.estSeconds) / input.estSeconds > AUDIO_QA.duration_tolerance) {
    issues.push(
      hard(
        "duration_estimate",
        `The video is ${d} s long; the script was estimated at ${input.estSeconds} s (allowed ±${AUDIO_QA.duration_tolerance * 100}%).`,
        null,
      ),
    );
  }
  return issues;
}
