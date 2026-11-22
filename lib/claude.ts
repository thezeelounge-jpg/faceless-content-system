import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import { estimateCostUsd } from "@/lib/ai-prices";
import {
  brandProfileOutput,
  clipFaceInput,
  clipFaceOutput,
  keyTermInput,
  keyTermOutput,
  planInput,
  planOutput,
  pronunciationInput,
  pronunciationOutput,
  scriptInput,
  scriptOutput,
  scriptQaInput,
  scriptQaOutput,
  scriptRewriteInput,
  visualQaInput,
  visualQaOutput,
} from "@/lib/ai-schemas";
import {
  mockBrandProfile,
  mockPlan,
  mockPronunciation,
  mockScript,
  mockScriptQa,
  mockScriptRewrite,
  type MockScenario,
} from "@/lib/claude-mocks";
import { splitSamples } from "@/lib/brand-input";
import { mockClipFaceCheck } from "@/lib/clip-checks/face-mock";
import { mockKeyTermCheck } from "@/lib/qa/key-term-mock";
import { mockVisualQa } from "@/lib/qa/visual-mock";
import { isMockClaude, readEnv } from "@/lib/config";
import { PlainError } from "@/lib/plain-error";
import { loadPrompt } from "@/lib/prompts";
import { createAdminClient } from "@/lib/supabase/admin";

// Every Claude call in the app goes through runClaudeTask(). It follows the
// "Claude API rules" in CLAUDE.md:
// - models come from env; effort is set on every call;
// - no temperature/top_p/top_k, no thinking settings, no prefill, no tool_choice;
// - JSON answers use structured outputs (zod), checked again with zod;
// - stop_reason is checked before reading the answer; "refusal" → plain error;
// - stable Messages API only (no beta). If MAIN or PLANNER is still
//   overloaded (529) after our retries, we make exactly ONE call to the FAST
//   model and log it as "<task>:fallback_fast";
// - long answers (monthly plans) are streamed and read with finalMessage();
// - the brand profile sits in a cached system block;
// - every call has a timeout and retries busy errors with backoff;
// - tokens and estimated cost go to ai_usage;
// - prompts live in /prompts.
// TODO(Phase 8): scheduled monthly planning should use the Message Batches API.
// TODO: revisit Anthropic server-side fallbacks (beta) once GA

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
  /** Gate 3 (p5-a2): a key term heard differently: same sound or a real mispronunciation? */
  key_term_check: {
    model: "fast",
    effort: "low",
    maxTokens: 4_000,
    prompt: "key-term-check.md",
    input: keyTermInput,
    output: keyTermOutput,
    stream: false,
    timeoutMs: 60_000,
  },
  /** Consent clip: frames go in as images (ClaudeContext.images). */
  clip_face_check: {
    model: "main",
    effort: "low",
    maxTokens: 4_000,
    prompt: "clip-face-check.md",
    input: clipFaceInput,
    output: clipFaceOutput,
    stream: false,
    timeoutMs: 120_000,
  },
  /** Gate 5 (p5-b2): frames of the finished reel go in as images (ClaudeContext.images); the QA-SPEC rubric comes back. */
  visual_qa: {
    model: "main",
    effort: "medium",
    maxTokens: 8_000,
    prompt: "visual-qa.md",
    input: visualQaInput,
    output: visualQaOutput,
    stream: false,
    timeoutMs: 180_000,
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

/** A base64 image sent with the prompt (vision tasks only). */
export type ClaudeImage = { mediaType: "image/jpeg" | "image/png"; data: string };

export type ClaudeContext<T extends ClaudeTaskName> = { brand: ClaudeBrand; input: TaskInput<T>; images?: ClaudeImage[] };

export type UsageRow = {
  brand_id: string | null;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type ClaudeRequest = MessageCreateParamsNonStreaming;
type ClaudeMessage = Pick<Message, "model" | "stop_reason" | "content" | "usage">;

/** The small part of the Anthropic SDK we use. Tests pass a fake one. */
export interface ClaudeClient {
  create(params: ClaudeRequest, opts: { timeout: number }): Promise<ClaudeMessage>;
  stream(params: ClaudeRequest, opts: { timeout: number }): { finalMessage(): Promise<ClaudeMessage> };
}

export type ClaudeDeps = {
  /** Defaults to MOCK_CLAUDE (mock unless exactly "false"). */
  mock: boolean;
  /** Mock mode only (tests, golden set): force failing drafts. See MockScenario in lib/claude-mocks.ts. */
  mockScenario?: MockScenario;
  client?: ClaudeClient;
  createClient: () => ClaudeClient;
  logUsage: (row: UsageRow) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

/** A plain error with a short code, safe to save on a row and show in admin. */
export class ClaudeError extends PlainError {
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
  // We keep only the plain format and check the answer with zod ourselves.
  const format = zodOutputFormat(schema);
  return { type: "json_schema" as const, schema: format.schema };
}

export function buildClaudeRequest<T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): ClaudeRequest {
  const def: TaskDef = CLAUDE_TASKS[task];
  const input = def.input.parse(ctx.input);
  const text = `${loadPrompt(def.prompt)}\n\n## Input\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
  // Images go before the text (vision tasks); other tasks send plain text.
  const images = ctx.images ?? [];
  const content =
    images.length === 0
      ? text
      : [
          ...images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
          })),
          { type: "text" as const, text },
        ];
  return {
    model: claudeModel(def.model),
    max_tokens: def.maxTokens,
    system: [
      { type: "text", text: loadPrompt("system.md") },
      { type: "text", text: brandContext(ctx.brand), cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content }],
    output_config: { effort: def.effort, format: jsonFormat(def.output) },
  };
}

/** Effort for the one FAST fallback call (CLAUDE.md: low for FAST tasks). */
const FAST_FALLBACK_EFFORT = "low" as const;

/** The same request, sent to the FAST model with FAST effort. */
export function buildFastFallbackRequest(params: ClaudeRequest): ClaudeRequest {
  return {
    ...params,
    model: claudeModel("fast"),
    output_config: { ...params.output_config, effort: FAST_FALLBACK_EFFORT },
  };
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

/** Tokens (cache reads and writes count as input) and estimated cost, priced for the model that answered. */
export function usageFromMessage(message: ClaudeMessage): Omit<UsageRow, "brand_id" | "task"> {
  const usage = message.usage;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    model: message.model,
    input_tokens: usage.input_tokens + cacheWrite + cacheRead,
    output_tokens: usage.output_tokens,
    cost_usd: estimateCostUsd(message.model, usage),
  };
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

/** The JSON answer: the text blocks joined, checked with zod. */
export function readAnswer<O>(message: ClaudeMessage, schema: z.ZodType<O>): O {
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
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
        throw new ClaudeError("busy", BUSY_MESSAGE, { cause: error });
      }
      await sleep(backoffMs(attempt, error));
    }
  }
}

const BUSY_MESSAGE = "Claude is busy right now. Try again in a few minutes.";

/** 529 / overloaded_error: the model itself is overloaded (not our request). */
function isOverloaded(error: unknown): boolean {
  if (statusOf(error) === 529) return true;
  const body = (error as { error?: { error?: { type?: unknown } } })?.error;
  return body?.error?.type === "overloaded_error";
}

/** Only MAIN and PLANNER tasks, only when the retries ran out on an overload. */
function shouldFallBackToFast(def: TaskDef, error: unknown): boolean {
  return (
    def.model !== "fast" && error instanceof ClaudeError && error.code === "busy" && isOverloaded(error.cause)
  );
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
    create: (params, opts) => sdk.messages.create(params, { timeout: opts.timeout }),
    stream: (params, opts) => sdk.messages.stream(params, { timeout: opts.timeout }),
  };
}

/** Saves one ai_usage row. A failed log never breaks the task; it is reported in the server log. */
export async function logUsageToDatabase(row: UsageRow): Promise<void> {
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

function mockAnswer(task: ClaudeTaskName, brand: ClaudeBrand, input: unknown, scenario: MockScenario): unknown {
  switch (task) {
    case "brand_profile":
      return mockBrandProfile(brand);
    case "plan":
      return mockPlan(brand, planInput.parse(input));
    case "script":
      return mockScript(brand, scriptInput.parse(input), scenario);
    case "script_qa":
      return mockScriptQa(brand, scriptQaInput.parse(input));
    case "script_rewrite":
      return mockScriptRewrite(brand, scriptRewriteInput.parse(input), scenario);
    case "pronunciation_suggest":
      return mockPronunciation(pronunciationInput.parse(input));
    case "key_term_check":
      return mockKeyTermCheck(keyTermInput.parse(input));
    case "clip_face_check":
      return mockClipFaceCheck(clipFaceInput.parse(input));
    case "visual_qa":
      return mockVisualQa(visualQaInput.parse(input));
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
    const answer = def.output.parse(mockAnswer(task, ctx.brand, input, deps.mockScenario ?? "good"));
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
  const send = (request: ClaudeRequest) =>
    def.stream ? client.stream(request, opts).finalMessage() : client.create(request, opts);

  let message: ClaudeMessage;
  let usageTask: string = task;
  try {
    message = await withRetry(() => send(params), deps.sleep);
  } catch (error) {
    if (!shouldFallBackToFast(def, error)) throw error;
    // Exactly one call, no retries. If it fails too, give the same plain "busy" error.
    console.error(`[claude] ${task}: ${claudeModel(def.model)} still overloaded, one fallback call to FAST`);
    try {
      message = await send(buildFastFallbackRequest(params));
    } catch (fallbackError) {
      throw new ClaudeError("busy", BUSY_MESSAGE, { cause: fallbackError });
    }
    usageTask = `${task}:fallback_fast`;
  }

  // Tokens were spent even if the answer is unusable, so log first.
  await deps.logUsage({ brand_id: ctx.brand.id, task: usageTask, ...usageFromMessage(message) });
  checkStopReason(message);
  return readAnswer(message, def.output) as TaskOutput<T>;
}
