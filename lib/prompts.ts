import "server-only";
import { PROMPT_FILES } from "@/lib/prompts-bundle";

// Every Claude prompt lives as a Markdown file in /prompts, so the owner can
// read and change them without touching code. Changing one? Run
// `npm run prompts:bundle` (copies the texts into lib/prompts-bundle.ts, which a
// test checks), and ask to run `npm run eval:scripts` (costs cents) to compare quality.
//
// p5-b4 (QA SF1): the texts are embedded (lib/prompts-bundle.ts), never read from the
// working folder, so a deployed Trigger.dev task (no /prompts folder on disk) works too.

export function loadPrompt(name: string): string {
  if (!/^[a-z0-9-]+\.md$/.test(name)) throw new Error(`Bad prompt file name: ${name}`);
  const text = PROMPT_FILES[name];
  if (text === undefined) throw new Error(`Unknown prompt: ${name} (run npm run prompts:bundle after adding a file to /prompts)`);
  return text.trim();
}
