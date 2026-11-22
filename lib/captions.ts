import { PlainError } from "@/lib/plain-error";
import type { Transcript } from "@/lib/stt";

// Captions (Phase 4, docs/EDITOR-NOTES.md). Rule from PROMPTS.md: the TEXT
// comes from the script's display_text (what the viewer should read, with the
// brand's own spelling and punctuation), the TIMINGS come from speech-to-text
// (when each word was really said). alignWords() pairs them word by word;
// groupPages() makes pages of at most 2 lines; buildAss() writes an .ass
// subtitle file that ffmpeg's `subtitles` filter (libass) burns in.
//
// Highlight: big_words uses ONE EVENT PER WORD (the whole page is repeated,
// with only the word being said in the brand colour), not karaoke \k tags:
// \k fills words progressively and leaves them coloured, we want only the
// current word coloured. small_box and minimal show one event per page.

export type CaptionStyleName = "big_words" | "small_box" | "minimal";
export const CAPTION_STYLE_NAMES = ["big_words", "small_box", "minimal"] as const;
export const DEFAULT_CAPTION_STYLE: CaptionStyleName = "big_words";

/**
 * Where captions may go on the 1080x1920 frame (numbers in docs/EDITOR-NOTES.md).
 * - safe: keep clear of platform buttons and text. QA-SPEC Gate 4 forbids the
 *   top 12% (230 px), bottom 20% (384 px) and right 12% (130 px); we use a bit
 *   more, and the same 140 px on both sides so captions stay centred.
 * - face_zone: where a talking-head's face and mouth sit in a 9:16 HeyGen
 *   frame (our estimate, UNCONFIRMED until the first real render; Gate 5
 *   checks frames). Captions must start BELOW face_zone.bottom.
 * So captions live in the lower-middle band y = 1150 to 1500.
 */
export const CAPTION_LAYOUT = {
  width: 1080,
  height: 1920,
  safe: { top: 250, bottom: 420, left: 140, right: 140 },
  face_zone: { top: 300, bottom: 1150 },
  /** A page stays up this long after its last word, unless the next page starts sooner. */
  page_hold_s: 0.3,
  /** A pause this long between words starts a new page. */
  pause_break_s: 0.5,
} as const;

export type CaptionStyle = {
  /** The font's family name inside the file (libass finds it in the fontsdir). */
  font: string;
  /** The file in assets/fonts/ (OFL, see assets/fonts/licenses/README.md). */
  font_file: string;
  size: number;
  uppercase: boolean;
  primary: string;
  /** Outline colour; with border_style 3 this is the colour of the box. */
  outline_colour: string;
  /** 0 = opaque, 255 = invisible (ASS alpha). */
  outline_alpha: number;
  /** Shadow colour. */
  back_colour: string;
  /** 1 = outline around letters, 3 = a box behind the text. */
  border_style: 1 | 3;
  /** Outline thickness, or the box padding with border_style 3. */
  outline: number;
  shadow: number;
  /** The word being said in the brand colour. */
  highlight_active_word: boolean;
  max_chars_per_line: number;
  /** At most this many words on one line (p4-b1: big_words 3). Unset = only the letter limit. */
  max_words_per_line?: number;
  max_words_per_page: number;
  /** Average letter width as a share of the font size (rough, used for layout checks). */
  char_width_em: number;
  line_height: number;
};

/** The 3 caption styles. Change looks here and nowhere else. */
export const CAPTION_STYLES: Record<CaptionStyleName, CaptionStyle> = {
  big_words: {
    // p4-b1 (Rowan 5d): bigger (104 px) and bolder. Anton has one weight, so "bolder" is a
    // thicker 8 px outline plus a 3 px drop shadow, not libass's synthetic bold (it smears
    // letter shapes). 1-3 words per line, 2 lines (6 words) per page; 14 letters still fit
    // the 800 px between the side margins (14 × 104 × 0.52 ≈ 757 px).
    font: "Anton", font_file: "Anton-Regular.ttf", size: 104, uppercase: true, primary: "#FFFFFF",
    outline_colour: "#000000", outline_alpha: 0, back_colour: "#000000", border_style: 1, outline: 8, shadow: 3,
    highlight_active_word: true, max_chars_per_line: 14, max_words_per_line: 3, max_words_per_page: 6, char_width_em: 0.52,
    line_height: 1.2,
  },
  small_box: {
    // Opaque box: libass draws one box per line and the two overlap; a
    // see-through box showed the overlap as a darker stripe (p4-artifacts).
    font: "Poppins Bold", font_file: "Poppins-Bold.ttf", size: 60, uppercase: false, primary: "#FFFFFF",
    outline_colour: "#141414", outline_alpha: 0, back_colour: "#000000", border_style: 3, outline: 14, shadow: 0,
    highlight_active_word: false, max_chars_per_line: 20, max_words_per_page: 10, char_width_em: 0.58, line_height: 1.2,
  },
  minimal: {
    font: "Poppins SemiBold", font_file: "Poppins-SemiBold.ttf", size: 54, uppercase: false, primary: "#FFFFFF",
    outline_colour: "#000000", outline_alpha: 0, back_colour: "#000000", border_style: 1, outline: 2, shadow: 1,
    highlight_active_word: false, max_chars_per_line: 24, max_words_per_page: 10, char_width_em: 0.57, line_height: 1.2,
  },
};

/** Used when the brand has no valid colour (#RRGGBB). */
export const DEFAULT_HIGHLIGHT_COLOUR = "#FFD400";
export const NO_WORDS_HEARD = "The voice track has no words we could time, so captions can't be made.";

export type CaptionWord = {
  /** Exactly as written in display_text (punctuation kept). */
  text: string;
  start_s: number;
  end_s: number;
  /**
   * matched = same word; substituted = heard differently (a misheard name);
   * merged = one display word heard as several ("WhatsApp" → "whats app");
   * split = several display words heard as one ("can not" → "cannot");
   * interpolated = not heard at all, timed between its neighbours.
   */
  source: "matched" | "substituted" | "merged" | "split" | "interpolated";
  /** Which transcript words gave the timing (indexes into transcript.words). */
  stt_indexes: number[];
};

export type CaptionPage = {
  lines: CaptionWord[][];
  start_s: number;
  end_s: number;
  /** 1 = normal size; below 1 when a single long word would not fit the line. */
  scale: number;
};

export type CaptionBox = { top: number; bottom: number; left: number; right: number };

/** A caption page has at most this many lines (groupPages). */
export const MAX_PAGE_LINES = 2;

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

/**
 * The form we compare words in: lowercase, no accents, no punctuation.
 * Whole numbers 0 to 20 become words ("3" = "three"); bigger numbers stay digits.
 */
export function normalizeToken(word: string): string {
  const plain = word
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (/^\d+$/.test(plain) && Number(plain) <= 20) return SMALL_NUMBERS[Number(plain)];
  return plain;
}

/** display_text split on spaces; a token that is only punctuation ("—") joins the word before it. */
function displayTokens(text: string): string[] {
  const out: string[] = [];
  let prefix = "";
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (normalizeToken(token) !== "") {
      out.push(prefix ? `${prefix} ${token}` : token);
      prefix = "";
    } else if (out.length > 0) {
      out[out.length - 1] += ` ${token}`;
    } else {
      prefix = prefix ? `${prefix} ${token}` : token;
    }
  }
  if (prefix) out.push(prefix); // the whole text was punctuation
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

type Step =
  | { op: "pair"; i: number; j: number; same: boolean }
  | { op: "merge"; i: number; j: number; k: number } // display i ← stt j-k+1..j
  | { op: "split"; i: number; j: number; k: number } // display i-k+1..i ← stt j
  | { op: "skip_display"; i: number }
  | { op: "skip_stt"; j: number };

/**
 * Pairs display words with transcript words by edit distance (dynamic
 * programming): a same word costs 0, a different word 1, a missing or extra
 * word 1; one display word heard as 2-3 words (or the reverse) costs 0 when
 * the letters join up exactly. Display words never paired get times between
 * their neighbours, shared out by length.
 */
export function alignWords(displayText: string, transcript: Transcript): CaptionWord[] {
  if (transcript.words.length === 0) throw new PlainError(NO_WORDS_HEARD);
  const stt = transcript.words
    .map((w, index) => ({ ...w, index, norm: normalizeToken(w.text) }))
    .sort((a, b) => a.start_s - b.start_s || a.index - b.index);
  const texts = displayTokens(displayText);
  const disp = texts.map(normalizeToken);
  const n = disp.length;
  const m = stt.length;
  const same = (a: string, b: string) => a !== "" && a === b;

  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  const back: (Step | null)[][] = Array.from({ length: n + 1 }, () => new Array<Step | null>(m + 1).fill(null));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity;
      let step: Step | null = null;
      const consider = (c: number, s: Step) => {
        if (c < best) {
          best = c;
          step = s;
        }
      };
      if (i > 0 && j > 0) {
        const isSame = same(disp[i - 1], stt[j - 1].norm);
        if (isSame) consider(cost[i - 1][j - 1], { op: "pair", i: i - 1, j: j - 1, same: true });
        for (let k = 2; k <= 3; k++) {
          if (j >= k && same(disp[i - 1], stt.slice(j - k, j).map((w) => w.norm).join(""))) {
            consider(cost[i - 1][j - k], { op: "merge", i: i - 1, j: j - 1, k });
          }
          if (i >= k && same(disp.slice(i - k, i).join(""), stt[j - 1].norm)) {
            consider(cost[i - k][j - 1], { op: "split", i: i - 1, j: j - 1, k });
          }
        }
        if (!isSame) consider(cost[i - 1][j - 1] + 1, { op: "pair", i: i - 1, j: j - 1, same: false });
      }
      if (i > 0) consider(cost[i - 1][j] + 1, { op: "skip_display", i: i - 1 });
      if (j > 0) consider(cost[i][j - 1] + 1, { op: "skip_stt", j: j - 1 });
      cost[i][j] = best;
      back[i][j] = step;
    }
  }

  const out: (CaptionWord | null)[] = new Array(n).fill(null);
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const step = back[i][j]!;
    if (step.op === "pair") {
      const w = stt[step.j];
      out[step.i] = {
        text: texts[step.i], start_s: w.start_s, end_s: w.end_s,
        source: step.same ? "matched" : "substituted", stt_indexes: [w.index],
      };
      i--;
      j--;
    } else if (step.op === "merge") {
      const parts = stt.slice(step.j - step.k + 1, step.j + 1);
      out[step.i] = {
        text: texts[step.i], start_s: parts[0].start_s, end_s: parts.at(-1)!.end_s,
        source: "merged", stt_indexes: parts.map((p) => p.index),
      };
      i--;
      j -= step.k;
    } else if (step.op === "split") {
      const w = stt[step.j];
      const first = step.i - step.k + 1;
      const lengths = disp.slice(first, step.i + 1).map((d) => Math.max(d.length, 1));
      const total = lengths.reduce((a, b) => a + b, 0);
      let at = w.start_s;
      lengths.forEach((len, x) => {
        const end = x === lengths.length - 1 ? w.end_s : round3(at + ((w.end_s - w.start_s) * len) / total);
        out[first + x] = { text: texts[first + x], start_s: at, end_s: end, source: "split", stt_indexes: [w.index] };
        at = end;
      });
      i -= step.k;
      j--;
    } else if (step.op === "skip_display") {
      i--;
    } else {
      j--;
    }
  }

  // Words nobody said: share the gap between the neighbours that were heard.
  const PER_WORD_S = 0.4;
  for (let i = 0; i < n; ) {
    if (out[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && !out[end]) end++;
    const count = end - i;
    const prev = i > 0 ? out[i - 1] : null;
    const next = end < n ? out[end] : null;
    let left = prev ? prev.end_s : null;
    let right = next ? next.start_s : null;
    if (left === null) left = Math.max(0, (right ?? 0) - PER_WORD_S * count);
    if (right === null) right = Math.max(left, Math.min(Math.max(transcript.duration_s, left), left + PER_WORD_S * count));
    right = Math.max(right, left);
    const lengths = disp.slice(i, end).map((d) => Math.max(d.length, 1));
    const total = lengths.reduce((a, b) => a + b, 0);
    let at = left;
    for (let x = 0; x < count; x++) {
      const stop = x === count - 1 ? right : round3(at + ((right - left) * lengths[x]) / total);
      out[i + x] = { text: texts[i + x], start_s: round3(at), end_s: round3(stop), source: "interpolated", stt_indexes: [] };
      at = stop;
    }
    i = end;
  }
  return out as CaptionWord[];
}

// ---------------------------------------------------------------------------
// Pages and layout
// ---------------------------------------------------------------------------

const shown = (w: CaptionWord, style: CaptionStyle) => (style.uppercase ? w.text.toLocaleUpperCase() : w.text);
const lineLength = (line: CaptionWord[], style: CaptionStyle) =>
  line.reduce((sum, w, i) => sum + shown(w, style).length + (i > 0 ? 1 : 0), 0);
const usableWidth = () => CAPTION_LAYOUT.width - CAPTION_LAYOUT.safe.left - CAPTION_LAYOUT.safe.right;

/**
 * Words → pages of at most 2 lines. A line holds at most max_chars_per_line
 * letters; a page at most max_words_per_page words. A new page starts after a
 * sentence ends (. ! ?) or at a pause of pause_break_s or more.
 */
export function groupPages(words: CaptionWord[], styleName: CaptionStyleName): CaptionPage[] {
  const style = CAPTION_STYLES[styleName];
  const groups: CaptionWord[][][] = [];
  let lines: CaptionWord[][] = [[]];
  let count = 0;
  const flush = () => {
    if (count > 0) groups.push(lines);
    lines = [[]];
    count = 0;
  };
  words.forEach((w, i) => {
    let line = lines[lines.length - 1];
    const tooLong = lineLength(line, style) + 1 + shown(w, style).length > style.max_chars_per_line;
    const tooManyWords = style.max_words_per_line !== undefined && line.length >= style.max_words_per_line;
    if (line.length > 0 && (tooLong || tooManyWords)) {
      if (lines.length === MAX_PAGE_LINES) flush();
      else lines.push([]);
      line = lines[lines.length - 1];
    }
    line.push(w);
    count++;
    const next = words[i + 1];
    const sentenceEnd = /[.!?…]["'”’)\]]*$/.test(w.text);
    const pause = next !== undefined && next.start_s - w.end_s >= CAPTION_LAYOUT.pause_break_s;
    if (!next || sentenceEnd || pause || count >= style.max_words_per_page) flush();
  });

  const maxWidth = usableWidth() - 2 * (style.outline + style.shadow);
  return groups.map((group, g) => {
    const last = group.at(-1)!.at(-1)!;
    const nextStart = groups[g + 1]?.[0][0].start_s;
    const hold = round3(last.end_s + CAPTION_LAYOUT.page_hold_s);
    const widest = Math.max(...group.map((l) => lineLength(l, style))) * style.size * style.char_width_em;
    return {
      lines: group,
      start_s: group[0][0].start_s,
      end_s: nextStart === undefined ? hold : Math.max(last.end_s, Math.min(hold, nextStart)),
      scale: widest > maxWidth ? Math.floor((maxWidth / widest) * 100) / 100 : 1,
    };
  });
}

/** Bottom margin: the safe zone plus the outline/box and shadow drawn outside the text. */
const marginV = (style: CaptionStyle) => CAPTION_LAYOUT.safe.bottom + style.outline + style.shadow;

/**
 * The top edge (y, unrounded) of a page box with this many lines: the bottom is
 * fixed at the safe zone, so more lines reach higher. With MAX_PAGE_LINES at
 * scale 1 this is the highest a style's captions ever go (p5-a3: the trial
 * centre mark sits between the face zone and this line, lib/edit.ts).
 */
export function captionBoxTop(styleName: CaptionStyleName, lines: number, scale = 1): number {
  const style = CAPTION_STYLES[styleName];
  const textBottom = CAPTION_LAYOUT.height - marginV(style);
  return textBottom - lines * style.size * style.line_height * scale - (style.outline + style.shadow);
}

/**
 * Where a page lands on the frame (estimated from letter widths): bottom-centred
 * between the side margins, bottom edge at the safe zone. Used by the tests and
 * by Gate 4 (Phase 5) as the caption layout check.
 */
export function estimatePageBox(page: CaptionPage, styleName: CaptionStyleName): CaptionBox {
  const style = CAPTION_STYLES[styleName];
  const { width, height, safe } = CAPTION_LAYOUT;
  const textWidth = Math.max(...page.lines.map((l) => lineLength(l, style))) * style.size * style.char_width_em * page.scale;
  const pad = style.outline + style.shadow;
  const centre = safe.left + (width - safe.left - safe.right) / 2;
  const textBottom = height - marginV(style);
  return {
    top: Math.round(captionBoxTop(styleName, page.lines.length, page.scale)),
    bottom: Math.round(textBottom + pad),
    left: Math.round(centre - textWidth / 2 - pad),
    right: Math.round(centre + textWidth / 2 + pad),
  };
}

// ---------------------------------------------------------------------------
// The .ass file
// ---------------------------------------------------------------------------

/**
 * Makes user text safe inside an .ass Dialogue line (no injection):
 * - newlines and tabs become spaces (one Dialogue line stays one line; we
 *   place our own \N line breaks);
 * - a backslash becomes "/" (libass reads \N, \n, \h, \{ and \} as commands
 *   and has no escape for a backslash itself);
 * - { and } become \{ and \} (libass: "literal curly brackets independent of
 *   context by escaping them with backslashes", github.com/libass/libass/wiki/Libass'-ASS-Extensions),
 *   so user text can never open an override tag block.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\r\n|[\r\n\t\v\f]/g, " ")
    .replace(/\\/g, "/")
    .replace(/[{}]/g, (c) => `\\${c}`);
}

const HEX = /^#[0-9a-f]{6}$/i;

/** "#RRGGBB" → "BBGGRR" (ASS colours are blue-green-red). */
function bgr(hex: string): string {
  return `${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
}

/** Style colour with alpha: &HAABBGGRR (00 = opaque). */
function styleColour(hex: string, alpha: number): string {
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${bgr(hex)}`;
}

/** h:mm:ss.cc */
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

export type BuildAssInput = {
  displayText: string;
  transcript: Transcript;
  style?: CaptionStyleName;
  /** The brand colour (#RRGGBB) for the active word in big_words. */
  brandColour?: string | null;
  /**
   * The script's edit_plan.emphasis_words (p4-b1). big_words only: on a page that holds an
   * emphasis word, the emphasis word(s) stay coloured for the whole page; pages without one
   * colour the word being spoken. Other styles ignore it.
   */
  emphasisWords?: string[];
};

/** The compare-forms of every word in the emphasis list ("free call" → "free", "call"). */
function emphasisSet(list: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const phrase of list ?? []) {
    for (const token of phrase.split(/\s+/)) {
      const norm = normalizeToken(token);
      if (norm) out.add(norm);
    }
  }
  return out;
}

export function buildAss(input: BuildAssInput): string {
  const name = input.style ?? DEFAULT_CAPTION_STYLE;
  const style = CAPTION_STYLES[name];
  const pages = groupPages(alignWords(input.displayText, input.transcript), name);
  const { width, height, safe } = CAPTION_LAYOUT;
  const highlight = bgr(input.brandColour && HEX.test(input.brandColour) ? input.brandColour : DEFAULT_HIGHLIGHT_COLOUR);
  const primary = bgr(style.primary);

  const header = [
    "[Script Info]",
    "; Made by lib/captions.ts",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    `LayoutResX: ${width}`,
    `LayoutResY: ${height}`,
    "WrapStyle: 2", // never wrap by itself: our \N breaks keep pages at 2 lines
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    [
      `Style: ${name}`, style.font, style.size,
      styleColour(style.primary, 0), styleColour(style.primary, 0),
      styleColour(style.outline_colour, style.outline_alpha), styleColour(style.back_colour, 0x80),
      0, 0, 0, 0, 100, 100, 0, 0, style.border_style, style.outline, style.shadow,
      2, safe.left, safe.right, marginV(style), 1,
    ].join(","),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  const dialogue = (start: number, end: number, text: string) => {
    if (Math.round(end * 100) <= Math.round(start * 100)) return; // too short to show
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${name},,0,0,0,,${text}`);
  };

  const emphasis = emphasisSet(input.emphasisWords);
  for (const page of pages) {
    const prefix = page.scale < 1 ? `{\\fscx${Math.round(page.scale * 100)}\\fscy${Math.round(page.scale * 100)}}` : "";
    const render = (coloured: (w: CaptionWord) => boolean) =>
      prefix +
      page.lines
        .map((line) =>
          line
            .map((w) => {
              const text = escapeAssText(shown(w, style));
              return coloured(w) ? `{\\c&H${highlight}&}${text}{\\c&H${primary}&}` : text;
            })
            .join(" "),
        )
        .join("\\N");

    if (!style.highlight_active_word) {
      dialogue(page.start_s, page.end_s, render(() => false));
      continue;
    }
    const all = page.lines.flat();
    // p4-b1 (Rowan 5d) key word rule: the edit plan's emphasis word(s) on this page, else the spoken word.
    const keys = all.filter((w) => emphasis.has(normalizeToken(w.text)));
    if (keys.length > 0) {
      dialogue(page.start_s, page.end_s, render((w) => keys.includes(w)));
      continue;
    }
    all.forEach((w, k) => {
      const start = k === 0 ? page.start_s : w.start_s;
      const end = k === all.length - 1 ? page.end_s : all[k + 1].start_s;
      dialogue(start, end, render((x) => x === w));
    });
  }

  return [...header, ...events, ""].join("\n");
}
