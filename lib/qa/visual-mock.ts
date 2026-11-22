import { z } from "zod";
import { VISUAL_QA_FIELDS, visualQaOutput, type VisualQaInput, type VisualQaOutput } from "@/lib/ai-schemas";
import { VISUAL_QA } from "@/lib/qa/config";
import answersFixture from "@/tests/fixtures/visual/answers.json";

// Mock answer for the visual_qa Claude task (MOCK_CLAUDE=true, Gate 5, p5-b2). Deterministic:
// tests/fixtures/visual/answers.json picks a fixture by display_text (any other text → "good").
// A fixture lists the rubric fields that fail ("fail"), its realism score and face/mouth boxes,
// and for "captions over the mouth" the caption styles that cover the mouth, so a re-edit with a
// lower style really gets a different (passing) answer. Embedded (static JSON import, bundled),
// never read from process.cwd(): a deployed Trigger.dev task has no tests/ folder (p5-b1 QA SF2).

const box = z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() });
const fixtureSchema = z.object({
  by_text: z.record(z.string(), z.string()),
  answers: z.record(
    z.string(),
    z.object({
      realism_score: z.number().int().min(1).max(10).optional(),
      face_box: box.optional(),
      mouth_box: box.optional(),
      fail: z.array(z.enum(VISUAL_QA_FIELDS)).optional(),
      captions_cover_mouth_with: z.array(z.string()).optional(),
      issue_frame: z.number().int().min(0).optional(),
      issue_on: z.enum(["broll"]).optional(),
    }),
  ),
});
const FIXTURES = fixtureSchema.parse(answersFixture);
const GOOD = FIXTURES.answers.good;

/** Fixture name → its display text (tests use these texts to pick a fixture). */
export const VISUAL_FIXTURE_TEXTS: Record<string, string> = Object.fromEntries(Object.entries(FIXTURES.by_text).map(([text, name]) => [name, text]));

const DETAILS: Partial<Record<(typeof VISUAL_QA_FIELDS)[number], string>> = {
  face_natural: "The teeth and the jaw line warp for a moment.",
  mouth_area_clean: "The mouth area is smeared.",
  captions_clear_of_face: "The caption sits over the mouth.",
  no_stray_text: "A stock-clip logo is visible.",
};

export function mockVisualQa(input: VisualQaInput): VisualQaOutput {
  const name = FIXTURES.by_text[input.display_text] ?? "good";
  const f = { ...GOOD, ...FIXTURES.answers[name] };
  const failing = new Set(f.fail ?? []);
  if (f.captions_cover_mouth_with?.includes(input.caption_style)) failing.add("captions_clear_of_face");
  const last = input.frames.length - 1;
  const brollFrame = input.frames.find((fr) => fr.kind === "broll")?.index;
  const frame = f.issue_on === "broll" && brollFrame !== undefined ? brollFrame : Math.min(f.issue_frame ?? 1, last);
  const realism = f.realism_score ?? 9;
  const answer: VisualQaOutput = {
    face_natural: !failing.has("face_natural"),
    mouth_area_clean: !failing.has("mouth_area_clean"),
    hands_ok: !failing.has("hands_ok"),
    background_stable: !failing.has("background_stable"),
    captions_readable: !failing.has("captions_readable"),
    captions_clear_of_face: !failing.has("captions_clear_of_face"),
    broll_matches_line: !failing.has("broll_matches_line"),
    no_stray_text: !failing.has("no_stray_text"),
    first_frame_strong: !failing.has("first_frame_strong"),
    realism_score: realism,
    face_box: f.face_box ?? null,
    mouth_box: f.mouth_box ?? null,
    issues: [
      ...[...failing].map((field) => ({ field, frame, detail: DETAILS[field] ?? `Problem with ${field.replace(/_/g, " ")}.` })),
      ...(realism < VISUAL_QA.pass_realism_score ? [{ field: "realism_score" as const, frame, detail: "It looks computer-made." }] : []),
    ],
  };
  return visualQaOutput.parse(answer);
}
