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
// p5-b2: afterVisual is the real one unless a test replaces its answer.
const pipe = vi.hoisted(() => ({ afterVisual: vi.fn() }));
vi.mock("@/lib/qa/pipeline", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/qa/pipeline")>();
  pipe.afterVisual.mockImplementation(real.afterVisual);
  return { ...real, afterVisual: pipe.afterVisual };
});

const { audioQaTask, audioQaPayload, AUDIO_QA_TASK, audioQaFailed } = await import("@/trigger/audio-qa");
const { technicalQaTask, technicalQaPayload, TECHNICAL_QA_TASK, technicalQaFailed } = await import("@/trigger/technical-qa");
const { visualQaTask, visualQaPayload, VISUAL_QA_TASK, visualQaFailed, runVisualQa } = await import("@/trigger/visual-qa");
const { createPipelineStore } = await import("@/lib/qa/pipeline-store");
const { GATE_CRASH_REASONS } = await import("@/lib/qa/pipeline");
const { startNext } = await import("@/trigger/next-step");
const { syncAfterEdit } = await import("@/trigger/edit-video");

const ID = "90000000-0000-4000-8000-000000000001";

beforeEach(() => {
  sdk.trigger.mockClear();
  sdk.create.mockClear();
});

describe("QA tasks", () => {
  it("have stable ids and take a video UUID", () => {
    expect(audioQaTask.id).toBe("audio-qa");
    expect(technicalQaTask.id).toBe("technical-qa");
    expect(visualQaTask.id).toBe("visual-qa");
    for (const schema of [audioQaPayload, technicalQaPayload, visualQaPayload]) {
      expect(schema.parse({ videoId: ID })).toEqual({ videoId: ID });
      expect(() => schema.parse({ videoId: "1; drop table" })).toThrow();
    }
  });

  it("run on 2 GB machines with time limits and few retries", () => {
    for (const t of [AUDIO_QA_TASK, TECHNICAL_QA_TASK, VISUAL_QA_TASK]) {
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

describe("p5-b1 (Rowan 4): edit-video re-syncs a post stuck in editing after a promoted edit", () => {
  const stuck = () => {
    const setPostStatus = vi.fn(async () => {});
    vi.mocked(createPipelineStore).mockReturnValue({
      getGateContext: vi.fn(async () => ({
        video: { id: ID, kind: "post", status: "final_qa", final_path: "final/b/v/runs/run_1.mp4", edit_run_id: "run_1", post_id: "post-1" },
        post: { id: "post-1", status: "editing" },
      })),
      setPostStatus,
    } as never);
    return setPostStatus;
  };

  it("an 'edited' outcome: the post moves to final_qa and Gate 4 is triggered ONCE, with the edit run's key", async () => {
    const setPostStatus = stuck();
    await syncAfterEdit(ID, { taskId: "technical-qa", payload: { videoId: ID }, key: `technical-qa-${ID}-run_1` });
    expect(setPostStatus).toHaveBeenCalledWith("post-1", "final_qa", null);
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
    expect(sdk.trigger).toHaveBeenCalledWith("technical-qa", { videoId: ID }, { idempotencyKey: `ik:global:technical-qa-${ID}-run_1` });
  });

  it("a retry refused because the edit already finished (no next of its own) still re-syncs and starts Gate 4 with the same key", async () => {
    const setPostStatus = stuck();
    await syncAfterEdit(ID, null);
    expect(setPostStatus).toHaveBeenCalledWith("post-1", "final_qa", null);
    expect(sdk.trigger).toHaveBeenCalledWith("technical-qa", { videoId: ID }, { idempotencyKey: `ik:global:technical-qa-${ID}-run_1` });
  });
});

describe("p5-b1 (QA SF1): onFailure (the run failed and will not be retried) sends the stuck row to the team", () => {
  const fakeStore = () => {
    const calls: unknown[][] = [];
    const store = {
      getGateContext: vi.fn(async () => ({ video: { id: ID, kind: "post", post_id: "post-1" } })),
      moveVideo: vi.fn(async (...args: unknown[]) => {
        calls.push(["moveVideo", ...args]);
        return true;
      }),
      setPostStatus: vi.fn(async (...args: unknown[]) => {
        calls.push(["setPostStatus", ...args]);
      }),
    };
    vi.mocked(createPipelineStore).mockReturnValue(store as never);
    return calls;
  };

  it("audio-qa: audio_qa → team_review (video and post)", async () => {
    const calls = fakeStore();
    await audioQaFailed({ payload: { videoId: ID }, error: new Error("ENOENT") });
    expect(calls).toEqual([
      ["moveVideo", ID, "team_review", ["audio_qa"], GATE_CRASH_REASONS.audio],
      ["setPostStatus", "post-1", "team_review", GATE_CRASH_REASONS.audio],
    ]);
  });

  it("technical-qa: final_qa → team_review (video and post)", async () => {
    const calls = fakeStore();
    await technicalQaFailed({ payload: { videoId: ID }, error: new Error("killed") });
    expect(calls).toEqual([
      ["moveVideo", ID, "team_review", ["final_qa"], GATE_CRASH_REASONS.technical],
      ["setPostStatus", "post-1", "team_review", GATE_CRASH_REASONS.technical],
    ]);
  });

  it("p5-b2 visual-qa: final_qa → team_review (video and post) with the visual reason", async () => {
    const calls = fakeStore();
    await visualQaFailed({ payload: { videoId: ID }, error: new Error("ffmpeg killed") });
    expect(calls).toEqual([
      ["moveVideo", ID, "team_review", ["final_qa"], GATE_CRASH_REASONS.visual],
      ["setPostStatus", "post-1", "team_review", GATE_CRASH_REASONS.visual],
    ]);
  });
});

describe("p5-b2: visual-qa runs Gate 5 and starts what comes next", () => {
  it("is wired to Claude via runClaudeTask (MOCK_CLAUDE path), the normal renderer and the pipeline store; a re-edit starts edit-video with its key", async () => {
    pipe.afterVisual.mockResolvedValueOnce({
      outcome: { status: "reedit", videoId: ID, captionStyle: "small_box", avoidClips: [] },
      next: { taskId: "edit-video", payload: { videoId: ID } as never, key: `edit-${ID}-visual-1` },
    });
    vi.mocked(createPipelineStore).mockReturnValue({} as never);
    const out = await runVisualQa(ID);
    expect(out.status).toBe("reedit");
    expect(pipe.afterVisual).toHaveBeenCalledWith(ID, expect.objectContaining({ run: expect.any(Function), render: expect.any(Function), store: {} }));
    expect(sdk.trigger).toHaveBeenCalledWith("edit-video", { videoId: ID }, { idempotencyKey: `ik:global:edit-${ID}-visual-1` });
  });
});
