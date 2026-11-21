import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";
import { memoryVideoFiles, memoryVideoStore } from "@/tests/helpers/video-memory";

// Admin → Consents and twins → twin → "Likeness test": Server Actions.
// requireAdmin first in every action, zod on inputs, plain errors, and the
// money rule: real renders need MOCK_HEYGEN=false AND the "I agree to spend" box.

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
vi.mock("@/lib/consent-store", () => ({ createConsentStore: () => mem.consentMem.store }));
vi.mock("@/lib/video-store", () => ({ createVideoStore: () => mem.store, createVideoFiles: () => files.storage }));
vi.mock("@/lib/heygen-spend-store", () => ({ createSpendStore: () => spend.store }));

const actions = await import("@/app/admin/consents/likeness-actions");

const idle = { status: "idle" as const, message: "" };
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const savedEnv = { ...process.env };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mem = memoryVideoStore();
  spend = memorySpendStore();
  files = memoryVideoFiles();
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  trigger.mockReset().mockResolvedValue({ id: "run_1" });
  createKey.mockClear();
  delete process.env.MOCK_HEYGEN;
  delete process.env.TRIGGER_SECRET_KEY;
  process.env.ADMIN_EMAILS = "admin@example.com";
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const twin = async () => (await mem.seedReadyTwin({ status: "likeness_test" })).avatar;

describe("every likeness action checks admin first", () => {
  it("a non-admin is stopped before anything runs", async () => {
    const avatar = await twin();
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(actions.startLikenessTestAction(avatar.id, idle, form({}))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(actions.checkLikenessAction(avatar.id, idle)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(actions.chooseEngineAction(avatar.id, idle, form({ engine: "avatar_v" }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(actions.needsReshootAction(avatar.id, idle)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mem.videos).toHaveLength(0);
    expect(mem.consentMem.avatars[0].status).toBe("likeness_test");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("a bad twin id is refused with a plain message", async () => {
    expect(await actions.startLikenessTestAction("not-a-uuid", idle, form({}))).toEqual({ status: "error", message: "Twin not found." });
    expect(await actions.chooseEngineAction("x", idle, form({ engine: "avatar_v" }))).toEqual({ status: "error", message: "Twin not found." });
  });
});

describe("startLikenessTestAction", () => {
  it("mock mode, no Trigger key: renders here from the fixture, no fetch, no confirm needed", async () => {
    const avatar = await twin();
    const result = await actions.startLikenessTestAction(avatar.id, idle, form({}));
    expect(result).toEqual({ status: "ok", message: "Mock likeness test done: 2 videos (no HeyGen call, nothing spent)." });
    expect(mem.videos.map((v) => [v.engine, v.status])).toEqual([
      ["avatar_v", "rendered"],
      ["avatar_iv", "rendered"],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("MOCK_HEYGEN=false without the box: refused, nothing made or sent", async () => {
    const avatar = await twin();
    process.env.MOCK_HEYGEN = "false";
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const result = await actions.startLikenessTestAction(avatar.id, idle, form({}));
    expect(result.status).toBe("error");
    expect(result.message).toContain("A real HeyGen render costs money.");
    expect(trigger).not.toHaveBeenCalled();
    expect(mem.videos).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the box only counts with the exact value 'yes' (zod)", async () => {
    const avatar = await twin();
    expect(await actions.startLikenessTestAction(avatar.id, idle, form({ confirm_spend: "on" }))).toEqual({
      status: "error",
      message: "Tick “I agree to spend” to confirm.",
    });
  });

  it("MOCK_HEYGEN=false with the box and a Trigger key: starts the likeness-test task with confirmSpend true (key = twin)", async () => {
    const avatar = await twin();
    process.env.MOCK_HEYGEN = "false";
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const result = await actions.startLikenessTestAction(avatar.id, idle, form({ confirm_spend: "yes" }));
    expect(result).toEqual({ status: "ok", message: "Likeness test started in the background. Refresh in a few minutes." });
    expect(trigger).toHaveBeenCalledWith(
      "likeness-test",
      { avatarId: avatar.id, confirmSpend: true },
      { idempotencyKey: `key:likeness-${avatar.id}:${JSON.stringify({ scope: "global" })}`, idempotencyKeyTTL: "10m" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("MOCK_HEYGEN=false without a Trigger key: never renders from a page", async () => {
    const avatar = await twin();
    process.env.MOCK_HEYGEN = "false";
    const result = await actions.startLikenessTestAction(avatar.id, idle, form({ confirm_spend: "yes" }));
    expect(result).toEqual({
      status: "error",
      message: "Real renders run in the background: add TRIGGER_SECRET_KEY first. Nothing was sent to HeyGen.",
    });
    expect(mem.videos).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a rule failure comes back as the plain sentence", async () => {
    const { avatar } = await mem.seedReadyTwin({ status: "likeness_test", heygenConsent: "pending" });
    const result = await actions.startLikenessTestAction(avatar.id, idle, form({}));
    expect(result).toEqual({
      status: "error",
      message: "HeyGen's own consent for this twin is not accepted yet. Nothing was sent to HeyGen.",
    });
  });
});

describe("decisions", () => {
  it("chooseEngineAction saves the engine after a finished test video; zod rejects odd input", async () => {
    const avatar = await twin();
    await actions.startLikenessTestAction(avatar.id, idle, form({}));
    expect(await actions.chooseEngineAction(avatar.id, idle, form({ engine: "avatar_v; drop" }))).toEqual({
      status: "error",
      message: "Pick an engine from the list.",
    });
    expect(await actions.chooseEngineAction(avatar.id, idle, form({ engine: "avatar_v" }))).toEqual({
      status: "ok",
      message: "Saved: this client's videos will use avatar_v.",
    });
    expect(mem.brand(BRAND_ID)!.engine).toBe("avatar_v");
    expect(mem.consentMem.avatars[0]).toMatchObject({ status: "ready", chosen_engine: "avatar_v" });
  });

  it("end to end in mock mode (what the page shows): start → side-by-side signed links → Use this engine", async () => {
    const avatar = await twin();
    await actions.startLikenessTestAction(avatar.id, idle, form({}));
    const { listLikenessTest } = await import("@/lib/likeness");
    const items = await listLikenessTest(avatar.id, { videos: mem.store, files: files.storage });
    expect(items.map((i) => [i.video.engine, i.url?.startsWith("https://storage.example.invalid/signed/raw/")])).toEqual([
      ["avatar_v", true],
      ["avatar_iv", true],
    ]);
    expect(files.signed.every((s) => s.seconds === 300)).toBe(true);
    await actions.chooseEngineAction(avatar.id, idle, form({ engine: "avatar_iv" }));
    expect(mem.brand(BRAND_ID)!.engine).toBe("avatar_iv");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("needsReshootAction: reshoot_needed + tips to admins only", async () => {
    const avatar = await twin();
    expect(await actions.needsReshootAction(avatar.id, idle)).toEqual({
      status: "ok",
      message: "Marked as needing a reshoot. Recording tips were saved for the admins (mock email).",
    });
    expect(mem.consentMem.avatars[0].status).toBe("reshoot_needed");
    expect(mem.consentMem.outbox.map((o) => o.to_email)).toEqual(["admin@example.com"]);
  });

  it("checkLikenessAction asks HeyGen once per rendering test video (mock: finishes them)", async () => {
    const avatar = await twin();
    const { runLikenessTest } = await import("@/lib/likeness");
    const { createHeygenClient } = await import("@/lib/heygen");
    await runLikenessTest(avatar.id, { store: mem.consentMem.store, videos: mem.store, heygen: createHeygenClient({ apiKey: "d" }), spend: spend.store });
    expect(await actions.checkLikenessAction(avatar.id, idle)).toEqual({ status: "ok", message: "Checked 2 test videos: 2 ready." });
    expect(mem.videos.map((v) => v.status)).toEqual(["rendered", "rendered"]);
  });
});
