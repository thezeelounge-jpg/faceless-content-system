import { beforeEach, describe, expect, it, vi } from "vitest";

// The QA Trigger.dev tasks stay thin: a zod payload, limits, and calls into lib/qa/pipeline.ts.
// startNext triggers the next step BY ID with a global idempotency key. Never run against Trigger.dev.

const sdk = vi.hoisted(() => ({
  trigger: vi.fn(async () => ({ id: "run_next" })),
  create: vi.fn(async (key: string, opts: { scope: string }) => `ik:${opts.scope}:${key}`),
}));
vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return { ...real, tasks: { ...real.tasks, trigger: sdk.trigger }, idempotencyKeys: { ...real.idempotencyKeys, create: sdk.create } };
});
vi.mock("@/lib/video-store", () => ({ createVideoStore: vi.fn(), createVideoFiles: vi.fn() }));
vi.mock("@/lib/heygen-spend-store", () => ({ createSpendStore: vi.fn() }));
vi.mock("@/lib/edit-store", () => ({ createEditStore: vi.fn(), createEditFiles: vi.fn() }));
vi.mock("@/lib/qa/pipeline-store", () => ({ createPipelineStore: vi.fn() }));

const { audioQaTask, audioQaPayload, AUDIO_QA_TASK } = await import("@/trigger/audio-qa");
const { technicalQaTask, technicalQaPayload, TECHNICAL_QA_TASK } = await import("@/trigger/technical-qa");
const { startNext } = await import("@/trigger/next-step");

const ID = "90000000-0000-4000-8000-000000000001";

beforeEach(() => {
  sdk.trigger.mockClear();
  sdk.create.mockClear();
});

describe("QA tasks", () => {
  it("have stable ids and take a video UUID", () => {
    expect(audioQaTask.id).toBe("audio-qa");
    expect(technicalQaTask.id).toBe("technical-qa");
    for (const schema of [audioQaPayload, technicalQaPayload]) {
      expect(schema.parse({ videoId: ID })).toEqual({ videoId: ID });
      expect(() => schema.parse({ videoId: "1; drop table" })).toThrow();
    }
  });

  it("run on 2 GB machines with time limits and few retries", () => {
    for (const t of [AUDIO_QA_TASK, TECHNICAL_QA_TASK]) {
      expect(t.machine).toBe("medium-1x");
      expect(t.maxDuration).toBeLessThanOrEqual(3600);
      expect(t.retry.maxAttempts).toBeLessThanOrEqual(3);
    }
  });
});

describe("startNext", () => {
  it("triggers the next task by id with a GLOBAL idempotency key (a retry never starts a step twice)", async () => {
    await startNext({ taskId: "technical-qa", payload: { videoId: ID }, key: `technical-qa-${ID}-run_1` });
    expect(sdk.create).toHaveBeenCalledWith(`technical-qa-${ID}-run_1`, { scope: "global" });
    expect(sdk.trigger).toHaveBeenCalledWith("technical-qa", { videoId: ID }, { idempotencyKey: `ik:global:technical-qa-${ID}-run_1` });
  });

  it("nothing next → nothing triggered", async () => {
    await startNext(null);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });
});
