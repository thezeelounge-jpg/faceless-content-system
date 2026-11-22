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
  transcribe(input: { audioPath: string; language?: SttLanguage }): Promise<Transcript>;
}

export const NO_STT_PROVIDER = "No speech-to-text provider is set up yet.";

/**
 * MOCK: the word-timed transcript in tests/fixtures/stt/sample-transcript.json
 * (it matches tests/fixtures/stt/sample-script.json and the 6-second test
 * video). Same answer for every file; nothing leaves the machine.
 */
export const mockSttProvider: SttProvider = {
  async transcribe() {
    // Parsing makes a fresh copy, so a caller can never change the fixture.
    return transcriptSchema.parse(structuredClone(mockTranscript));
  },
};

export function getSttProvider(): SttProvider {
  if (isMockStt()) return mockSttProvider;
  throw new PlainError(NO_STT_PROVIDER);
}
