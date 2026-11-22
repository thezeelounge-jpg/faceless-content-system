import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_TASKS, buildClaudeRequest, runClaudeTask, type ClaudeBrand } from "@/lib/claude";
import { mockRespell } from "@/lib/claude-mocks";
import { getSttProvider } from "@/lib/stt";
import misheard from "@/tests/fixtures/stt/gate3-ayesha-misheard.json";
import fixed from "@/tests/fixtures/stt/gate3-ayesha-fixed.json";
import sample from "@/tests/fixtures/stt/sample-transcript.json";

// Gate 3 (p5-a2): the Claude FAST "same sound or mispronounced?" task, answered from a fixture in
// mock mode, and the mock speech-to-text that picks a transcript by the text the voice was asked to say.

const BRAND: ClaudeBrand = {
  id: "10000000-0000-0000-0000-000000000001", name: "Bright Smile Dental", niche: "dentist", audience: null, offers: null, tone: null,
  sound_answers: {}, samples: null, banned_words: [], language: "roman_urdu", profile_md: null, pillars: [], words_per_second: 2.4,
};
const logUsage = vi.fn(async () => {});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  vi.stubEnv("MOCK_CLAUDE", "");
  vi.stubEnv("MOCK_STT", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("key_term_check (Claude FAST)", () => {
  it("is a FAST task with low effort and its own prompt file", () => {
    expect(CLAUDE_TASKS.key_term_check).toMatchObject({ model: "fast", effort: "low", prompt: "key-term-check.md", stream: false });
    expect(readFileSync(path.resolve("prompts/key-term-check.md"), "utf8")).toMatch(/same_sound/);
    const params = buildClaudeRequest("key_term_check", { brand: BRAND, input: { language: "en", terms: [{ written: "Ayesha", heard: "asia" }] } });
    expect(params.output_config?.effort).toBe("low");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("mock: Roman Urdu spelling variants are the same sound; a different word is a mispronunciation with a respelling", async () => {
    const answer = await runClaudeTask(
      "key_term_check",
      {
        brand: BRAND,
        input: {
          language: "roman_urdu",
          terms: [
            { written: "Ayesha", heard: "aisha" },
            { written: "InshaAllah", heard: "inshallah" },
            { written: "bohat", heard: "BAHUT" },
            { written: "Ayesha", heard: "asia" },
          ],
        },
      },
      { logUsage },
    );
    expect(answer.judgements).toEqual([
      { written: "Ayesha", heard: "aisha", verdict: "same_sound", respelling: "" },
      { written: "InshaAllah", heard: "inshallah", verdict: "same_sound", respelling: "" },
      { written: "bohat", heard: "BAHUT", verdict: "same_sound", respelling: "" },
      { written: "Ayesha", heard: "asia", verdict: "mispronounced", respelling: "Aa-ee-sha" },
    ]);
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({ task: "key_term_check", cost_usd: 0 }));
  });

  it("mock: a pair the fixture does not know is a mispronunciation (fail safe), with a mock respelling", async () => {
    const answer = await runClaudeTask("key_term_check", { brand: BRAND, input: { language: "en", terms: [{ written: "Gulberg", heard: "goldberg" }] } }, { logUsage });
    expect(answer.judgements).toEqual([{ written: "Gulberg", heard: "goldberg", verdict: "mispronounced", respelling: mockRespell("Gulberg") }]);
  });
});

describe("mock speech-to-text picks the fixture by the text the voice was asked to say", () => {
  it("the Gate 3 test script mishears the name; with the respelling it hears it right; anything else = the sample", async () => {
    const stt = getSttProvider();
    const first = await stt.transcribe({ audioPath: "/tmp/a.mp4", expectedText: "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day." });
    expect(first).toEqual(misheard);
    const again = await stt.transcribe({ audioPath: "/tmp/b.mp4", expectedText: "Hi, I'm Aa-ee-sha from Bright Smile Dental. Brush twice a day." });
    expect(again).toEqual(fixed);
    expect(await stt.transcribe({ audioPath: "/tmp/c.mp4", expectedText: "Something else entirely." })).toEqual(sample);
    expect(await stt.transcribe({ audioPath: "/tmp/d.mp4" })).toEqual(sample);
  });
});
