import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

// Every Claude prompt lives as a Markdown file in /prompts, so the owner can
// read and change them without touching code. Changing one? Ask to run
// `npm run eval:scripts` (costs cents) to compare quality.

const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  if (!/^[a-z0-9-]+\.md$/.test(name)) throw new Error(`Bad prompt file name: ${name}`);
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(path.join(process.cwd(), "prompts", name), "utf8").trim();
  cache.set(name, text);
  return text;
}
