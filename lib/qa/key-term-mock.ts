import { z } from "zod";
import { keyTermOutput, type KeyTermOutput } from "@/lib/ai-schemas";
import { mockRespell } from "@/lib/claude-mocks";
import judgementsFixture from "@/tests/fixtures/stt/key-term-judgements.json";

// Mock answer for the key_term_check Claude task (MOCK_CLAUDE=true, Gate 3).
// Deterministic and driven by tests/fixtures/stt/key-term-judgements.json,
// matched on written + heard (any case). A pair not in the file is judged
// "mispronounced" (fail safe: a wrong "same sound" would reach the customer)
// with the same mock respelling Gate 2 uses.
// p5-b1 (QA SF2): the file is EMBEDDED (static JSON import, bundled), never read from
// process.cwd() at run time: a deployed Trigger.dev task has no tests/ folder.

const fixtureSchema = z.object({ judgements: keyTermOutput.shape.judgements });
const key = (written: string, heard: string) => `${written.trim().toLowerCase()}|${heard.trim().toLowerCase()}`;
const KNOWN = new Map(fixtureSchema.parse(judgementsFixture).judgements.map((j) => [key(j.written, j.heard), j]));

export function mockKeyTermCheck(input: { language: string; terms: { written: string; heard: string }[] }): KeyTermOutput {
  return {
    judgements: input.terms.map(({ written, heard }) => {
      const found = KNOWN.get(key(written, heard));
      if (found) return { written, heard, verdict: found.verdict, respelling: found.respelling };
      return { written, heard, verdict: "mispronounced" as const, respelling: mockRespell(written) };
    }),
  };
}
