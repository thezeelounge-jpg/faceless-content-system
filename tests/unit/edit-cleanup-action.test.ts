import { beforeEach, describe, expect, it, vi } from "vitest";

// p5-a: Settings → "Clean up old edit files" (admin first, then the confirm box, then the sweep).

const requireAdmin = vi.fn();
const cleanup = vi.fn();
vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/edit-store", () => ({ createCleanupStore: () => ({}), createRunFileStorage: () => ({}) }));
vi.mock("@/lib/edit-cleanup", () => ({ cleanupStrayRunFiles: (deps: unknown) => cleanup(deps) }));

const { cleanupEditFilesAction } = await import("@/app/admin/edit-cleanup-actions");
const idle = { status: "idle" as const, message: "" };
const form = (confirm?: string) => {
  const data = new FormData();
  if (confirm) data.set("confirm_cleanup", confirm);
  return data;
};

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  cleanup.mockReset().mockResolvedValue({ videos: 3, removed: ["final/b/v/runs/run_a.mp4"], kept: 4, failed: 0 });
});

describe("cleanupEditFilesAction", () => {
  it("checks admin before anything else", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(cleanupEditFilesAction(idle, form("yes"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("needs the confirm box", async () => {
    expect(await cleanupEditFilesAction(idle, form())).toEqual({ status: "error", message: "Tick the box to confirm." });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("runs the sweep and says what it did in plain words", async () => {
    expect(await cleanupEditFilesAction(idle, form("yes"))).toEqual({
      status: "ok",
      message: "Checked 3 videos. Removed 1 old edit file.",
    });
    cleanup.mockResolvedValue({ videos: 2, removed: [], kept: 2, failed: 1 });
    expect(await cleanupEditFilesAction(idle, form("yes"))).toEqual({
      status: "error",
      message: "Checked 2 videos. Removed 0 old edit files. 1 could not be removed; try again later.",
    });
  });

  it("a failure is a plain sentence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup.mockRejectedValue(new Error("[edit] list run files: timed out after 120000 ms"));
    expect(await cleanupEditFilesAction(idle, form("yes"))).toEqual({
      status: "error",
      message: "Something went wrong. Please try again in a minute.",
    });
  });
});
