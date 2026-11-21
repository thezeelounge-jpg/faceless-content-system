import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_ID, memoryClipStorage, memoryConsentStore } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";

const requireAdmin = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
const trigger = vi.fn();
const createKey = vi.fn(async (key: string, opts: unknown) => `key:${key}:${JSON.stringify(opts)}`);
const headerValues = new Map<string, string>();
let mem: ReturnType<typeof memoryConsentStore>;
let clips: ReturnType<typeof memoryClipStorage>;

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(Object.fromEntries(headerValues)) }));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => trigger(...args) },
  idempotencyKeys: { create: (key: string, opts: unknown) => createKey(key, opts) },
}));
vi.mock("@/lib/consent-store", () => ({
  createConsentStore: () => mem.store,
  createClipStorage: () => clips.storage,
}));
vi.mock("@/lib/heygen-spend-store", () => ({ createSpendStore: () => spend.store }));
let spend: ReturnType<typeof memorySpendStore>;

const actions = await import("@/app/admin/consents/actions");

const idle = { status: "idle" as const, message: "" };
const MB = 1024 * 1024;
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const savedEnv = { ...process.env };

beforeEach(() => {
  mem = memoryConsentStore();
  clips = memoryClipStorage();
  spend = memorySpendStore();
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  redirect.mockClear();
  trigger.mockReset().mockResolvedValue({ id: "run_1" });
  createKey.mockClear();
  headerValues.clear();
  delete process.env.MOCK_HEYGEN;
  delete process.env.TRIGGER_SECRET_KEY;
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

async function newConsent() {
  return mem.store.insertConsent({
    brand_id: BRAND_ID,
    person_legal_name: "Ayesha Khan",
    checkbox_at: new Date().toISOString(),
    words: ["apple", "river", "tiger"],
    words_expire_at: new Date(Date.now() + 1_800_000).toISOString(),
    ip: null,
    user_agent: null,
  });
}

async function checkedConsent(passed = true) {
  const consent = await newConsent();
  const clipPath = `${BRAND_ID}/${consent.id}/66666666-6666-4666-8666-666666666666.mp4`;
  clips.files[clipPath] = { size: 1 * MB, contentType: "video/mp4", fixture: "consent-good.mp4" };
  await mem.store.updateConsent(consent.id, {
    clip_path: clipPath,
    clip_checks: { passed, clip_path: clipPath, checked_at: "", checks: [], tips: [], measurements: {} as never },
  });
  return consent;
}

describe("admin check comes before anything else", () => {
  const ID = "c0000000-0000-4000-8000-000000000001";
  it.each([
    ["start", () => actions.startConsentAction(BRAND_ID, idle, form({ legal_name: "Ayesha Khan", agree: "on" }))],
    ["new words", () => actions.newWordsAction(ID, idle)],
    ["prepare upload", () => actions.prepareUploadAction(ID, { name: "c.mp4", type: "video/mp4", size: MB })],
    ["confirm upload", () => actions.confirmUploadAction(ID, "x")],
    ["re-check", () => actions.recheckClipAction(ID, idle)],
    ["approve", () => actions.approveConsentAction(ID, idle, form({ note: "" }))],
    ["reject", () => actions.rejectConsentAction(ID, idle, form({ note: "no" }))],
    ["start twin", () => actions.startTwinAction(ID, idle)],
    ["check twin", () => actions.checkTwinAction(ID, idle)],
  ])("%s", async (_name, run) => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    const insert = vi.spyOn(mem.store, "insertConsent");
    const get = vi.spyOn(mem.store, "getConsent");
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(insert).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("start consent", () => {
  it("saves ip and user agent from the request, then opens the consent page", async () => {
    headerValues.set("x-forwarded-for", "203.0.113.9, 10.0.0.1");
    headerValues.set("user-agent", "Mozilla/5.0 Test");
    await expect(
      actions.startConsentAction(BRAND_ID, idle, form({ legal_name: "Ayesha Khan", agree: "on" })),
    ).rejects.toThrow(/NEXT_REDIRECT \/admin\/consents\/c0/);
    expect(mem.consents[0]).toMatchObject({ ip: "203.0.113.9", user_agent: "Mozilla/5.0 Test", admin_status: "pending" });
  });

  it("decision 6: saves the client's email on the brand; a bad email is a plain error and nothing is saved", async () => {
    expect(
      await actions.startConsentAction(BRAND_ID, idle, form({ legal_name: "Ayesha Khan", agree: "on", client_email: "nope" })),
    ).toEqual({ status: "error", message: "Type the client's email address, or leave it empty." });
    expect(mem.consents).toHaveLength(0);
    await expect(
      actions.startConsentAction(
        BRAND_ID,
        idle,
        form({ legal_name: "Ayesha Khan", agree: "on", client_email: "ayesha@clinic.example" }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mem.getContactEmail()).toBe("ayesha@clinic.example");
  });

  it("without the checkbox: a plain error and nothing saved", async () => {
    expect(await actions.startConsentAction(BRAND_ID, idle, form({ legal_name: "Ayesha Khan" }))).toEqual({
      status: "error",
      message: "Tick the box to confirm the person agrees to a digital twin.",
    });
    expect(mem.consents).toHaveLength(0);
  });
});

describe("upload", () => {
  it("prepare: a signed upload token for a valid file; plain error for a wrong type", async () => {
    const consent = await newConsent();
    const ok = await actions.prepareUploadAction(consent.id, { name: "c.mp4", type: "video/mp4", size: 50 * MB });
    expect(ok).toMatchObject({ ok: true, token: expect.stringContaining("token-for-") });
    expect(await actions.prepareUploadAction(consent.id, { name: "c.avi", type: "video/x-msvideo", size: 20 * MB })).toEqual({
      ok: false,
      message: "Upload an MP4, WebM or MOV video. On iPhone: Settings → Camera → Formats → Most Compatible.",
    });
    expect(await actions.prepareUploadAction(consent.id, { name: 1, type: "video/mp4", size: "big" } as never)).toEqual({
      ok: false,
      message: "That file can't be uploaded.",
    });
  });

  it("decision 2, no Trigger key: confirm runs the same check job right here, clearly labelled", async () => {
    const consent = await newConsent();
    const clipPath = `${BRAND_ID}/${consent.id}/77777777-7777-4777-8777-777777777777.mp4`;
    clips.files[clipPath] = { size: 1 * MB, contentType: "video/mp4", fixture: "consent-good.mp4" };
    const state = await actions.confirmUploadAction(consent.id, clipPath);
    expect(state).toEqual({
      status: "ok",
      message: "Clip saved. Checks ran on this server (no background jobs set up): all passed.",
    });
    expect(await mem.store.getConsent(consent.id)).toMatchObject({ clip_check_status: "done" });
    expect((await mem.store.getConsent(consent.id))?.clip_checks?.passed).toBe(true);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("decision 2, with a Trigger key: confirm only starts check-clip (key = consent id + clip path)", async () => {
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const consent = await newConsent();
    const clipPath = `${BRAND_ID}/${consent.id}/77777777-7777-4777-8777-777777777777.mov`;
    clips.files[clipPath] = { size: 1 * MB, contentType: "video/quicktime", fixture: "consent-good.mov" };
    const state = await actions.confirmUploadAction(consent.id, clipPath);
    expect(state).toEqual({ status: "ok", message: "Clip saved. The checks are running in the background. Refresh in a minute." });
    expect(createKey).toHaveBeenCalledWith([consent.id, clipPath], { scope: "global" });
    expect(trigger).toHaveBeenCalledWith(
      "check-clip",
      { consentId: consent.id, clipPath },
      { idempotencyKey: `key:${consent.id},${clipPath}:{"scope":"global"}`, idempotencyKeyTTL: "10m" },
    );
    expect(await mem.store.getConsent(consent.id)).toMatchObject({ clip_check_status: "pending", clip_checks: null });
  });

  it("decision 2: Run checks with a Trigger key starts the task too; without a clip it is a plain error", async () => {
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const consent = await newConsent();
    expect(await actions.recheckClipAction(consent.id, idle)).toEqual({ status: "error", message: "Upload the clip first." });
    const clipPath = `${BRAND_ID}/${consent.id}/77777777-7777-4777-8777-777777777777.mp4`;
    await mem.store.updateConsent(consent.id, { clip_path: clipPath });
    expect((await actions.recheckClipAction(consent.id, idle)).status).toBe("ok");
    expect(trigger).toHaveBeenCalledWith("check-clip", { consentId: consent.id, clipPath }, expect.anything());
  });
});

describe("decision 7: input checks and plain errors on every consent action", () => {
  it("prepare: expired words → the plain 'New words' sentence; no upload token", async () => {
    const consent = await newConsent();
    await mem.store.updateConsent(consent.id, { words_expire_at: new Date(Date.now() - 60_000).toISOString() });
    expect(await actions.prepareUploadAction(consent.id, { name: "c.mp4", type: "video/mp4", size: 20 * MB })).toEqual({
      ok: false,
      message: "The 3 words have expired. Press “New words”, then record again saying the new words.",
    });
    expect(clips.uploadUrls).toEqual([]);
  });

  it("prepare: a file over 50 MB is refused with the shrink tip", async () => {
    const consent = await newConsent();
    const ticket = await actions.prepareUploadAction(consent.id, { name: "c.mp4", type: "video/mp4", size: 51 * MB });
    expect(ticket).toMatchObject({ ok: false, message: expect.stringContaining("The clip is too big (over 50 MB).") });
  });

  it("confirm: a non-string or over-long path is refused before anything is loaded", async () => {
    const get = vi.spyOn(mem.store, "getConsent");
    const bad = { status: "error", message: "That upload can't be used." };
    expect(await actions.confirmUploadAction("c0000000-0000-4000-8000-000000000001", 42 as never)).toEqual(bad);
    expect(await actions.confirmUploadAction("c0000000-0000-4000-8000-000000000001", "x".repeat(301))).toEqual(bad);
    expect(get).not.toHaveBeenCalled();
  });

  it("confirm: an unknown consent id is 'Consent not found.'", async () => {
    expect(await actions.confirmUploadAction("not-a-uuid", "a/b/c.mp4")).toEqual({ status: "error", message: "Consent not found." });
  });

  it("approve / reject: unknown consent → plain; reject without a note → plain", async () => {
    expect(await actions.approveConsentAction("c0000000-0000-4000-8000-0000000000ff", idle, form({ note: "" }))).toEqual({
      status: "error",
      message: "Consent not found.",
    });
    const consent = await checkedConsent();
    expect(await actions.rejectConsentAction(consent.id, idle, form({ note: "   " }))).toEqual({
      status: "error",
      message: "Write a short note saying why.",
    });
  });

  it("an unexpected store error: generic sentence for the admin, details only in the server log (redacted)", async () => {
    const consent = await newConsent();
    vi.spyOn(mem.store, "getConsent").mockRejectedValue(new Error("db exploded sb_secret_abcdefghijklmnop"));
    const state = await actions.recheckClipAction(consent.id, idle);
    expect(state).toEqual({ status: "error", message: "Something went wrong. Please try again in a minute." });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("[admin] clip checks failed");
    expect(logged).not.toContain("sb_secret_abcdefghijklmnop");
  });

  it("approve, no Trigger key, spend cap reached: approved, but the plain cap sentence is shown and HeyGen is not asked", async () => {
    spend.seed("create_twin", new Date().toISOString(), 2);
    const consent = await checkedConsent();
    const state = await actions.approveConsentAction(consent.id, idle, form({ note: "" }));
    expect(state).toEqual({
      status: "error",
      message:
        "Today's HeyGen limit for new twins is reached (2 a day). Nothing was sent to HeyGen. Try again tomorrow, or raise heygen_daily_caps in Settings.",
    });
    expect((await mem.store.getConsent(consent.id))?.admin_status).toBe("approved");
    expect(mem.avatars[0]).toMatchObject({ heygen_group_id: null, create_started_at: null });
  });
});

describe("approve starts the twin", () => {
  it("with TRIGGER_SECRET_KEY: starts create-twin with idempotency key = consent id (global)", async () => {
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const consent = await checkedConsent();
    const state = await actions.approveConsentAction(consent.id, idle, form({ note: "Words clear" }));
    expect(state).toEqual({ status: "ok", message: "Approved. Creating the twin in the background." });
    expect(createKey).toHaveBeenCalledWith(consent.id, { scope: "global" });
    expect(trigger).toHaveBeenCalledWith(
      "create-twin",
      { consentId: consent.id },
      { idempotencyKey: `key:${consent.id}:{"scope":"global"}` },
    );
    expect(mem.avatars).toHaveLength(1);
    expect(mem.avatars[0].heygen_group_id).toBeNull();
  });

  it("no Trigger key, mock HeyGen: makes the mock twin right here (free) and stores the consent 'email'", async () => {
    const consent = await checkedConsent();
    const state = await actions.approveConsentAction(consent.id, idle, form({ note: "" }));
    expect(state).toEqual({ status: "ok", message: "Approved. Mock twin created (no HeyGen call, nothing spent)." });
    expect(mem.avatars[0]).toMatchObject({
      heygen_group_id: "group_mock_0001",
      heygen_look_id: "look_mock_0001",
      voice_id: "voice_mock_0001",
      supported_engines: ["avatar_iv", "avatar_v"],
      status: "likeness_test",
    });
    expect(mem.outbox.map((o) => o.kind)).toEqual(["consent_link"]);
    expect(trigger).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("real HeyGen without a Trigger key: approves, but never calls HeyGen from the page", async () => {
    process.env.MOCK_HEYGEN = "false";
    const consent = await checkedConsent();
    const state = await actions.approveConsentAction(consent.id, idle, form({ note: "" }));
    expect(state).toEqual({
      status: "error",
      message: "Approved, but the twin was not started: add TRIGGER_SECRET_KEY, then press “Create twin”.",
    });
    expect(mem.avatars[0].heygen_group_id).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses when the clip checks did not pass: no avatar, no task", async () => {
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const consent = await checkedConsent(false);
    expect(await actions.approveConsentAction(consent.id, idle, form({ note: "" }))).toEqual({
      status: "error",
      message: "The clip checks must pass before approval. Ask for a reshoot.",
    });
    expect(mem.avatars).toHaveLength(0);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("Create twin on a pending consent is refused (no twin before approval)", async () => {
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const consent = await checkedConsent();
    expect(await actions.startTwinAction(consent.id, idle)).toEqual({
      status: "error",
      message: "No twin before the consent clip is approved.",
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("reject saves the note", async () => {
    const consent = await checkedConsent();
    expect(await actions.rejectConsentAction(consent.id, idle, form({ note: "Words not said" }))).toEqual({
      status: "ok",
      message: "Rejected.",
    });
    expect((await mem.store.getConsent(consent.id))?.admin_status).toBe("rejected");
  });

  it("a long note is refused by the form check", async () => {
    const consent = await checkedConsent();
    expect(await actions.rejectConsentAction(consent.id, idle, form({ note: "x".repeat(501) }))).toEqual({
      status: "error",
      message: "Keep the note under 500 characters.",
    });
  });
});
