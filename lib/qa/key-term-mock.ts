import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { keyTermOutput, type KeyTermOutput } from "@/lib/ai-schemas";
import { mockRespell } from "@/lib/claude-mocks";

// Mock answer for the key_term_check Claude task (MOCK_CLAUDE=true, Gate 3).
// Deterministic and driven by tests/fixtures/stt/key-term-judgements.json,
// matched on written + heard (any case). A pair not in the file is judged
// "mispronounced" (fail safe: a wrong "same sound" would reach the customer)
// with the same mock respelling Gate 2 uses.

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "stt", "key-term-judgements.json");
const fixtureSchema = z.object({ judgements: keyTermOutput.shape.judgements });
const key = (written: string, heard: string) => `${written.trim().toLowerCase()}|${heard.trim().toLowerCase()}`;

export function mockKeyTermCheck(input: { language: string; terms: { written: string; heard: string }[] }): KeyTermOutput {
  const known = new Map(fixtureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8"))).judgements.map((j) => [key(j.written, j.heard), j]));
  return {
    judgements: input.terms.map(({ written, heard }) => {
      const found = known.get(key(written, heard));
      if (found) return { written, heard, verdict: found.verdict, respelling: found.respelling };
      return { written, heard, verdict: "mispronounced" as const, respelling: mockRespell(written) };
    }),
  };
}
