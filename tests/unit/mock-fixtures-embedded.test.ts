import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ayeshaMisheard from "@/tests/fixtures/stt/gate3-ayesha-misheard.json";

// p5-b1 (QA SF2): the default mocks (MOCK_STT keyed transcripts, MOCK_CLAUDE key_term_check answers)
// must work inside a Trigger.dev build, where tests/fixtures is NOT on disk and process.cwd() is the
// build folder. They are embedded (static JSON imports, bundled), so no file is read at run time.
// Simulated here: the working folder is an empty temp folder before the modules load.

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadWithEmptyCwd() {
  const empty = await mkdtemp(path.join(os.tmpdir(), "no-fixtures-"));
  vi.spyOn(process, "cwd").mockReturnValue(empty);
  vi.resetModules();
  const stt = await import("@/lib/stt");
  const keyTerms = await import("@/lib/qa/key-term-mock");
  return { stt, keyTerms };
}

describe("mock fixtures without tests/ on disk (the cwd is somewhere else)", () => {
  it("mock speech-to-text still picks the keyed transcript by the spoken text", async () => {
    const { stt } = await loadWithEmptyCwd();
    const heard = await stt.mockSttProvider.transcribe({
      audioPath: "/tmp/raw.mp4",
      expectedText: "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day.",
    });
    expect(heard.words.map((w) => w.text)).toEqual(ayeshaMisheard.words.map((w) => w.text));
  });

  it("the key_term_check mock still answers from the judgements (a known same-sound pair)", async () => {
    const { keyTerms } = await loadWithEmptyCwd();
    const out = keyTerms.mockKeyTermCheck({ language: "en", terms: [{ written: "Ayesha", heard: "aisha" }] });
    expect(out.judgements).toEqual([{ written: "Ayesha", heard: "aisha", verdict: "same_sound", respelling: "" }]);
  });

  it("every by-text rule points at an embedded transcript (a missing one fails at load, not at run time)", async () => {
    const { stt } = await loadWithEmptyCwd();
    for (const text of ["aa-ee-sha from bright smile dental", "sa-meer from bright smile dental", "sameer from bright smile dental"]) {
      const heard = await stt.mockSttProvider.transcribe({ audioPath: "/tmp/raw.mp4", expectedText: text });
      expect(heard.words.length).toBeGreaterThan(0);
    }
  });

  it("p5-b2: the Gate 5 visual_qa mock still answers from its embedded fixtures", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "no-fixtures-"));
    vi.spyOn(process, "cwd").mockReturnValue(empty);
    vi.resetModules();
    const { mockVisualQa, VISUAL_FIXTURE_TEXTS } = await import("@/lib/qa/visual-mock");
    const out = mockVisualQa({
      language: "en", display_text: VISUAL_FIXTURE_TEXTS["face-glitch"], caption_style: "big_words",
      frames: [{ index: 0, at_seconds: 0, kind: "first", caption: "" }],
    });
    expect(out).toMatchObject({ face_natural: false, realism_score: 5 });
  });
});
