import { describe, expect, it, vi } from "vitest";
import { editJobSchema } from "@/lib/edit-flow";
import { EDIT } from "@/lib/qa/config";

// The edit task is thin: all logic lives in lib/edit-flow.ts. Never run against Trigger.dev here.

vi.mock("@/lib/edit-store", () => ({ createEditStore: vi.fn(), createEditFiles: vi.fn() }));

const { editVideoTask, editVideoPayload, EDIT_TASK } = await import("@/trigger/edit-video");

describe("edit-video task", () => {
  it("has a stable id and uses the edit job schema as its payload", () => {
    expect(editVideoTask.id).toBe("edit-video");
    expect(editVideoPayload).toBe(editJobSchema);
  });

  it("runs on a 4 vCPU / 8 GB machine with a time limit above ffmpeg's own, and few retries", () => {
    expect(EDIT_TASK.machine).toBe("large-1x");
    expect(EDIT_TASK.maxDuration).toBeGreaterThan(EDIT.ffmpeg_timeout_s);
    expect(EDIT_TASK.maxDuration).toBeLessThanOrEqual(3600);
    expect(EDIT_TASK.retry.maxAttempts).toBe(2);
  });

  it("p4-b1: an edit claim goes stale only after the task's maxDuration (the old run is stopped by then)", () => {
    expect(EDIT_TASK.maxDuration).toBe(EDIT.task_max_duration_s);
    expect(EDIT.claim_stale_s).toBeGreaterThanOrEqual(EDIT_TASK.maxDuration);
  });
});
