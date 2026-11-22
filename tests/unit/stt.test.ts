import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "@/tests/fixtures/stt/sample-transcript.json";
import { NO_STT_PROVIDER, getSttProvider, transcriptSchema } from "@/lib/stt";

// lib/stt.ts: one interface for every speech-to-text provider. Only the mock
// exists (MOCK_STT); the provider is picked by Rowan, not here.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getSttProvider", () => {
  it("mock returns the fixture transcript and it passes the schema", async () => {
    vi.stubEnv("MOCK_STT", "");
    const transcript = await getSttProvider().transcribe({ audioPath: "/tmp/anything.mp4", language: "en" });
    expect(transcript).toEqual(fixture);
    expect(transcriptSchema.parse(transcript)).toEqual(transcript);
  });

  it("mock words are in order, start < end, and never overlap", async () => {
    const { words } = await getSttProvider().transcribe({ audioPath: "/tmp/a.mp4" });
    expect(words.length).toBeGreaterThan(10);
    words.forEach((w, i) => {
      expect(w.start_s).toBeLessThan(w.end_s);
      if (i > 0) expect(w.start_s).toBeGreaterThanOrEqual(words[i - 1].end_s);
    });
  });

  it("mock is deterministic and returns a fresh copy each time", async () => {
    const a = await getSttProvider().transcribe({ audioPath: "/tmp/a.mp4" });
    expect(a.words).toHaveLength(fixture.words.length);
    a.words[0].text = "changed";
    const b = await getSttProvider().transcribe({ audioPath: "/tmp/a.mp4" });
    expect(b.words[0].text).toBe("stop");
  });

  it("without mock mode it refuses with a plain error (no provider exists yet)", () => {
    vi.stubEnv("MOCK_STT", "false");
    expect(() => getSttProvider()).toThrow(NO_STT_PROVIDER);
  });

  it("the mock makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await getSttProvider().transcribe({ audioPath: "/tmp/a.mp4" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the schema rejects a word that ends before it starts", () => {
    const bad = { language: "en", duration_s: 1, words: [{ text: "x", start_s: 0.5, end_s: 0.2 }] };
    expect(transcriptSchema.safeParse(bad).success).toBe(false);
  });
});
