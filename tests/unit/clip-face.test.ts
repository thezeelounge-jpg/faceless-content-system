import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClaudeRequest, CLAUDE_TASKS, runClaudeTask, type ClaudeBrand } from "@/lib/claude";

// The face check: 6 frames from the consent clip go to Claude (MAIN) as
// images. In mock mode the answer comes from the fixture's sidecar file
// (tests/fixtures/<clip>.vision.json), so "one face" and "two faces" are testable.

const BRAND: ClaudeBrand = {
  id: "10000000-0000-0000-0000-000000000001",
  name: "Dr Ayesha Clinic",
  niche: "doctor",
  audience: null,
  offers: null,
  tone: null,
  sound_answers: {},
  samples: null,
  banned_words: [],
  language: "en",
  profile_md: null,
  pillars: [],
  words_per_second: 2.4,
};

const IMAGES = Array.from({ length: 6 }, (_, i) => ({ mediaType: "image/jpeg" as const, data: `ZnJhbWU${i}` }));
const logUsage = vi.fn(async () => {});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  logUsage.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("clip_face_check request", () => {
  it("is a MAIN task with low effort and its own prompt file", () => {
    expect(CLAUDE_TASKS.clip_face_check).toMatchObject({ model: "main", effort: "low", prompt: "clip-face-check.md", stream: false });
    expect(readFileSync(path.resolve("prompts/clip-face-check.md"), "utf8")).toMatch(/exactly one/i);
  });

  it("sends the frames as base64 image blocks before the text, and no banned settings", () => {
    const params = buildClaudeRequest("clip_face_check", {
      brand: BRAND,
      input: { clip_name: "clip.mp4", frame_count: 6 },
      images: IMAGES,
    });
    const content = params.messages[0].content as Array<{ type: string; source?: unknown; text?: string }>;
    expect(content).toHaveLength(7);
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZnJhbWU0" } });
    expect(content.slice(0, 6).every((block) => block.type === "image")).toBe(true);
    expect(content[6].type).toBe("text");
    expect(params.output_config?.effort).toBe("low");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("text-only tasks still send a plain string (unchanged)", () => {
    const params = buildClaudeRequest("pronunciation_suggest", { brand: BRAND, input: { words: ["Ayesha"] } });
    expect(typeof params.messages[0].content).toBe("string");
  });
});

describe("mock face check is driven by the fixture sidecar", () => {
  it("good clip: one clear face in every frame", async () => {
    const out = await runClaudeTask(
      "clip_face_check",
      { brand: BRAND, input: { clip_name: "consent-good.mp4", frame_count: 6 }, images: IMAGES },
      { mock: true, logUsage },
    );
    expect(out.frames).toHaveLength(6);
    expect(out.frames.every((f) => f.faces === 1 && f.face_clear)).toBe(true);
  });

  it("bad clip: the sidecar says two faces", async () => {
    const out = await runClaudeTask(
      "clip_face_check",
      { brand: BRAND, input: { clip_name: "consent-bad.mp4", frame_count: 6 }, images: IMAGES },
      { mock: true, logUsage },
    );
    expect(out.frames.some((f) => f.faces === 2)).toBe(true);
  });

  it("a clip with no sidecar (a real upload in mock mode) gets one clear face, with as many frames as asked", async () => {
    const out = await runClaudeTask(
      "clip_face_check",
      { brand: BRAND, input: { clip_name: "brand-1/abc.mp4", frame_count: 4 }, images: IMAGES.slice(0, 4) },
      { mock: true, logUsage },
    );
    expect(out.frames).toEqual(Array.from({ length: 4 }, () => ({ faces: 1, face_clear: true })));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
