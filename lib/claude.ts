import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { estimateCostUsd } from "@/lib/ai-prices";
import {
  brandProfileOutput,
  planInput,
  planOutput,
  pronunciationInput,
  pronunciationOutput,
  scriptInput,
  scriptOutput,
  scriptQaInput,
  scriptQaOutput,
  scriptRewriteInput,
} from "@/lib/ai-schemas";
import {
  mockBrandProfile,
  mockPlan,
  mockPronunciation,
  mockScript,
  mockScriptQa,
  mockScriptRewrite,
} from "@/lib/claude-mocks";
import { splitSamples } from "@/lib/brand-input";
import { isMockClaude, readEnv } from "@/lib/config";
import { loadPrompt } from "@/lib/prompts";
import { createAdminClient } from "@/lib/supabase/admin";

// Every Claude call in the app goes through runClaudeTask(). It follows the
// "Claude API rules" in CLAUDE.md:
// - models come from env; effort is set on every call;
// - no temperature/top_p/top_k, no thinking settings, no prefill, no tool_choice;
// - JSON answers use structured outputs (zod), checked again with zod;
// - stop_reason is checked before reading the answer; "refusal" → plain error;
// - server-side fallbacks are on (beta `fallbacks: "default"`);
// - long answers (monthly plans) are streamed and read with finalMessage();
// - the brand profile sits in a cached system block;
// - every call has a timeout and retries busy errors with backoff;
// - tokens and estimated cost go to ai_usage;
// - prompts live in /prompts.
// TODO(Phase 8): scheduled monthly planning should use the Message Batches API.

export type ModelTier = "main" | "planner" | "fast";

const MODEL_ENV: Record<ModelTier, { env: string; fallback: string }> = {
  main: { env: "CLAUDE_MODEL_MAIN", fallback: "claude-sonnet-5-5" },
  planner: { env: "CLAUDE_MODEL_PLANNER", fallback: "claude-opus-5-5" },
  fast: { env: "CLAUDE_MODEL_FAST", fallback: "claude-haiku-5-5" },
};

export function claudeModel(tier: ModelTier): string {
  return readEnv(MODEL_ENV[tier].env) ?? MODEL_ENV[tier].fallback;
}

type TaskDef = {
  model: ModelTier;
  effort: "low" | "medium";
  /** Room for the answer (thinking included). Non-streamed calls must stay well under ~21k. */
  maxTokens: number;
  prompt: string;
  input: z.ZodType;
  output: z.ZodType;
  /** Stream long answers and read them with finalMessage(). */
  stream: boolean;
  timeoutMs: number;
};

export const CLAUDE_TASKS = {
  brand_profile: {
    model: "main",
    effort: "medium",
    maxTokens: 16_000,
    prompt: "brand-profile.md",
    input: z.object({}),
    output: brandProfileOutput,
    stream: false,
    timeoutMs: 180_000,
  },
  plan: {
    model: "planner",
    effort: "medium",
    maxTokens: 32_000,
    prompt: "plan.md",
    input: planInput,
    output: planOutput,
    stream: true,
    timeoutMs: 600_000,
  },
  script: {
    model: "main",
    effort: "medium",
    maxTokens: 16_000,
    prompt: "script.md",
    input: scriptInput,
    output: scriptOutput,
    stream: false,
    timeoutMs: 180_000,
  },
  script_qa: {
    model: "main",
    effort: "medium",
    maxTokens: 8_000,
    prompt: "script-qa.md",
    input: scriptQaInput,
    output: scriptQaOutput,
    stream: false,
    timeoutMs: 120_000,
  },
  script_rewrite: {
    model: "main",
    effort: "medium",
    maxTokens: 16_000,
    prompt: "script-rewrite.md",
    input: scriptRewriteInput,
    output: scriptOutput,
    stream: false,
    timeoutMs: 180_000,
  },
  pronunciation_suggest: {
    model: "fast",
    effort: "low",
    maxTokens: 4_000,
    prompt: "pronunciation-suggest.md",
    input: pronunciationInput,
    output: pronunciationOutput,
    stream: false,
    timeoutMs: 60_000,
  },
} as const satisfies Record<string, TaskDef>;

export type ClaudeTaskName = keyof typeof CLAUDE_TASKS;
export type TaskInput<T extends ClaudeTaskName> = z.input<(typeof CLAUDE_TASKS)[T]["input"]>;
export type TaskOutput<T extends ClaudeTaskName> = z.output<(typeof CLAUDE_TASKS)[T]["output"]>;

/** The brand fields Claude needs. A row from public.brands fits. */
export type ClaudeBrand = {
  id: string | null;
  name: string;
  niche: string | null;
  audience: string | null;
  offers: string | null;
  tone: string | null;
  sound_answers: Record<string, string>;
  samples: string | null;
  banned_words: string[];
  language: string;
  profile_md: string | null;
  pillars: unknown;
  words_per_second: number;
};

export type ClaudeContext<T extends ClaudeTaskName> = { brand: ClaudeBrand; input: TaskInput<T> };

export type UsageRow = {
  brand_id: string | null;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type ClaudeRequest = MessageCreateParamsNonStreaming;
type ClaudeMessage = Pick<BetaMessage, "model" | "stop_reason" | "content" | "usage">;

/** The small part of the Anthropic SDK we use. Tests pass a fake one. */
export interface ClaudeClient {
  create(params: ClaudeRequest, opts: { timeout: number }): Promise<ClaudeMessage>;
  stream(params: ClaudeRequest, opts: { timeout: number }): { finalMessage(): Promise<ClaudeMessage> };
}

export type ClaudeDeps = {
  /** Defaults to MOCK_CLAUDE (mock unless exactly "false"). */
  mock: boolean;
  client?: ClaudeClient;
  createClient: () => ClaudeClient;
  logUsage: (row: UsageRow) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

/** A plain error with a short code, safe to save on a row and show in admin. */
export class ClaudeError extends Error {
  constructor(
    readonly code: "refusal" | "cut_off" | "bad_output" | "busy" | "failed" | "not_set_up",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ClaudeError";
  }
}

// ---------------------------------------------------------------------------
// Building the request (pure: same inputs → same request)
// ---------------------------------------------------------------------------

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The brand details, sent as the cached system block on every call. */
export function brandContext(brand: ClaudeBrand): string {
  const sound = Object.entries(brand.sound_answers ?? {})
    .map(([key, answer]) => `- ${key.replace(/_/g, " ")}: ${answer}`)
    .join("\n");
  const samples = splitSamples(brand.samples)
    .map((sample, i) => `<sample n="${i + 1}">\n${sample}\n</sample>`)
    .join("\n");
  const pillars = Array.isArray(brand.pillars) && brand.pillars.length > 0 ? JSON.stringify(brand.pillars) : "none yet";
  return [
    `# Brand details`,
    `Name: ${brand.name}`,
    `Niche: ${brand.niche ?? "not given"}`,
    `Audience: ${brand.audience ?? "not given"}`,
    `Offers: ${brand.offers ?? "not given"}`,
    `Tone: ${brand.tone ?? "not given"}`,
    `Language: ${brand.language}`,
    `Speaking speed: ${brand.words_per_second} words per second`,
    `Banned words (never use): ${brand.banned_words.length > 0 ? brand.banned_words.join(", ") : "none"}`,
    ``,
    `## How they sound (their own answers)`,
    sound || "not given",
    ``,
    `## Writing samples`,
    samples || "none",
    ``,
    `## Brand profile`,
    brand.profile_md ?? "not written yet",
    ``,
    `## Content pillars`,
    pillars,
  ].join("\n");
}

function jsonFormat(schema: z.ZodType) {
  // The SDK helper turns the zod schema into the JSON schema the API expects.
  // We keep only the plain format and check the answer with zod ourselves
  // (so a server-side fallback's extra text blocks can't break parsing).
  const format = betaZodOutputFormat(schema);
  return { type: "json_schema" as const, schema: format.schema };
}

export function buildClaudeRequest<T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): ClaudeRequest {
  const def: TaskDef = CLAUDE_TASKS[task];
  const input = def.input.parse(ctx.input);
  return {
    model: claudeModel(def.model),
    max_tokens: def.maxTokens,
    system: [
      { type: "text", text: loadPrompt("system.md") },
      { type: "text", text: brandContext(ctx.brand), cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `${loadPrompt(def.prompt)}\n\n## Input\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
      },
    ],
    output_config: { effort: def.effort, format: jsonFormat(def.output) },
    fallbacks: "default",
    betas: [FALLBACK_BETA],
  };
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

/** Tokens and estimated cost, priced per model (a fallback model may have served part of it). */
export function usageFromMessage(message: ClaudeMessage): Omit<UsageRow, "brand_id" | "task"> {
  const usage = message.usage;
  const parts = (usage.iterations ?? []).filter(
    (it): it is Extract<typeof it, { type: "message" | "fallback_message" }> =>
      it.type === "message" || it.type === "fallback_message",
  );
  const rows =
    parts.length > 0
      ? parts.map((it) => ({ ...it, model: it.model ?? message.model }))
      : [
          {
            model: message.model,
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          },
        ];
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const row of rows) {
    input += row.input_tokens + (row.cache_creation_input_tokens ?? 0) + (row.cache_read_input_tokens ?? 0);
    output += row.output_tokens;
    cost += estimateCostUsd(row.model, row);
  }
  return { model: message.model, input_tokens: input, output_tokens: output, cost_usd: Math.round(cost * 1e6) / 1e6 };
}

function checkStopReason(message: ClaudeMessage) {
  switch (message.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      return;
    case "refusal":
      throw new ClaudeError(
        "refusal",
        "Claude declined to write this. Change the topic or the brand details and try again.",
      );
    case "max_tokens":
    case "model_context_window_exceeded":
      throw new ClaudeError("cut_off", "Claude's answer was too long and got cut off. Try again.");
    default:
      throw new ClaudeError("failed", `Claude stopped unexpectedly (${message.stop_reason ?? "no reason"}).`);
  }
}

/** The JSON answer: text after the last server-side fallback block, checked with zod. */
export function readAnswer<O>(message: ClaudeMessage, schema: z.ZodType<O>): O {
  let start = 0;
  message.content.forEach((block, i) => {
    if (block.type === "fallback") start = i + 1;
  });
  const text = message.content
    .slice(start)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ClaudeError("bad_output", "Claude gave an unexpected answer (not JSON). Try again.", { cause });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ClaudeError("bad_output", "Claude gave an unexpected answer (wrong shape). Try again.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Retry with backoff
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  const status = statusOf(error);
  return status !== undefined && (RETRY_STATUSES.has(status) || status >= 500);
}

/** 2 s, 4 s, ... or the server's Retry-After (up to 60 s). */
export function backoffMs(attempt: number, error: unknown): number {
  const headers = (error as { headers?: unknown })?.headers;
  const retryAfter = headers instanceof Headers ? Number(headers.get("retry-after")) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 60) * 1000;
  return 2000 * 2 ** (attempt - 1);
}

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ClaudeError) throw error;
      if (!isRetryable(error)) {
        throw new ClaudeError("failed", `Claude call failed (${statusOf(error) ?? "no status"}). See server logs.`, {
          cause: error,
        });
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new ClaudeError("busy", "Claude is busy right now. Try again in a few minutes.", { cause: error });
      }
      await sleep(backoffMs(attempt, error));
    }
  }
}

// ---------------------------------------------------------------------------
// Real client and usage logger
// ---------------------------------------------------------------------------

function createAnthropicClient(): ClaudeClient {
  const apiKey = readEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new ClaudeError("not_set_up", "Claude is not set up. Add ANTHROPIC_API_KEY, or keep MOCK_CLAUDE=true.");
  }
  // maxRetries 0: we retry ourselves (withRetry), so one place decides the backoff.
  const sdk = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    create: (params, opts) => sdk.beta.messages.create(params, { timeout: opts.timeout }),
    stream: (params, opts) => sdk.beta.messages.stream(params, { timeout: opts.timeout }),
  };
}

/** Saves one ai_usage row. A failed log never breaks the task; it is reported in the server log. */
async function logUsageToDatabase(row: UsageRow): Promise<void> {
  try {
    const { error } = await createAdminClient().from("ai_usage").insert(row);
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error("[claude] could not save ai_usage:", error instanceof Error ? error.message : error);
  }
}

const defaultDeps = (): ClaudeDeps => ({
  mock: isMockClaude(),
  createClient: createAnthropicClient,
  logUsage: logUsageToDatabase,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

// ---------------------------------------------------------------------------
// Mock answers
// ---------------------------------------------------------------------------

function mockAnswer(task: ClaudeTaskName, brand: ClaudeBrand, input: unknown): unknown {
  switch (task) {
    case "brand_profile":
      return mockBrandProfile(brand);
    case "plan":
      return mockPlan(brand, planInput.parse(input));
    case "script":
      return mockScript(brand, scriptInput.parse(input));
    case "script_qa":
      return mockScriptQa(brand, scriptQaInput.parse(input));
    case "script_rewrite":
      return mockScriptRewrite(brand, scriptRewriteInput.parse(input));
    case "pronunciation_suggest":
      return mockPronunciation(pronunciationInput.parse(input));
  }
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Runs one Claude task and returns its checked JSON answer.
 * In mock mode (the default) it returns sample data, builds no client and
 * makes no network call; it still logs an ai_usage row with model "mock:…"
 * and cost 0, so the usage page shows the activity.
 */
export async function runClaudeTask<T extends ClaudeTaskName>(
  task: T,
  ctx: ClaudeContext<T>,
  overrides: Partial<ClaudeDeps> = {},
): Promise<TaskOutput<T>> {
  const deps = { ...defaultDeps(), ...overrides };
  const def: TaskDef = CLAUDE_TASKS[task];
  const input = def.input.parse(ctx.input);

  if (deps.mock) {
    const answer = def.output.parse(mockAnswer(task, ctx.brand, input));
    await deps.logUsage({
      brand_id: ctx.brand.id,
      task,
      model: `mock:${claudeModel(def.model)}`,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    });
    return answer as TaskOutput<T>;
  }

  const params = buildClaudeRequest(task, ctx);
  const client = deps.client ?? deps.createClient();
  const opts = { timeout: def.timeoutMs };
  const message = await withRetry(
    () => (def.stream ? client.stream(params, opts).finalMessage() : client.create(params, opts)),
    deps.sleep,
  );

  // Tokens were spent even if the answer is unusable, so log first.
  await deps.logUsage({ brand_id: ctx.brand.id, task, ...usageFromMessage(message) });
  checkStopReason(message);
  return readAnswer(message, def.output) as TaskOutput<T>;
}
