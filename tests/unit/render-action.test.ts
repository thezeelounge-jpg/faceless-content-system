import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySpendStore } from "@/tests/helpers/spend-memory";
import { POST_ID, memoryVideoFiles, memoryVideoStore } from "@/tests/helpers/video-memory";

// Admin → client → plan → "Make video" on an approved post (item 7).
// requireAdmin first, zod on the spend box, plain errors; real renders only
// with MOCK_HEYGEN=false + the box + the background task, never from a page.

const requireAdmin = vi.fn();
const trigger = vi.fn();
const createKey = vi.fn(async (key: string, opts: unknown) => `key:${key}:${JSON.stringify(opts)}`);
let mem: ReturnType<typeof memoryVideoStore>;
let spend: ReturnType<typeof memorySpendStore>;
let files: ReturnType<typeof memoryVideoFiles>;

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => trigger(...args) },
  idempotencyKeys: { create: (key: string, opts: unknown) => createKey(key, opts) },
}));
vi.mock("@/lib/video-store", () => ({ createVideoStore: () => mem.store, createVideoFiles: () => files.storage }));
vi.mock("@/lib/heygen-spend-store", () => ({ createSpendStore: () => spend.store }));
/** Lets one test hand the action a (mock) client whose POST answer is lost. */
let wrapClient: ((client: import("@/lib/heygen").HeygenClient) => import("@/lib/heygen").HeygenClient) | null = null;
vi.mock("@/lib/heygen", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/heygen")>();
  return { ...real, heygen: (opts?: { forPage?: boolean }) => (wrapClient ? wrapClient(real.heygen(opts)) : real.heygen(opts)) };
});

const { makeVideoAction } = await import("@/app/admin/clients/[id]/render-actions");

const idle = { status: "idle" as const, message: "" };
const form = (values: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const savedEnv = { ...process.env };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  mem = memoryVideoStore();
  spend = memorySpendStore();
  files = memoryVideoFiles();
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  trigger.mockReset().mockResolvedValue({ id: "run_1" });
  delete process.env.MOCK_HEYGEN;
  delete process.env.TRIGGER_SECRET_KEY;
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await mem.seedReadyTwin();
  mem.seedApprovedPost();
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("makeVideoAction", () => {
  it("checks admin first: a non-admin changes nothing", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(makeVideoAction(POST_ID, idle, form())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mem.videos).toHaveLength(0);
  });

  it("a bad post id: plain error", async () => {
    expect(await makeVideoAction("nope", idle, form())).toEqual({ status: "error", message: "Post not found." });
  });

  it("mock mode, no Trigger key: renders here from the fixture (no fetch) and saves the raw MP4", async () => {
    const result = await makeVideoAction(POST_ID, idle, form());
    expect(result).toEqual({ status: "ok", message: "Mock video made (no HeyGen call, nothing spent). The raw file is saved." });
    expect(mem.videos[0]).toMatchObject({ kind: "post", status: "rendered" });
    expect(Object.keys(files.files)).toEqual([mem.videos[0].raw_path]);
    expect(mem.posts[0].status).toBe("rendering");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("SF3: the POST answer is lost: the admin sees the plain 'may be rendering' message, the video stays rendering (not 'made')", async () => {
    const { HeygenError } = await import("@/lib/heygen");
    const { RENDER_UNKNOWN } = await import("@/lib/render");
    wrapClient = (client) => ({
      ...client,
      createVideo: async () => {
        throw new HeygenError("failed", "Could not reach HeyGen. Try again later.");
      },
    });
    try {
      const result = await makeVideoAction(POST_ID, idle, form());
      expect(result).toEqual({ status: "error", message: RENDER_UNKNOWN });
      expect(mem.videos[0]).toMatchObject({ status: "rendering", heygen_video_id: null });
      expect(files.uploads).toHaveLength(0);
    } finally {
      wrapClient = null;
    }
  });

  it("not approved: the plain rule comes back", async () => {
    mem.posts[0].status = "script_review";
    expect(await makeVideoAction(POST_ID, idle, form())).toEqual({ status: "error", message: "Only an approved script can be made into a video." });
  });

  it("MOCK_HEYGEN=false without the box: refused, no task, nothing sent", async () => {
    process.env.MOCK_HEYGEN = "false";
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const result = await makeVideoAction(POST_ID, idle, form());
    expect(result.message).toContain("A real HeyGen render costs money.");
    expect(trigger).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("MOCK_HEYGEN=false with the box and a Trigger key: starts render-video with confirmSpend true (key = video id)", async () => {
    process.env.MOCK_HEYGEN = "false";
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const result = await makeVideoAction(POST_ID, idle, form({ confirm_spend: "yes" }));
    expect(result).toEqual({ status: "ok", message: "Video started in the background. Refresh in a few minutes." });
    const videoId = mem.videos[0].id;
    expect(trigger).toHaveBeenCalledWith(
      "render-video",
      { videoId, confirmSpend: true },
      { idempotencyKey: `key:render-${videoId}:${JSON.stringify({ scope: "global" })}` },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("MOCK_HEYGEN=false without a Trigger key: never renders from a page", async () => {
    process.env.MOCK_HEYGEN = "false";
    expect(await makeVideoAction(POST_ID, idle, form({ confirm_spend: "yes" }))).toEqual({
      status: "error",
      message: "Real renders run in the background: add TRIGGER_SECRET_KEY first. Nothing was sent to HeyGen.",
    });
  });

  it("the box only counts as exactly 'yes'", async () => {
    expect(await makeVideoAction(POST_ID, idle, form({ confirm_spend: "true" }))).toEqual({
      status: "error",
      message: "Tick “I agree to spend” to confirm.",
    });
  });
});
