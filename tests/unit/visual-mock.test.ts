import { describe, expect, it } from "vitest";
import { visualQaOutput, type VisualQaInput } from "@/lib/ai-schemas";
import { runClaudeTask } from "@/lib/claude";
import { mockVisualQa, VISUAL_FIXTURE_TEXTS } from "@/lib/qa/visual-mock";

// p5-b2: MOCK_CLAUDE answers for Gate 5 (visual_qa). Deterministic: the fixture is chosen by the
// display text (tests/fixtures/visual/answers.json, embedded like the Gate 3 mocks), never a live call.
// "captions-over-mouth" answers captions_clear_of_face = false only for the caption styles listed in
// the fixture, so the re-edit with a lower style really changes the answer.

const frames = (n: number): VisualQaInput["frames"] =>
  Array.from({ length: n }, (_, i) => ({ index: i, at_seconds: i * 2, kind: i === 0 ? ("first" as const) : ("every_2s" as const), caption: "" }));
const input = (display_text: string, caption_style: VisualQaInput["caption_style"] = "big_words", n = 4): VisualQaInput => ({
  language: "en", display_text, caption_style, frames: frames(n),
});

describe("mockVisualQa", () => {
  it("an unknown text → the good answer (realism 9, face inside the zone, no issues)", () => {
    const out = mockVisualQa(input("Something nobody registered."));
    expect(visualQaOutput.parse(out)).toEqual(out);
    expect(out).toMatchObject({ realism_score: 9, captions_clear_of_face: true, face_natural: true, issues: [] });
    expect(out.face_box!.bottom).toBeLessThanOrEqual(1150);
  });

  it("captions-over-mouth: big_words covers the mouth (issue at a real frame); small_box does not", () => {
    const text = VISUAL_FIXTURE_TEXTS["captions-over-mouth"];
    const bad = mockVisualQa(input(text, "big_words"));
    expect(bad.captions_clear_of_face).toBe(false);
    expect(bad.issues).toEqual([{ field: "captions_clear_of_face", frame: 1, detail: expect.stringMatching(/mouth/) }]);
    const fixed = mockVisualQa(input(text, "small_box"));
    expect(fixed).toMatchObject({ captions_clear_of_face: true, issues: [] });
  });

  it("face-glitch fails every time (face + realism); the issue frame never points past the frames sent", () => {
    const out = mockVisualQa(input(VISUAL_FIXTURE_TEXTS["face-glitch"], "small_box", 1));
    expect(out).toMatchObject({ face_natural: false, realism_score: 5 });
    expect(out.issues.every((i) => i.frame === 0)).toBe(true);
  });

  it("face-too-low reports a chin below the face zone; realism-8 passes at the margin", () => {
    expect(mockVisualQa(input(VISUAL_FIXTURE_TEXTS["face-too-low"])).face_box!.bottom).toBeGreaterThan(1150);
    expect(mockVisualQa(input(VISUAL_FIXTURE_TEXTS["realism-8"])).realism_score).toBe(8);
  });

  it("runClaudeTask in mock mode answers from it (no client, no network)", async () => {
    const brand = {
      id: null, name: "B", niche: null, audience: null, offers: null, tone: null, sound_answers: {}, samples: null, banned_words: [],
      language: "en", profile_md: null, pillars: [], words_per_second: 2.4,
    };
    const createClient = () => {
      throw new Error("no client in mock mode");
    };
    const out = await runClaudeTask(
      "visual_qa",
      { brand, input: input(VISUAL_FIXTURE_TEXTS["face-glitch"]), images: [{ mediaType: "image/jpeg", data: "AA==" }] },
      { mock: true, createClient, logUsage: async () => {} },
    );
    expect(out.face_natural).toBe(false);
  });
});
