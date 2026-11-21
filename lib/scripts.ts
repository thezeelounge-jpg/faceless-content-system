// Script writer (Claude MAIN). Claude writes the words; OUR code measures the
// length (words ÷ brand.words_per_second) and rejects anything over the
// plan's max_seconds_per_video before it is saved.
//
// Seams for part B2:
// - Gate 1 (Script QA) runs on the saved row (qa_status "pending") and may
//   rewrite it once (scriptRewrite task already exists in lib/claude.ts).
// - Gate 2 (Pronunciation prep) fills spoken_text from display_text later.
import type { ScriptOutput } from "@/lib/ai-schemas";
import type { ClaudeBrand, ClaudeContext } from "@/lib/claude";
import { PlainError } from "@/lib/plain-error";
import { planLimits } from "@/lib/plans";

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Seconds the twin needs to say `text`, rounded to 2 decimals (scripts.est_seconds). */
export function estimateSeconds(text: string, wordsPerSecond: number): number {
  return Math.round((countWords(text) / wordsPerSecond) * 100) / 100;
}

/** The brand owner's plan limit (lib/plans.ts); Creator when there is no plan. */
export function maxSecondsFor(plan: string | null | undefined): number {
  return planLimits(plan).max_seconds_per_video;
}

export type ScriptPost = {
  id: string;
  title: string;
  hook: string | null;
  pillar: string | null;
  format: "talking" | "story";
};

export type NewScriptRow = ScriptOutput & {
  post_id: string;
  version: 1;
  est_seconds: number;
  qa_status: "pending";
};

/** Asks Claude (MAIN) for the script, measures it, and returns the row to save (version 1, QA pending). */
export async function writeScriptForPost(args: {
  brand: ClaudeBrand;
  post: ScriptPost;
  maxSeconds: number;
  runScript: (ctx: ClaudeContext<"script">) => Promise<ScriptOutput>;
}): Promise<NewScriptRow> {
  const wps = Number(args.brand.words_per_second);
  const script = await args.runScript({
    brand: args.brand,
    input: {
      title: args.post.title,
      hook: args.post.hook ?? args.post.title,
      pillar: args.post.pillar ?? "General",
      format: args.post.format,
      max_seconds: args.maxSeconds,
      words_per_second: wps,
    },
  });
  const est = estimateSeconds(script.display_text, wps);
  if (est > args.maxSeconds) {
    throw new PlainError(
      `The script came out too long (about ${Math.round(est)} seconds; the limit is ${args.maxSeconds}). Nothing was saved. Please try again.`,
    );
  }
  return { ...script, post_id: args.post.id, version: 1, est_seconds: est, qa_status: "pending" };
}
