import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import script from "@/tests/fixtures/stt/sample-script.json";
import fixture from "@/tests/fixtures/stt/sample-transcript.json";
import {
  CAPTION_LAYOUT,
  CAPTION_STYLES,
  CAPTION_STYLE_NAMES,
  DEFAULT_CAPTION_STYLE,
  NO_WORDS_HEARD,
  alignWords,
  buildAss,
  escapeAssText,
  estimatePageBox,
  groupPages,
  normalizeToken,
  type CaptionStyleName,
  type CaptionWord,
} from "@/lib/captions";
import type { Transcript } from "@/lib/stt";

// lib/captions.ts: TEXT from display_text, TIMINGS from speech-to-text,
// pages of at most 2 lines inside the safe zone, written as an .ass file.

const transcript = fixture as Transcript;
const words = (list: [string, number, number][]): Transcript => ({
  language: "en",
  duration_s: list.at(-1)?.[2] ?? 0,
  words: list.map(([text, start_s, end_s]) => ({ text, start_s, end_s })),
});

/** The aligned word with this text; fails the test (not a crash) when missing. */
function pick(list: CaptionWord[], text: string): CaptionWord {
  const found = list.find((w) => w.text === text);
  expect(found, `word "${text}"`).toBeDefined();
  return found as CaptionWord;
}

/** "0:00:01.36" → 1.36 */
const assTime = (t: string) => {
  const [h, m, s] = t.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

function parseAss(ass: string) {
  const lines = ass.split("\n");
  const styles = lines
    .filter((l) => l.startsWith("Style: "))
    .map((l) => {
      const f = l.slice(7).split(",");
      return {
        name: f[0], font: f[1], size: Number(f[2]), borderStyle: Number(f[15]), alignment: Number(f[18]),
        marginL: Number(f[19]), marginR: Number(f[20]), marginV: Number(f[21]),
      };
    });
  const events = lines
    .filter((l) => l.startsWith("Dialogue: "))
    .map((l) => {
      const f = l.slice(10).split(",");
      return {
        start: assTime(f[1]), end: assTime(f[2]), style: f[3],
        marginL: Number(f[5]), marginR: Number(f[6]), marginV: Number(f[7]), text: f.slice(9).join(","),
      };
    });
  return { lines, styles, events };
}

describe("normalizeToken", () => {
  it("lowercases, strips punctuation and accents, and spells small numbers", () => {
    expect(normalizeToken("Café,")).toBe("cafe");
    expect(normalizeToken("WhatsApp.")).toBe("whatsapp");
    expect(normalizeToken("Rowan's")).toBe("rowans");
    expect(normalizeToken("3")).toBe("three");
    expect(normalizeToken("12")).toBe("twelve");
    expect(normalizeToken("250")).toBe("250");
    expect(normalizeToken("—")).toBe("");
  });
});

describe("alignWords", () => {
  it("exact match: every word takes its speech-to-text times", () => {
    const out = alignWords("Hello there, friend.", words([["hello", 0.1, 0.4], ["there", 0.4, 0.7], ["friend", 0.8, 1.2]]));
    expect(out.map((w) => [w.text, w.start_s, w.end_s, w.source])).toEqual([
      ["Hello", 0.1, 0.4, "matched"],
      ["there,", 0.4, 0.7, "matched"],
      ["friend.", 0.8, 1.2, "matched"],
    ]);
  });

  it("keeps the display_text spelling and punctuation, in display order", () => {
    const out = alignWords(script.display_text, transcript);
    expect(out.map((w) => w.text)).toEqual(script.display_text.split(" "));
  });

  it("a word the speech-to-text missed gets times between its neighbours", () => {
    const out = alignWords(script.display_text, transcript);
    const a = pick(out, "a");
    expect(a.source).toBe("interpolated");
    expect(a.start_s).toBeCloseTo(4.62, 5);
    expect(a.end_s).toBeCloseTo(4.7, 5);
  });

  it("an extra speech-to-text word ('um') is skipped, not given to a display word", () => {
    const out = alignWords(script.display_text, transcript);
    const to = pick(out, "to");
    expect([to.start_s, to.end_s]).toEqual([2.62, 2.72]);
    expect(out.some((w) => w.stt_indexes.includes(7))).toBe(false); // index 7 = "um"
  });

  it("a word split by speech-to-text ('whats app') spans both parts", () => {
    const out = alignWords(script.display_text, transcript);
    const w = pick(out, "WhatsApp.");
    expect(w.source).toBe("merged");
    expect([w.start_s, w.end_s]).toEqual([3.68, 4.18]);
  });

  it("two display words heard as one ('can not' vs 'cannot') share its time", () => {
    const out = alignWords("I can not wait", words([["i", 0, 0.2], ["cannot", 0.2, 0.8], ["wait", 0.8, 1.1]]));
    expect(out.map((w) => w.source)).toEqual(["matched", "split", "split", "matched"]);
    expect(out[1].start_s).toBe(0.2);
    expect(out[2].end_s).toBe(0.8);
    expect(out[1].end_s).toBeCloseTo(out[2].start_s, 5);
  });

  it("'3' in the script matches 'three' heard", () => {
    const three = pick(alignWords(script.display_text, transcript), "3");
    expect([three.start_s, three.end_s, three.source]).toEqual([1.48, 1.74, "matched"]);
  });

  it("a misheard word still takes the time of the word heard in its place", () => {
    const out = alignWords("Call Rowan now", words([["call", 0, 0.3], ["rohan", 0.3, 0.7], ["now", 0.7, 1]]));
    expect(out[1]).toMatchObject({ text: "Rowan", start_s: 0.3, end_s: 0.7, source: "substituted" });
  });

  it("every display word gets times; times never go backwards", () => {
    for (const text of [script.display_text, "Extra words the voice never said at the end here", "Only"]) {
      const out = alignWords(text, transcript);
      expect(out).toHaveLength(text.split(" ").length);
      out.forEach((w, i) => {
        expect(w.end_s).toBeGreaterThanOrEqual(w.start_s);
        if (i > 0) expect(w.start_s).toBeGreaterThanOrEqual(out[i - 1].end_s - 1e-9);
      });
    }
  });

  it("a punctuation-only token sticks to the word before it", () => {
    const out = alignWords("Wait — what", words([["wait", 0, 0.3], ["what", 0.5, 0.8]]));
    expect(out.map((w) => w.text)).toEqual(["Wait —", "what"]);
  });

  it("every matched word is within 150 ms of its speech-to-text word (Gate 4 rule)", () => {
    const out = alignWords(script.display_text, transcript);
    expect(out.filter((x) => x.stt_indexes.length > 0)).toHaveLength(17); // all but the missed "a"
    for (const w of out.filter((x) => x.stt_indexes.length > 0)) {
      const first = transcript.words[w.stt_indexes[0]];
      const last = transcript.words[w.stt_indexes.at(-1)!];
      if (w.source !== "split") {
        expect(Math.abs(w.start_s - first.start_s)).toBeLessThanOrEqual(0.15);
        expect(Math.abs(w.end_s - last.end_s)).toBeLessThanOrEqual(0.15);
      }
    }
  });

  it("refuses with a plain error when no words were heard", () => {
    expect(() => alignWords("Hello", { language: "en", duration_s: 3, words: [] })).toThrow(NO_WORDS_HEARD);
  });
});

describe("groupPages", () => {
  const long =
    "This is a much longer caption line that keeps going and going so that it has to be split across several pages of captions";
  const longTranscript = words(long.split(" ").map((w, i) => [w.toLowerCase(), i * 0.3, i * 0.3 + 0.28]));

  it.each(CAPTION_STYLE_NAMES)("%s: at most 2 lines per page, each line within the style's width", (name) => {
    const pages = groupPages(alignWords(long, longTranscript), name);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.lines.length).toBeGreaterThanOrEqual(1);
      expect(page.lines.length).toBeLessThanOrEqual(2);
      for (const line of page.lines) {
        expect(line.map((w) => w.text).join(" ").length).toBeLessThanOrEqual(CAPTION_STYLES[name].max_chars_per_line);
      }
      expect(page.lines.flat().length).toBeLessThanOrEqual(CAPTION_STYLES[name].max_words_per_page);
    }
    expect(pages.flatMap((p) => p.lines.flat()).map((w) => w.text).join(" ")).toBe(long);
  });

  it("starts a new page after a sentence ends", () => {
    const pages = groupPages(alignWords(script.display_text, transcript), "minimal");
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].lines.flat().map((w) => w.text).join(" ")).toBe("Stop scrolling!");
  });

  it("a page shows from its first word until the next page (or a short hold)", () => {
    const pages = groupPages(alignWords(script.display_text, transcript), "big_words");
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => {
      expect(p.start_s).toBe(p.lines[0][0].start_s);
      const next = pages[i + 1];
      if (next) expect(p.end_s).toBeLessThanOrEqual(next.start_s);
      expect(p.end_s).toBeLessThanOrEqual(p.lines.at(-1)!.at(-1)!.end_s + CAPTION_LAYOUT.page_hold_s + 1e-9);
    });
  });

  it("a single word too long for a line is shrunk to fit", () => {
    const text = "Supercalifragilisticexpialidocious";
    const pages = groupPages(alignWords(text, words([["supercalifragilisticexpialidocious", 0, 1]])), "big_words");
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.scale).toBeLessThan(1);
    const box = estimatePageBox(page, "big_words");
    expect(box.right - box.left).toBeLessThanOrEqual(CAPTION_LAYOUT.width - CAPTION_LAYOUT.safe.left - CAPTION_LAYOUT.safe.right);
  });
});

describe("safe zone", () => {
  const { width, height, safe, face_zone } = CAPTION_LAYOUT;

  it("the numbers keep clear of platform buttons (QA-SPEC: top 12%, bottom 20%, right 12%)", () => {
    expect(safe.top).toBeGreaterThanOrEqual(0.12 * height);
    expect(safe.bottom).toBeGreaterThanOrEqual(0.2 * height);
    expect(safe.right).toBeGreaterThanOrEqual(0.12 * width);
    expect(safe.left).toBeGreaterThanOrEqual(80);
  });

  it.each(CAPTION_STYLE_NAMES)("%s: every page sits inside the safe zone and below the face", (name) => {
    for (const text of [script.display_text, "Supercalifragilisticexpialidocious works", "Hi"]) {
      const pages = groupPages(alignWords(text, transcript), name);
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        const box = estimatePageBox(page, name);
        expect(box.left).toBeGreaterThanOrEqual(safe.left);
        expect(box.right).toBeLessThanOrEqual(width - safe.right);
        expect(box.bottom).toBeLessThanOrEqual(height - safe.bottom);
        expect(box.top).toBeGreaterThanOrEqual(safe.top);
        expect(box.top).toBeGreaterThanOrEqual(face_zone.bottom); // never over the mouth
      }
    }
  });

  it.each(CAPTION_STYLE_NAMES)("%s: the .ass style is bottom-centred with safe-zone margins; events add none", (name) => {
    const { styles, events } = parseAss(buildAss({ displayText: script.display_text, transcript, style: name }));
    expect(styles).toHaveLength(1);
    // The outline/box is drawn outside the text, so the bottom margin adds it on top of the safe zone.
    const s = CAPTION_STYLES[name];
    expect(styles[0]).toMatchObject({
      name, alignment: 2, marginL: safe.left, marginR: safe.right, marginV: safe.bottom + s.outline + s.shadow,
    });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect([e.marginL, e.marginR, e.marginV]).toEqual([0, 0, 0]); // 0 = use the style's margins
      expect(e.text).not.toMatch(/\\(pos|move|an\d|a\d|org|fs\d)/); // nothing moves text out of the band
    }
  });
});

describe("buildAss", () => {
  it("defaults to big_words", () => {
    expect(DEFAULT_CAPTION_STYLE).toBe("big_words");
    const { styles } = parseAss(buildAss({ displayText: script.display_text, transcript }));
    expect(styles[0].name).toBe("big_words");
  });

  it("writes a 1080x1920 script with no automatic wrapping and the bundled font names", () => {
    for (const name of CAPTION_STYLE_NAMES) {
      const ass = buildAss({ displayText: script.display_text, transcript, style: name });
      expect(ass).toContain("PlayResX: 1080\n");
      expect(ass).toContain("PlayResY: 1920\n");
      expect(ass).toContain("WrapStyle: 2\n");
      expect(ass).toContain("ScaledBorderAndShadow: yes\n");
      expect(parseAss(ass).styles[0].font).toBe(CAPTION_STYLES[name].font);
    }
    expect(CAPTION_STYLES.small_box.border_style).toBe(3); // the box
  });

  it("box styles use an opaque box (libass draws one box per line; see-through boxes overlap as a dark stripe)", () => {
    for (const name of CAPTION_STYLE_NAMES) {
      if (CAPTION_STYLES[name].border_style === 3) expect(CAPTION_STYLES[name].outline_alpha).toBe(0);
    }
  });

  it("big_words: one event per word, the active word in the brand colour", () => {
    const { events } = parseAss(buildAss({ displayText: script.display_text, transcript, brandColour: "#FF5A1F" }));
    expect(events).toHaveLength(script.display_text.split(" ").length);
    // p4-b1: at 104 px "STOP SCROLLING!" (15 letters) no longer fits one line, so it breaks.
    expect(events[0].text).toBe("{\\c&H1F5AFF&}STOP{\\c&HFFFFFF&}\\NSCROLLING!");
    expect(events[1].text).toBe("STOP\\N{\\c&H1F5AFF&}SCROLLING!{\\c&HFFFFFF&}");
  });

  it("big_words: each word's event starts within 150 ms of its speech-to-text word", () => {
    const aligned = alignWords(script.display_text, transcript);
    const { events } = parseAss(buildAss({ displayText: script.display_text, transcript }));
    expect(events).toHaveLength(aligned.length);
    expect(aligned).toHaveLength(18);
    aligned.forEach((w, i) => {
      if (w.source === "matched" || w.source === "merged" || w.source === "substituted") {
        expect(Math.abs(events[i].start - transcript.words[w.stt_indexes[0]].start_s)).toBeLessThanOrEqual(0.15);
      }
    });
  });

  it("small_box and minimal: one event per page, lines joined with \\N", () => {
    for (const style of ["small_box", "minimal"] as const) {
      const { events } = parseAss(buildAss({ displayText: script.display_text, transcript, style }));
      const pages = groupPages(alignWords(script.display_text, transcript), style);
      expect(events.map((e) => e.text)[0]).toBe("Stop scrolling!");
      expect(events).toHaveLength(pages.length);
      expect(events.some((e) => e.text.includes("\\N"))).toBe(true);
      expect(events.some((e) => e.text.includes("\\c&H"))).toBe(false); // no highlight
    }
  });

  it("p4-b1 5d: small_box and minimal output is UNCHANGED (byte-identical to the files recorded before the big_words change)", () => {
    const texts = [script.display_text, "Supercalifragilisticexpialidocious works", "Hi"];
    for (const style of ["small_box", "minimal"] as const) {
      const golden = readFileSync(path.join(process.cwd(), `tests/fixtures/captions/${style}.golden.ass`), "utf8");
      const now = texts.map((displayText) =>
        buildAss({ displayText, transcript, style, brandColour: "#FF5A1F", emphasisWords: script.edit_plan.emphasis_words }),
      );
      expect(now.join("\n;-----\n")).toBe(golden);
    }
  });

  it("p4-b1 5d: big_words is bigger and bolder: 90-110 px, a thicker outline than part A (6 px)", () => {
    const s = CAPTION_STYLES.big_words;
    expect(s.size).toBeGreaterThanOrEqual(90);
    expect(s.size).toBeLessThanOrEqual(110);
    expect(s.size).toBeGreaterThan(96);
    expect(s.outline).toBeGreaterThan(6);
  });

  it("p4-b1 5d: big_words lines hold 1-3 words, pages at most 2 lines", () => {
    const long =
      "Here are 3 quick tips to grow your café on WhatsApp and keep every regular coming back for more coffee every single week.";
    const shortWords = "I am so so so glad we did it at last.";
    for (const text of [script.display_text, long, shortWords, "Hi"]) {
      for (const page of groupPages(alignWords(text, transcript), "big_words")) {
        expect(page.lines.length).toBeLessThanOrEqual(2);
        for (const line of page.lines) {
          expect(line.length).toBeGreaterThanOrEqual(1);
          expect(line.length).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("p4-b1 5d: the key word is highlighted: a page with an edit_plan emphasis word keeps THAT word coloured; other pages colour the spoken word", () => {
    const ass = buildAss({
      displayText: script.display_text,
      transcript,
      brandColour: "#FF5A1F",
      emphasisWords: script.edit_plan.emphasis_words, // ["3", "WhatsApp", "free"]
    });
    const texts = parseAss(ass).events.map((e) => e.text);
    const on = (w: string) => `{\\c&H1F5AFF&}${w}{\\c&HFFFFFF&}`;
    // "Stop scrolling!" has no emphasis word → the spoken word is coloured, one event per word.
    expect(texts[0]).toBe(`${on("STOP")}\\NSCROLLING!`);
    expect(texts[1]).toBe(`STOP\\N${on("SCROLLING!")}`);
    // Every event that shows "3" colours "3" and nothing else.
    const plain = (t: string) => t.replace(/\{[^}]*\}/g, "").split(/\\N| /);
    const withThree = texts.filter((t) => plain(t).includes("3"));
    expect(withThree.length).toBeGreaterThan(0);
    for (const t of withThree) {
      expect(t).toContain(on("3"));
      expect(t.match(/\\c&H1F5AFF&/g)).toHaveLength(1);
    }
    // WhatsApp and FREE are coloured wherever they show.
    for (const word of ["WHATSAPP.", "FREE"]) {
      const shown = texts.filter((t) => t.includes(word));
      expect(shown.length).toBeGreaterThan(0);
      for (const t of shown) expect(t).toContain(on(word));
    }
  });

  it("p4-b1 5d: without emphasis words, big_words colours the spoken word (part A behaviour)", () => {
    const { events } = parseAss(buildAss({ displayText: "Grow your cafe", transcript: words([["grow", 0, 0.4], ["your", 0.4, 0.7], ["cafe", 0.7, 1.2]]) }));
    expect(events.map((e) => e.text)).toEqual([
      "{\\c&H00D4FF&}GROW{\\c&HFFFFFF&} YOUR CAFE",
      "GROW {\\c&H00D4FF&}YOUR{\\c&HFFFFFF&} CAFE",
      "GROW YOUR {\\c&H00D4FF&}CAFE{\\c&HFFFFFF&}",
    ]);
  });

  it("an invalid brand colour falls back to the default highlight", () => {
    const ass = buildAss({ displayText: "Hello", transcript: words([["hello", 0, 1]]), brandColour: "red;}{\\b1" });
    expect(parseAss(ass).events.map((e) => e.text)).toEqual(["{\\c&H00D4FF&}HELLO{\\c&HFFFFFF&}"]);
  });
});

describe("no .ass injection from user text", () => {
  it("escapes braces, removes backslash sequences and newlines", () => {
    expect(escapeAssText("a{b}c")).toBe("a\\{b\\}c");
    expect(escapeAssText("x\\Ny\\nz\\h")).toBe("x/Ny/nz/h");
    expect(escapeAssText("line1\nline2\r\nline3\tend")).toBe("line1 line2 line3 end");
    expect(escapeAssText("{\\fs200\\pos(0,0)}big")).toBe("\\{/fs200/pos(0,0)\\}big");
  });

  it("a hostile display_text cannot add tags or lines to the file", () => {
    const hostile = "Hi {\\pos(10,10)\\fs300}there\nDialogue: 0,0:00:00.00,9:00:00.00,big_words,,0,0,0,,owned";
    const t = words(hostile.split(/\s+/).map((w, i) => [w.replace(/[^a-z]/gi, "").toLowerCase() || "x", i * 0.3, i * 0.3 + 0.2]));
    for (const style of CAPTION_STYLE_NAMES as readonly CaptionStyleName[]) {
      const { events, lines } = parseAss(buildAss({ displayText: hostile, transcript: t, style }));
      expect(events.length).toBeGreaterThan(0);
      expect(lines.some((l) => l.startsWith("Dialogue: 0,0:00:00.00,9:00:00.00"))).toBe(false);
      expect(events.every((e) => e.start < 60 && e.end < 60)).toBe(true);
      expect(events.some((e) => /\{\\pos/.test(e.text))).toBe(false);
      expect(events.some((e) => /\{\\fs300/.test(e.text))).toBe(false);
      expect(events.some((e) => e.text.includes("\\{/pos(10,10)/fs300\\}") || e.text.includes("\\{/POS(10,10)/FS300\\}"))).toBe(true);
    }
  });
});
