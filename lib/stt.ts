import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isMockStt } from "@/lib/config";
import { PlainError } from "@/lib/plain-error";
import mockTranscript from "@/tests/fixtures/stt/sample-transcript.json";

// Speech-to-text, provider-agnostic (Phase 4). Every provider answers with the
// same Transcript shape: the words heard, each with its start and end time in
// seconds. Captions take their TIMINGS from here and their TEXT from the
// script's display_text (lib/captions.ts). Gate 3 (Phase 5) reuses the same
// transcript, saved to videos.transcript.
//
// Money safety: only the mock exists. MOCK_STT means "mock" unless it is
// exactly "false" (lib/config.ts); with it off we refuse, because no real
// provider is chosen yet (Rowan is comparing them). Adding one later = a new
// SttProvider here, no change for callers.

export const transcriptWordSchema = z
  .object({
    text: z.string().min(1),
    start_s: z.number().min(0),
    end_s: z.number().min(0),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((w) => w.end_s >= w.start_s, "A word cannot end before it starts.");

export const transcriptSchema = z.object({
  language: z.string().min(2),
  duration_s: z.number().min(0),
  words: z.array(transcriptWordSchema),
});

export type Transcript = z.infer<typeof transcriptSchema>;
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type SttLanguage = "en" | "ur" | "hi";

export interface SttProvider {
  /**
   * expectedText (p5-a2): the text the voice was asked to say (spoken_text). A real provider may use
   * it as a vocabulary hint; the MOCK uses it to pick a fixture (tests/fixtures/stt/by-text.json).
   */
  transcribe(input: { audioPath: string; language?: SttLanguage; expectedText?: string }): Promise<Transcript>;
}

export const NO_STT_PROVIDER = "No speech-to-text provider is set up yet.";

/**
 * MOCK: the word-timed transcript in tests/fixtures/stt/sample-transcript.json
 * (it matches tests/fixtures/stt/sample-script.json and the 6-second test
 * video). Same answer for every file; nothing leaves the machine.
 */
export const mockSttProvider: SttProvider = {
  async transcribe(input) {
    // p5-a2 (Gate 3): the transcript is picked by the text the voice was asked to say
    // (tests/fixtures/stt/by-text.json), so a re-render with a respelling can "sound" different.
    const keyed = input?.expectedText ? keyedFixture(input.expectedText) : null;
    if (keyed) return keyed;
    // Parsing makes a fresh copy, so a caller can never change the fixture.
    return transcriptSchema.parse(structuredClone(mockTranscript));
  },
};

const STT_FIXTURES = path.join(process.cwd(), "tests", "fixtures", "stt");
const byTextSchema = z.object({ rules: z.array(z.object({ contains: z.string().min(1), file: z.string().regex(/^[a-z0-9-]+\.json$/) })) });

/** The first by-text rule whose `contains` is in the text (any case), or null. */
function keyedFixture(expectedText: string): Transcript | null {
  const { rules } = byTextSchema.parse(JSON.parse(readFileSync(path.join(STT_FIXTURES, "by-text.json"), "utf8")));
  const text = expectedText.toLowerCase();
  const rule = rules.find((r) => text.includes(r.contains.toLowerCase()));
  return rule ? transcriptSchema.parse(JSON.parse(readFileSync(path.join(STT_FIXTURES, rule.file), "utf8"))) : null;
}

export function getSttProvider(): SttProvider {
  if (isMockStt()) return mockSttProvider;
  throw new PlainError(NO_STT_PROVIDER);
}
