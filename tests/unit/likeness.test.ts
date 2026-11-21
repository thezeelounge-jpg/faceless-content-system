import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeygenClient } from "@/lib/heygen";
import {
  chooseLikenessEngine,
  likenessEngines,
  listLikenessTest,
  markNeedsReshoot,
  prepareLikenessTest,
  runLikenessTest,
} from "@/lib/likeness";
import { LIKENESS_LINE, pollRenderOnce } from "@/lib/render";
import { countWords } from "@/lib/scripts";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";
import { memoryVideoFiles, memoryVideoStore } from "@/tests/helpers/video-memory";

// Item 6: the likeness test. One render of the same fixed line per realistic
// engine the look supports, through the normal render path (spend guard,
// claim, cap). Only for a twin in status likeness_test whose HeyGen consent
// is accepted. Never counted toward a plan.

const savedEnv = { ...process.env };
let mem: ReturnType<typeof memoryVideoStore>;
let spend: ReturnType<typeof memorySpendStore>;
let files: ReturnType<typeof memoryVideoFiles>;

beforeEach(() => {
  mem = memoryVideoStore();
  spend = memorySpendStore();
  files = memoryVideoFiles();
  delete process.env.MOCK_HEYGEN;
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const mockClient = () => createHeygenClient({ apiKey: "dummy" });
const deps = (overrides: Partial<Parameters<typeof runLikenessTest>[1]> = {}) => ({
  store: mem.consentMem.store,
  videos: mem.store,
  heygen: mockClient(),
  spend: spend.store,
  ...overrides,
});
async function twinForTest(opts: { heygenConsent?: string; engines?: string[] } = {}) {
  return (await mem.seedReadyTwin({ status: "likeness_test", ...opts })).avatar;
}

describe("likenessEngines", () => {
  it("keeps only the realistic engines the look supports, in our order (no turbo, no avatar_iii)", () => {
    expect(likenessEngines(["avatar_iii", "avatar_iv", "heygen-avatar-6-turbo", "avatar_v", "heygen-avatar-6"])).toEqual([
      "heygen-avatar-6",
      "avatar_v",
      "avatar_iv",
    ]);
    expect(likenessEngines(["avatar_iii"])).toEqual([]);
  });
});

describe("runLikenessTest", () => {
  it("mock: one likeness_test video per engine with the fixed line, through the spend guard, zero fetches", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const avatar = await twinForTest();
    const client = mockClient();
    const create = vi.spyOn(client, "createVideo");
    const { videos, results } = await runLikenessTest(avatar.id, deps({ heygen: client }));

    expect(videos.map((v) => v.engine)).toEqual(["avatar_v", "avatar_iv"]);
    expect(results.map((r) => r.status)).toEqual(["started", "started"]);
    for (const v of mem.videos) {
      expect(v).toMatchObject({ kind: "likeness_test", avatar_id: avatar.id, script_id: null, counts_toward_plan: false, status: "rendering" });
      expect(v.spoken_words).toBe(countWords(LIKENESS_LINE));
    }
    expect(create.mock.calls.map(([input]) => [input.engine, input.spokenText])).toEqual([
      ["avatar_v", LIKENESS_LINE],
      ["avatar_iv", LIKENESS_LINE],
    ]);
    expect(spend.rows.map((r) => [r.kind, r.status, r.note])).toEqual([
      ["render", "succeeded", "mock"],
      ["render", "succeeded", "mock"],
    ]);
    expect(spy).not.toHaveBeenCalled();
    // The poll (mock) finishes them from the fixture.
    for (const v of mem.videos) await pollRenderOnce(v.id, { videos: mem.store, heygen: client, files: files.storage });
    expect(mem.videos.map((v) => v.status)).toEqual(["rendered", "rendered"]);
  });

  it("the fixed line is about 15 seconds at the default 2.4 words a second", () => {
    expect(countWords(LIKENESS_LINE) / 2.4).toBeGreaterThan(13);
    expect(countWords(LIKENESS_LINE) / 2.4).toBeLessThan(18);
  });

  it("running it again makes no new videos and no second render", async () => {
    const avatar = await twinForTest();
    await runLikenessTest(avatar.id, deps());
    const again = await runLikenessTest(avatar.id, deps());
    expect(again.results.map((r) => r.status)).toEqual(["already_started", "already_started"]);
    expect(mem.videos).toHaveLength(2);
    expect(spend.rows).toHaveLength(2);
  });

  it("only for a twin in status likeness_test", async () => {
    const { avatar } = await mem.seedReadyTwin({ status: "training" });
    await expect(runLikenessTest(avatar.id, deps())).rejects.toThrow("The likeness test is for a twin that has finished training.");
    expect(mem.videos).toHaveLength(0);
  });

  it("only when HeyGen's own consent is accepted", async () => {
    const avatar = await twinForTest({ heygenConsent: "pending" });
    await expect(runLikenessTest(avatar.id, deps())).rejects.toThrow("HeyGen's own consent for this twin is not accepted yet.");
    expect(mem.videos).toHaveLength(0);
  });

  it("no realistic engine on the look: a plain error, nothing rendered", async () => {
    const avatar = await twinForTest({ engines: ["avatar_iii"] });
    await expect(runLikenessTest(avatar.id, deps())).rejects.toThrow("This twin supports none of the realistic engines");
    expect(mem.videos).toHaveLength(0);
  });

  it("MOCK_HEYGEN=false without confirm: refused before anything (no rows, no fetch)", async () => {
    const avatar = await twinForTest();
    const fake = vi.fn();
    process.env.MOCK_HEYGEN = "false";
    const client = createHeygenClient({ apiKey: "test-key-not-real", fetch: fake as unknown as typeof fetch });
    await expect(runLikenessTest(avatar.id, deps({ heygen: client }))).rejects.toThrow("A real HeyGen render costs money.");
    expect(fake).not.toHaveBeenCalled();
    expect(mem.videos).toHaveLength(0);
    expect(spend.rows).toHaveLength(0);
  });

  it("MOCK_HEYGEN=false with confirm: one POST per engine to the FAKE fetch, each through the spend guard", async () => {
    const avatar = await twinForTest();
    let n = 0;
    const fake = vi.fn(async () => new Response(JSON.stringify({ data: { video_id: `hg_${++n}` } }), { status: 200 }));
    process.env.MOCK_HEYGEN = "false";
    const client = createHeygenClient({ apiKey: "test-key-not-real", fetch: fake as unknown as typeof fetch });
    const { results } = await runLikenessTest(avatar.id, deps({ heygen: client, confirmSpend: true }));
    expect(results).toEqual([
      { status: "started", heygenVideoId: "hg_1" },
      { status: "started", heygenVideoId: "hg_2" },
    ]);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(spend.rows.map((r) => [r.kind, r.status, r.note])).toEqual([
      ["render", "succeeded", null],
      ["render", "succeeded", null],
    ]);
  });

  it("brands.paused: no render is sent", async () => {
    const avatar = await twinForTest();
    spend = memorySpendStore({ pausedBrands: [BRAND_ID] });
    const client = mockClient();
    const create = vi.spyOn(client, "createVideo");
    await expect(runLikenessTest(avatar.id, deps({ heygen: client }))).rejects.toThrow("This client is paused.");
    expect(create).not.toHaveBeenCalled();
  });

  it("prepareLikenessTest refuses a real run without confirm too (used by the background task path)", async () => {
    const avatar = await twinForTest();
    process.env.MOCK_HEYGEN = "false";
    const client = createHeygenClient({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    await expect(prepareLikenessTest(avatar.id, { store: mem.consentMem.store, videos: mem.store, heygen: client })).rejects.toThrow(
      "A real HeyGen render costs money.",
    );
    expect(mem.videos).toHaveLength(0);
  });
});

describe("the page data and the two decisions", () => {
  it("listLikenessTest: 5-minute signed URLs from the private bucket, only for rendered videos", async () => {
    const avatar = await twinForTest();
    const client = mockClient();
    await runLikenessTest(avatar.id, deps({ heygen: client }));
    await pollRenderOnce(mem.videos[0].id, { videos: mem.store, heygen: client, files: files.storage });
    const items = await listLikenessTest(avatar.id, { videos: mem.store, files: files.storage });
    expect(items.map((i) => [i.video.engine, i.url !== null])).toEqual([
      ["avatar_v", true],
      ["avatar_iv", false],
    ]);
    expect(files.signed).toEqual([{ path: mem.videos[0].raw_path, seconds: 300 }]);
  });

  it("Use this engine: saves brands.engine and avatars.chosen_engine, twin → ready", async () => {
    const avatar = await twinForTest();
    const client = mockClient();
    await runLikenessTest(avatar.id, deps({ heygen: client }));
    for (const v of mem.videos) await pollRenderOnce(v.id, { videos: mem.store, heygen: client, files: files.storage });
    mem.brand(BRAND_ID)!.engine = null;

    await chooseLikenessEngine(avatar.id, "avatar_iv", { store: mem.consentMem.store, videos: mem.store });

    expect(mem.brand(BRAND_ID)!.engine).toBe("avatar_iv");
    const saved = (await mem.consentMem.store.getAvatar(avatar.id))!;
    expect(saved).toMatchObject({ status: "ready", chosen_engine: "avatar_iv" });
    expect(saved.likeness_test).toMatchObject({ decision: "use_engine", engine: "avatar_iv", video_ids: mem.videos.map((v) => v.id) });
  });

  it("Use this engine: refused for an engine without a finished test video, or when the twin is not in the test", async () => {
    const avatar = await twinForTest();
    await runLikenessTest(avatar.id, deps());
    await expect(chooseLikenessEngine(avatar.id, "avatar_v", { store: mem.consentMem.store, videos: mem.store })).rejects.toThrow(
      "Watch the finished test video for that engine first.",
    );
    await expect(chooseLikenessEngine(avatar.id, "heygen-avatar-6", { store: mem.consentMem.store, videos: mem.store })).rejects.toThrow(
      "Watch the finished test video for that engine first.",
    );
    await mem.consentMem.store.updateAvatar(avatar.id, { status: "ready" });
    await expect(chooseLikenessEngine(avatar.id, "avatar_v", { store: mem.consentMem.store, videos: mem.store })).rejects.toThrow(
      "This twin is not waiting for a likeness decision.",
    );
  });

  it("Needs reshoot: twin → reshoot_needed; RECORDING-GUIDE tips go to the admins only (mock outbox)", async () => {
    const avatar = await twinForTest();
    mem.consentMem.setContactEmail("client@clinic.example");
    await markNeedsReshoot(avatar.id, { store: mem.consentMem.store, adminEmails: ["Admin@Example.com", "ops@example.com"] });

    const saved = (await mem.consentMem.store.getAvatar(avatar.id))!;
    expect(saved.status).toBe("reshoot_needed");
    expect(saved.likeness_test).toMatchObject({ decision: "reshoot" });
    expect(mem.consentMem.outbox.map((o) => [o.to_email, o.kind, o.status])).toEqual([
      ["admin@example.com", "reshoot_tips", "mocked"],
      ["ops@example.com", "reshoot_tips", "mocked"],
    ]);
    const body = mem.consentMem.outbox[0].body;
    expect(body).toContain("Face a window in daylight, or put one soft light in front of you.");
    expect(body).toContain("Hold the phone upright (vertical)");
    expect(mem.consentMem.outbox.some((o) => o.to_email === "client@clinic.example" || o.to_email === "owner@example.com")).toBe(false);
  });

  it("Needs reshoot: only while the twin waits for the likeness decision", async () => {
    const { avatar } = await mem.seedReadyTwin({ status: "training" });
    await expect(markNeedsReshoot(avatar.id, { store: mem.consentMem.store, adminEmails: ["a@x.com"] })).rejects.toThrow(
      "This twin is not waiting for a likeness decision.",
    );
    expect(mem.consentMem.outbox).toHaveLength(0);
  });
});
