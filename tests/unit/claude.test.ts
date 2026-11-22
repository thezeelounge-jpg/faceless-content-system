import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brandProfileOutput,
  planOutput,
  pronunciationOutput,
  scriptOutput,
  scriptQaOutput,
} from "@/lib/ai-schemas";
import { estimateCostUsd } from "@/lib/ai-prices";
import {
  buildClaudeRequest,
  CLAUDE_TASKS,
  claudeModel,
  runClaudeTask,
  usageFromMessage,
  type ClaudeBrand,
  type ClaudeClient,
  type ClaudeTaskName,
  type UsageRow,
} from "@/lib/claude";

const BRAND: ClaudeBrand = {
  id: "10000000-0000-0000-0000-000000000001",
  name: "Dr Ayesha Clinic",
  niche: "doctor",
  audience: "Busy parents in Lahore",
  offers: "Online consultation for Rs 2,999, Family check-up package",
  tone: "Warm and direct",
  sound_answers: { greeting: "Assalam o alaikum", phrases: "Seedhi baat", never_say: "Guaranteed" },
  samples: "Sample one is here and long enough.\n\n-----\n\nSample two is also here.",
  banned_words: ["miracle", "guaranteed", "cure"],
  language: "en",
  profile_md: null,
  pillars: [],
  words_per_second: 2.4,
};

const SCRIPT = {
  hook: "Most parents wait too long to call a doctor.",
  body: "Here is what to watch for in the first 24 hours of a fever.",
  cta: "Book an online consultation today.",
  display_text:
    "Most parents wait too long to call a doctor. Here is what to watch for in the first 24 hours of a fever. Book an online consultation today.",
  captions: { instagram: "ig", tiktok: "tt", linkedin: "li", x: "x" },
  hashtags: ["#health", "#parenting", "#lahore"],
  broll_keywords: ["thermometer"],
  edit_plan: { broll_moments: [{ at_words: "first 24 hours", keyword: "clock" }], emphasis_words: ["fever"] },
};

const INPUTS: { [K in ClaudeTaskName]: unknown } = {
  brand_profile: {},
  plan: { slots: ["2026-12-01", "2026-12-03", "2026-12-05", "2026-12-08"], pillars: ["Fever myths", "Clinic life"] },
  script: { title: "Fever: when to worry", hook: "Most parents wait too long.", pillar: "Fever myths", format: "talking", max_seconds: 45, words_per_second: 2.4 },
  script_qa: { script: SCRIPT, max_seconds: 45 },
  script_rewrite: { script: SCRIPT, issues: [{ code: "hook", detail: "Hook is too long" }], max_seconds: 45, words_per_second: 2.4 },
  pronunciation_suggest: { words: ["Ayesha", "Gulberg"] },
  key_term_check: { language: "en", terms: [{ written: "Ayesha", heard: "asia" }] },
  clip_face_check: { clip_name: "consent-good.mp4", frame_count: 6 },
  visual_qa: {
    language: "en", display_text: "Hi there. Book a call.", caption_style: "big_words",
    frames: [{ index: 0, at_seconds: 0, kind: "first", caption: "Hi there." }],
  },
};

function fakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: JSON.stringify({ suggestions: [{ written: "Ayesha", say_as: "eye-sha" }] }) }],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3000,
      iterations: null,
    },
    ...overrides,
  };
}

function fakeClient(responses: (() => unknown)[]): ClaudeClient & { calls: unknown[]; streamCalls: unknown[] } {
  const calls: unknown[] = [];
  const streamCalls: unknown[] = [];
  let i = 0;
  const next = async () => {
    const respond = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return respond();
  };
  return {
    calls,
    streamCalls,
    create: async (params) => {
      calls.push(params);
      return (await next()) as never;
    },
    stream: (params) => {
      streamCalls.push(params);
      return { finalMessage: async () => (await next()) as never };
    },
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mock mode (the default)", () => {
  it("answers every task with valid sample data, no client and no network", async () => {
    const createClient = vi.fn();
    const logUsage = vi.fn(async (_row: UsageRow) => {});
    for (const task of Object.keys(CLAUDE_TASKS) as ClaudeTaskName[]) {
      const output = await runClaudeTask(task, { brand: BRAND, input: INPUTS[task] as never }, { createClient, logUsage });
      expect(() => CLAUDE_TASKS[task].output.parse(output)).not.toThrow();
    }
    expect(createClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Mock calls are logged with zero cost, so the usage page shows activity.
    expect(logUsage).toHaveBeenCalledTimes(Object.keys(CLAUDE_TASKS).length);
    for (const [row] of logUsage.mock.calls) {
      expect(row.cost_usd).toBe(0);
      expect(row.model).toMatch(/^mock:/);
      expect(row.brand_id).toBe(BRAND.id);
    }
  });

  it("stays in mock mode even if an API key exists", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-not-real");
    const createClient = vi.fn();
    await runClaudeTask("brand_profile", { brand: BRAND, input: {} }, { createClient, logUsage: async () => {} });
    expect(createClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes a brand-aware profile with 4 to 6 pillars and no banned words", async () => {
    const out = brandProfileOutput.parse(
      await runClaudeTask("brand_profile", { brand: BRAND, input: {} }, { logUsage: async () => {} }),
    );
    expect(out.profile_md).toContain(BRAND.name);
    expect(out.pillars.length).toBeGreaterThanOrEqual(4);
    expect(out.pillars.length).toBeLessThanOrEqual(6);
    const text = JSON.stringify(out).toLowerCase();
    for (const word of BRAND.banned_words) expect(text).not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it("plans exactly the dates it was given", async () => {
    const input = INPUTS.plan as { slots: string[] };
    const out = planOutput.parse(await runClaudeTask("plan", { brand: BRAND, input: input as never }, { logUsage: async () => {} }));
    expect(out.posts.map((p) => p.date)).toEqual(input.slots);
  });

  it("writes a script that fits the time limit and uses the brand's offer in the call to action", async () => {
    const out = scriptOutput.parse(
      await runClaudeTask("script", { brand: BRAND, input: INPUTS.script as never }, { logUsage: async () => {} }),
    );
    const words = out.display_text.split(/\s+/).filter(Boolean).length;
    expect(words / BRAND.words_per_second).toBeLessThanOrEqual(45);
    expect(out.cta.toLowerCase()).toContain("online consultation");
    expect(out.captions.x.length).toBeLessThanOrEqual(280);
    const text = JSON.stringify(out).toLowerCase();
    for (const word of BRAND.banned_words) expect(text).not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it("suggests one respelling per word", async () => {
    const out = pronunciationOutput.parse(
      await runClaudeTask("pronunciation_suggest", { brand: BRAND, input: INPUTS.pronunciation_suggest as never }, { logUsage: async () => {} }),
    );
    expect(out.suggestions.map((s) => s.written)).toEqual(["Ayesha", "Gulberg"]);
  });

  it("gives a QA verdict in the rubric shape", async () => {
    const out = scriptQaOutput.parse(
      await runClaudeTask("script_qa", { brand: BRAND, input: INPUTS.script_qa as never }, { logUsage: async () => {} }),
    );
    expect(out.cta_matches_offers).toBe(true);
    expect(out.voice_score).toBeGreaterThanOrEqual(1);
  });

  it("rejects bad input before doing anything", async () => {
    await expect(
      runClaudeTask("plan", { brand: BRAND, input: { slots: [], pillars: [] } as never }, { logUsage: async () => {} }),
    ).rejects.toThrow();
  });
});

describe("models", () => {
  it("come from env with the documented defaults", () => {
    vi.stubEnv("CLAUDE_MODEL_MAIN", "");
    vi.stubEnv("CLAUDE_MODEL_PLANNER", "");
    vi.stubEnv("CLAUDE_MODEL_FAST", "");
    expect(claudeModel("main")).toBe("claude-sonnet-5-5");
    expect(claudeModel("planner")).toBe("claude-opus-5-5");
    expect(claudeModel("fast")).toBe("claude-haiku-5-5");
    vi.stubEnv("CLAUDE_MODEL_MAIN", "custom-main");
    expect(claudeModel("main")).toBe("custom-main");
  });
});

describe("request rules (CLAUDE.md)", () => {
  it("every task sets effort and obeys the 400 rules", () => {
    vi.stubEnv("CLAUDE_MODEL_MAIN", "test-main");
    vi.stubEnv("CLAUDE_MODEL_PLANNER", "test-planner");
    vi.stubEnv("CLAUDE_MODEL_FAST", "test-fast");
    for (const task of Object.keys(CLAUDE_TASKS) as ClaudeTaskName[]) {
      const params = buildClaudeRequest(task, { brand: BRAND, input: INPUTS[task] as never });
      const def = CLAUDE_TASKS[task];
      expect(params.model).toBe(`test-${def.model}`);
      expect(params.output_config?.effort).toBe(def.effort);
      expect(["low", "medium"]).toContain(params.output_config?.effort);
      expect(params.output_config?.format).toMatchObject({ type: "json_schema" });
      for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "thinking", "tools"]) {
        expect(params).not.toHaveProperty(banned);
      }
      expect(JSON.stringify(params)).not.toContain("budget_tokens");
      // No prefill: the last message is always the user's.
      expect(params.messages.at(-1)?.role).toBe("user");
      // The brand profile sits in a cached system block.
      const system = params.system as { type: string; text: string; cache_control?: unknown }[];
      const brandBlock = system.at(-1)!;
      expect(brandBlock.cache_control).toEqual({ type: "ephemeral" });
      expect(brandBlock.text).toContain(BRAND.name);
      expect(brandBlock.text).toContain("miracle");
      // Stable Messages API only: no beta server-side fallbacks.
      for (const beta of ["fallbacks", "betas", "anthropic-beta"]) {
        expect(params).not.toHaveProperty(beta);
      }
    }
  });

  it("uses only the stable Messages API (no beta client, helpers or headers)", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/claude.ts"), "utf8");
    expect(source).toContain("// TODO: revisit Anthropic server-side fallbacks (beta) once GA");
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.beta\.|helpers\/beta|resources\/beta|betaZodOutputFormat|anthropic-beta|fallbacks:|betas:/);
  });

  it("FAST tasks use low effort, scripts and plans use medium", () => {
    expect(CLAUDE_TASKS.pronunciation_suggest).toMatchObject({ model: "fast", effort: "low" });
    expect(CLAUDE_TASKS.plan).toMatchObject({ model: "planner", effort: "medium", stream: true });
    expect(CLAUDE_TASKS.script).toMatchObject({ model: "main", effort: "medium" });
    expect(CLAUDE_TASKS.brand_profile).toMatchObject({ model: "main", effort: "medium" });
    // p5-b2: Gate 5 is Claude MAIN with image input (QA-SPEC), effort set explicitly.
    expect(CLAUDE_TASKS.visual_qa).toMatchObject({ model: "main", effort: "medium", prompt: "visual-qa.md", stream: false });
  });

  it("loads each task's instructions from a file in /prompts", () => {
    const params = buildClaudeRequest("script", { brand: BRAND, input: INPUTS.script as never });
    const user = params.messages[0].content as string;
    expect(user).toContain("Fever: when to worry");
    expect(user.length).toBeGreaterThan(200);
  });
});

describe("real mode with a fake client", () => {
  const real = { mock: false, sleep: async () => {} };

  it("returns the parsed answer and logs tokens and cost", async () => {
    const client = fakeClient([() => fakeMessage()]);
    const logUsage = vi.fn(async (_row: UsageRow) => {});
    const out = await runClaudeTask(
      "pronunciation_suggest",
      { brand: BRAND, input: INPUTS.pronunciation_suggest as never },
      { ...real, client, logUsage },
    );
    expect(out).toEqual({ suggestions: [{ written: "Ayesha", say_as: "eye-sha" }] });
    expect(client.calls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logUsage).toHaveBeenCalledWith({
      brand_id: BRAND.id,
      task: "pronunciation_suggest",
      model: "claude-sonnet-5-5",
      input_tokens: 4000,
      output_tokens: 200,
      cost_usd: estimateCostUsd("claude-sonnet-5-5", {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 3000,
      }),
    });
  });

  it("turns a refusal into a plain error, and still logs the tokens", async () => {
    const client = fakeClient([() => fakeMessage({ stop_reason: "refusal", content: [] })]);
    const logUsage = vi.fn(async () => {});
    const error = await runClaudeTask("brand_profile", { brand: BRAND, input: {} }, { ...real, client, logUsage }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/declined/i);
    expect(logUsage).toHaveBeenCalledTimes(1);
  });

  it("does not read content when the answer was cut off", async () => {
    const client = fakeClient([() => fakeMessage({ stop_reason: "max_tokens" })]);
    await expect(
      runClaudeTask("pronunciation_suggest", { brand: BRAND, input: INPUTS.pronunciation_suggest as never }, { ...real, client, logUsage: async () => {} }),
    ).rejects.toThrow(/too long/i);
  });

  it("reads only the text blocks of the answer (thinking blocks are skipped)", async () => {
    const good = { suggestions: [{ written: "Gulberg", say_as: "gul-berg" }] };
    const client = fakeClient([
      () =>
        fakeMessage({
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: JSON.stringify(good) },
          ],
        }),
    ]);
    const out = await runClaudeTask(
      "pronunciation_suggest",
      { brand: BRAND, input: INPUTS.pronunciation_suggest as never },
      { ...real, client, logUsage: async () => {} },
    );
    expect(out).toEqual(good);
  });

  it("rejects answers that don't match the schema", async () => {
    const client = fakeClient([() => fakeMessage({ content: [{ type: "text", text: '{"suggestions": "nope"}' }] })]);
    await expect(
      runClaudeTask("pronunciation_suggest", { brand: BRAND, input: INPUTS.pronunciation_suggest as never }, { ...real, client, logUsage: async () => {} }),
    ).rejects.toThrow(/unexpected answer/i);
  });

  it("streams long answers (monthly plans) and uses the final message", async () => {
    const plan = { posts: [{ date: "2026-12-01", pillar: "Fever myths", title: "Fever 101", hook: "Is it serious?", format: "talking" }] };
    const client = fakeClient([() => fakeMessage({ model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(plan) }] })]);
    const out = await runClaudeTask(
      "plan",
      { brand: BRAND, input: { slots: ["2026-12-01"], pillars: ["Fever myths"] } },
      { ...real, client, logUsage: async () => {} },
    );
    expect(out).toEqual(plan);
    expect(client.streamCalls).toHaveLength(1);
    expect(client.calls).toHaveLength(0);
  });

  it("retries busy errors with backoff, but not bad requests", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const busy = Object.assign(new Error("overloaded"), { status: 529 });
    const client = fakeClient([
      () => {
        throw busy;
      },
      () => {
        throw busy;
      },
      () => fakeMessage(),
    ]);
    await runClaudeTask(
      "pronunciation_suggest",
      { brand: BRAND, input: INPUTS.pronunciation_suggest as never },
      { mock: false, client, sleep, logUsage: async () => {} },
    );
    expect(client.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const [first, second] = sleep.mock.calls.map(([ms]) => ms);
    expect(second).toBeGreaterThan(first);

    const badRequest = Object.assign(new Error("bad"), { status: 400 });
    const client2 = fakeClient([
      () => {
        throw badRequest;
      },
    ]);
    await expect(
      runClaudeTask("pronunciation_suggest", { brand: BRAND, input: INPUTS.pronunciation_suggest as never }, { mock: false, client: client2, sleep, logUsage: async () => {} }),
    ).rejects.toThrow();
    expect(client2.calls).toHaveLength(1);
  });

  it("gives up after a few tries with a plain error", async () => {
    const busy = Object.assign(new Error("overloaded"), { status: 529 });
    const client = fakeClient([
      () => {
        throw busy;
      },
    ]);
    await expect(
      runClaudeTask("pronunciation_suggest", { brand: BRAND, input: INPUTS.pronunciation_suggest as never }, { ...real, client, logUsage: async () => {} }),
    ).rejects.toThrow(/busy/i);
    expect(client.calls).toHaveLength(3);
  });

  it("needs ANTHROPIC_API_KEY before making a real client", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      runClaudeTask("brand_profile", { brand: BRAND, input: {} }, { mock: false, logUsage: async () => {} }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("usage", () => {
  it("counts cache reads and writes as input and prices them with the model that answered", () => {
    const usage = usageFromMessage(
      fakeMessage({
        model: "claude-haiku-5-5",
        usage: { input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000 },
      }) as never,
    );
    expect(usage).toEqual({
      model: "claude-haiku-5-5",
      input_tokens: 3500,
      output_tokens: 300,
      cost_usd: estimateCostUsd("claude-haiku-5-5", {
        input_tokens: 1000,
        output_tokens: 300,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 2000,
      }),
    });
  });
});

describe("one FAST fallback when MAIN or PLANNER stays overloaded", () => {
  const overloaded = () =>
    Object.assign(new Error("Overloaded"), { status: 529, error: { type: "error", error: { type: "overloaded_error" } } });
  const scriptAnswer = (model: string) =>
    fakeMessage({ model, content: [{ type: "text", text: JSON.stringify(SCRIPT) }] });
  const scriptCtx = { brand: BRAND, input: INPUTS.script as never };

  beforeEach(() => {
    vi.stubEnv("CLAUDE_MODEL_MAIN", "claude-sonnet-5-5");
    vi.stubEnv("CLAUDE_MODEL_PLANNER", "claude-opus-5-5");
    vi.stubEnv("CLAUDE_MODEL_FAST", "claude-haiku-5-5");
  });

  /** Every request the fake client saw must be a plain stable-API request. */
  function expectNoBetaFields(requests: unknown[]) {
    for (const params of requests) {
      for (const key of ["fallbacks", "betas", "anthropic-beta"]) expect(params).not.toHaveProperty(key);
      expect(JSON.stringify(params)).not.toMatch(/server-side-fallback|"fallbacks"|"betas"/);
    }
  }

  it("after the retries run out on a 529, makes exactly one FAST call and logs it as a fallback", async () => {
    const sleep = vi.fn(async () => {});
    const logUsage = vi.fn(async (_row: UsageRow) => {});
    const client = fakeClient([
      () => {
        throw overloaded();
      },
      () => {
        throw overloaded();
      },
      () => {
        throw overloaded();
      },
      () => scriptAnswer("claude-haiku-5-5"),
    ]);
    const out = await runClaudeTask("script", scriptCtx, { mock: false, client, sleep, logUsage });
    expect(out).toEqual(SCRIPT);
    expect(client.calls).toHaveLength(4);
    const models = client.calls.map((c) => (c as { model: string }).model);
    expect(models).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    // Effort stays explicit and uses the FAST setting.
    expect((client.calls[3] as { output_config: { effort: string } }).output_config.effort).toBe("low");
    expect(logUsage).toHaveBeenCalledTimes(1);
    expect(logUsage.mock.calls[0][0]).toMatchObject({
      brand_id: BRAND.id,
      task: "script:fallback_fast",
      model: "claude-haiku-5-5",
      cost_usd: estimateCostUsd("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000 }),
    });
    expectNoBetaFields(client.calls);
  });

  it("also covers streamed PLANNER tasks", async () => {
    const plan = { posts: [{ date: "2026-12-01", pillar: "Fever myths", title: "Fever 101", hook: "Is it serious?", format: "talking" }] };
    const client = fakeClient([
      () => {
        throw overloaded();
      },
      () => {
        throw overloaded();
      },
      () => {
        throw overloaded();
      },
      () => fakeMessage({ model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify(plan) }] }),
    ]);
    const logUsage = vi.fn(async (_row: UsageRow) => {});
    const out = await runClaudeTask(
      "plan",
      { brand: BRAND, input: { slots: ["2026-12-01"], pillars: ["Fever myths"] } },
      { mock: false, client, sleep: async () => {}, logUsage },
    );
    expect(out).toEqual(plan);
    expect(client.streamCalls.map((c) => (c as { model: string }).model)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ]);
    expect(logUsage.mock.calls[0][0]).toMatchObject({ task: "plan:fallback_fast", model: "claude-haiku-5-5" });
    expectNoBetaFields(client.streamCalls);
  });

  it("does not fall back when the first call works", async () => {
    const logUsage = vi.fn(async (_row: UsageRow) => {});
    const client = fakeClient([() => scriptAnswer("claude-sonnet-5-5")]);
    await runClaudeTask("script", scriptCtx, { mock: false, client, sleep: async () => {}, logUsage });
    expect(client.calls).toHaveLength(1);
    expect(logUsage.mock.calls[0][0]).toMatchObject({ task: "script", model: "claude-sonnet-5-5" });
    expectNoBetaFields(client.calls);
  });

  it("does not fall back on a refusal", async () => {
    const client = fakeClient([() => fakeMessage({ stop_reason: "refusal", content: [] })]);
    await expect(
      runClaudeTask("script", scriptCtx, { mock: false, client, sleep: async () => {}, logUsage: async () => {} }),
    ).rejects.toThrow(/declined/i);
    expect(client.calls).toHaveLength(1);
  });

  it("does not fall back on other server errors (only 529 overloaded)", async () => {
    const client = fakeClient([
      () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    ]);
    await expect(
      runClaudeTask("script", scriptCtx, { mock: false, client, sleep: async () => {}, logUsage: async () => {} }),
    ).rejects.toThrow(/busy/i);
    expect(client.calls).toHaveLength(3);
  });

  it("gives a plain error when the FAST model fails too", async () => {
    const logUsage = vi.fn(async (_row: UsageRow) => {});
    const client = fakeClient([
      () => {
        throw overloaded();
      },
    ]);
    const error = await runClaudeTask("script", scriptCtx, { mock: false, client, sleep: async () => {}, logUsage }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Claude is busy right now. Try again in a few minutes.");
    expect(client.calls).toHaveLength(4);
    expect(logUsage).not.toHaveBeenCalled();
    expectNoBetaFields(client.calls);
  });

  it("FAST tasks have nothing smaller to fall back to", async () => {
    const client = fakeClient([
      () => {
        throw overloaded();
      },
    ]);
    await expect(
      runClaudeTask("pronunciation_suggest", { brand: BRAND, input: INPUTS.pronunciation_suggest as never }, {
        mock: false,
        client,
        sleep: async () => {},
        logUsage: async () => {},
      }),
    ).rejects.toThrow(/busy/i);
    expect(client.calls).toHaveLength(3);
  });
});

describe("cost estimates", () => {
  it("price cache reads and writes differently", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(3);
    expect(estimateCostUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 1_000_000 })).toBe(15);
    expect(estimateCostUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.3);
    expect(estimateCostUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(3.75);
  });

  it("price unknown models like the most expensive one", () => {
    expect(estimateCostUsd("some-new-model", { input_tokens: 0, output_tokens: 1_000_000 })).toBe(
      estimateCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 1_000_000 }),
    );
  });
});
