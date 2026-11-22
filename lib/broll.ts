import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeToken } from "@/lib/captions";
import { isMockPexels } from "@/lib/config";
import { PlainError } from "@/lib/plain-error";
import { BROLL } from "@/lib/qa/config";

// B-roll (Phase 4 part B, docs/EDITOR-NOTES.md "B-roll").
//
// 1. The provider: `BrollProvider.search(keyword, { orientation, minDuration_s })`
//    returns vertical clips as LOCAL files. Only the mock exists (MOCK_PEXELS,
//    on unless exactly "false"): clips from tests/fixtures/broll/ (made by
//    scripts/make-fixtures.sh). With MOCK_PEXELS=false the search throws a
//    plain "not set up yet": there is deliberately NO Pexels client in this
//    phase (a key and Zee's OK first). A real provider will download each
//    chosen clip into the edit's temp folder and return the same shape.
// 2. The planner `planBroll` (pure): where the cut-ins go. Rules (numbers in
//    BROLL, lib/qa/config.ts): at each edit_plan moment (its at_words found in
//    the aligned caption words), 1.5 to 3 s each, 2 to 4 when they fit, never
//    during the hook (start → end of its last word) or the CTA (its first word
//    → the end), total coverage within the format limit, no overlaps and a
//    short face gap between cuts. The voice keeps playing: b-roll only
//    replaces the picture (lib/edit.ts overlays it under the captions).

export type TimedWord = { text: string; start_s: number; end_s: number };

export type BrollClip = {
  id: string;
  keyword: string;
  /** Absolute path of a local file ffmpeg can read. */
  file: string;
  width: number;
  height: number;
  duration_s: number;
  source: "mock";
};

export type BrollSearchOptions = { orientation: "portrait"; minDuration_s: number };

export interface BrollProvider {
  /** Best first. Only portrait clips at least minDuration_s long. */
  search(keyword: string, options: BrollSearchOptions): Promise<BrollClip[]>;
}

export const BROLL_NOT_SET_UP = "B-roll search is not set up yet.";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type Catalogue = {
  clips: Record<string, { file: string; width: number; height: number; duration_s: number }>;
  keywords: Record<string, string[]>;
};

export const MOCK_BROLL_DIR = path.join(process.cwd(), "tests", "fixtures", "broll");

/** Local fixture clips (tests/fixtures/broll/catalogue.json). Never touches the network. */
export function mockBrollProvider(dir: string = MOCK_BROLL_DIR): BrollProvider {
  return {
    async search(keyword, options) {
      let catalogue: Catalogue;
      try {
        catalogue = JSON.parse(readFileSync(path.join(dir, "catalogue.json"), "utf8")) as Catalogue;
      } catch (error) {
        // No mock catalogue here (a deployed task has no tests/fixtures): same plain message.
        throw new PlainError(BROLL_NOT_SET_UP, { cause: error });
      }
      const usable = (ids: string[]) =>
        ids
          .map((id) => ({ id, clip: catalogue.clips[id] }))
          .filter(({ clip }) => clip && clip.height > clip.width && clip.duration_s >= options.minDuration_s);
      const wanted = keyword.trim().toLowerCase();
      const words = wanted.split(/\s+/);
      let ids = catalogue.keywords[wanted] ?? [];
      if (ids.length === 0) {
        // A catalogue keyword that is one of the search words ("WhatsApp chat" → "whatsapp").
        ids = Object.entries(catalogue.keywords)
          .filter(([key]) => key !== "default" && key.split(/\s+/).every((k) => words.includes(k)))
          .flatMap(([, list]) => list);
      }
      let found = usable([...new Set(ids)]);
      if (found.length === 0) found = usable(catalogue.keywords.default ?? []);
      return found.map(({ id, clip }) => ({
        id,
        keyword,
        file: path.join(dir, clip.file),
        width: clip.width,
        height: clip.height,
        duration_s: clip.duration_s,
        source: "mock" as const,
      }));
    },
  };
}

/** The mock unless MOCK_PEXELS is exactly "false"; then a plain error (no real client exists yet). */
export function getBrollProvider(): BrollProvider {
  if (isMockPexels()) return mockBrollProvider();
  return {
    async search() {
      throw new PlainError(BROLL_NOT_SET_UP);
    },
  };
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

export type BrollMoment = { at_words: string; keyword: string };
export type PlannedCut = { start_s: number; duration_s: number; keyword: string; at_words: string | null };
export type SkipReason = "not_found" | "protected" | "no_room" | "coverage" | "max_cuts" | "overlap";
export type BrollPlan = {
  /** In time order. */
  cuts: PlannedCut[];
  skipped: { at_words: string; why: SkipReason }[];
  /** null when the hook or CTA could not be found: then nothing is cut in. */
  protected: { hook_end_s: number; cta_start_s: number } | null;
  coverage_s: number;
  max_coverage_s: number;
};
export type PlanBrollInput = {
  /** The aligned caption words (lib/captions.ts alignWords): display text with speech-to-text timings. */
  words: TimedWord[];
  /** script.edit_plan.broll_moments. */
  moments: BrollMoment[];
  /** script.broll_keywords: used only to add cuts when fewer than BROLL.min_cuts moments fit. */
  keywords?: string[];
  format: "talking" | "story";
  durationS: number;
  /** script.hook and script.cta (display_text = hook + body + cta). */
  hook: string;
  cta: string;
};

const ms = (s: number) => Math.round(s * 1000) / 1000;
const EPS = 1e-9;

const phrase = (text: string) => text.split(/\s+/).map(normalizeToken).filter(Boolean);

/** Start indexes (into `words`) of every place the phrase's tokens appear in a row. */
function findPhrase(words: TimedWord[], text: string): { first: number; last: number }[] {
  const want = phrase(text);
  if (want.length === 0) return [];
  // Words whose normal form is empty (punctuation only) are skipped.
  const tokens = words.map((w, i) => ({ t: normalizeToken(w.text), i })).filter((x) => x.t !== "");
  const hits: { first: number; last: number }[] = [];
  for (let k = 0; k + want.length <= tokens.length; k += 1) {
    if (want.every((w, j) => tokens[k + j].t === w)) hits.push({ first: tokens[k].i, last: tokens[k + want.length - 1].i });
  }
  return hits;
}

export function planBroll(input: PlanBrollInput): BrollPlan {
  const maxCoverage = ms(BROLL.max_coverage[input.format] * input.durationS);
  const plan: BrollPlan = { cuts: [], skipped: [], protected: null, coverage_s: 0, max_coverage_s: maxCoverage };
  const { words } = input;

  const hook = findPhrase(words, input.hook)[0];
  const cta = findPhrase(words, input.cta).at(-1);
  const hookEnd = hook ? words[hook.last].end_s : NaN;
  const ctaStart = cta ? words[cta.first].start_s : NaN;
  if (!hook || !cta || !(hookEnd < ctaStart)) {
    // Can't tell where the face must stay: keep it on screen the whole time.
    plan.skipped = input.moments.map((m) => ({ at_words: m.at_words, why: "protected" }));
    return plan;
  }
  plan.protected = { hook_end_s: hookEnd, cta_start_s: ctaStart };
  const windowEnd = Math.min(ctaStart, input.durationS);
  const used = () => plan.cuts.reduce((sum, c) => sum + c.duration_s, 0);

  // 1. Each moment → its first occurrence between the hook and the CTA.
  const candidates: { start: number; moment: BrollMoment }[] = [];
  for (const moment of input.moments) {
    const hits = findPhrase(words, moment.at_words);
    const inside = hits.find((h) => words[h.first].start_s >= hookEnd - EPS && words[h.first].start_s < ctaStart);
    if (inside) candidates.push({ start: words[inside.first].start_s, moment });
    else plan.skipped.push({ at_words: moment.at_words, why: hits.length > 0 ? "protected" : "not_found" });
  }
  candidates.sort((a, b) => a.start - b.start);

  // 2. Place them in time order.
  for (const { start, moment } of candidates) {
    const skip = (why: SkipReason) => plan.skipped.push({ at_words: moment.at_words, why });
    if (plan.cuts.length >= BROLL.max_cuts) {
      skip("max_cuts");
      continue;
    }
    const prev = plan.cuts.at(-1);
    // Shorten the previous cut so the face shows again before this one, if it stays long enough.
    let prevDuration = prev?.duration_s ?? 0;
    if (prev && start < prev.start_s + prev.duration_s + BROLL.min_gap_s - EPS) {
      prevDuration = ms(start - BROLL.min_gap_s - prev.start_s);
      if (prevDuration < BROLL.min_cut_s - EPS) {
        skip("overlap");
        continue;
      }
    }
    const room = windowEnd - start;
    const left = maxCoverage - (used() - (prev?.duration_s ?? 0) + prevDuration);
    const duration = ms(Math.min(BROLL.target_cut_s, BROLL.max_cut_s, room, left));
    if (duration < BROLL.min_cut_s - EPS) {
      skip(room < BROLL.min_cut_s - EPS ? "no_room" : "coverage");
      continue; // the previous cut keeps its full length
    }
    if (prev) prev.duration_s = prevDuration;
    plan.cuts.push({ start_s: ms(start), duration_s: duration, keyword: moment.keyword, at_words: moment.at_words });
  }

  // 3. Fewer than BROLL.min_cuts: add cuts in the biggest free gaps, searched with unused broll_keywords.
  const spare = (input.keywords ?? []).filter((k) => !plan.cuts.some((c) => c.keyword === k));
  while (plan.cuts.length < BROLL.min_cuts && spare.length > 0) {
    let best: { start: number; end: number } | null = null;
    let from = hookEnd;
    for (const c of [...plan.cuts, null]) {
      const end = c ? c.start_s - BROLL.min_gap_s : windowEnd;
      if (!best || end - from > best.end - best.start) best = { start: from, end };
      if (c) from = c.start_s + c.duration_s + BROLL.min_gap_s;
    }
    const duration = ms(Math.min(BROLL.target_cut_s, BROLL.max_cut_s, best!.end - best!.start, maxCoverage - used()));
    if (duration < BROLL.min_cut_s - EPS) break;
    plan.cuts.push({ start_s: ms(best!.start), duration_s: duration, keyword: spare.shift()!, at_words: null });
    plan.cuts.sort((a, b) => a.start_s - b.start_s);
  }

  plan.coverage_s = ms(used());
  return plan;
}
