import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_FIXTURE_VIDEO } from "@/lib/heygen";
import { verifyHeygenSignature } from "@/lib/heygen-webhook";
import { createPostRender, renderVideo } from "@/lib/render";
import { memoryClaimStore } from "@/tests/helpers/claims-memory";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";
import { POST_ID, memoryVideoFiles, memoryVideoStore } from "@/tests/helpers/video-memory";

// Item 8: POST /api/webhooks/heygen. Signed fixture payloads live in
// tests/fixtures/heygen/webhooks/ (.sig = hex HMAC-SHA256 of the exact file
// bytes with the TEST-ONLY secret below; scripts/sign-webhook-fixtures.mjs).
// HeyGen stays mocked: the "download" is the fixture video, never a fetch.

const TEST_SECRET = "test-webhook-secret-not-real";
const DIR = "tests/fixtures/heygen/webhooks";
const fixture = (name: string) => ({
  body: readFileSync(`${DIR}/${name}.json`, "utf8"),
  sig: readFileSync(`${DIR}/${name}.sig`, "utf8").trim(),
});

let mem: ReturnType<typeof memoryVideoStore>;
let files: ReturnType<typeof memoryVideoFiles>;
let spend: ReturnType<typeof memorySpendStore>;
const trigger = vi.fn();
const createKey = vi.fn(async (key: string) => `key:${key}`);

vi.mock("@/lib/video-store", () => ({ createVideoStore: () => mem.store, createVideoFiles: () => files.storage }));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => trigger(...args) },
  idempotencyKeys: { create: (key: string) => createKey(key) },
}));

const { POST } = await import("@/app/api/webhooks/heygen/route");

const savedEnv = { ...process.env };
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  mem = memoryVideoStore();
  files = memoryVideoFiles();
  trigger.mockReset().mockResolvedValue({ id: "run_1" });
  createKey.mockClear();
  delete process.env.MOCK_HEYGEN;
  delete process.env.TRIGGER_SECRET_KEY;
  process.env.HEYGEN_WEBHOOK_SECRET = TEST_SECRET;
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The video the fixtures talk about: first video in the store, rendering on (mock) HeyGen.
  await mem.seedReadyTwin();
  mem.seedApprovedPost();
  const video = await createPostRender(POST_ID, { videos: mem.store });
  const { createHeygenClient } = await import("@/lib/heygen");
  spend = memorySpendStore();
  await renderVideo(video.id, { videos: mem.store, heygen: createHeygenClient({ apiKey: "dummy" }), spend: spend.store });
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const post = (body: string, signature: string | null) =>
  POST(
    new Request("https://app.example.com/api/webhooks/heygen", {
      method: "POST",
      headers: signature === null ? { "content-type": "application/json" } : { "content-type": "application/json", signature },
      body,
    }),
  );

describe("signature (hex HMAC-SHA256 of the raw body)", () => {
  it("accepts the fixture signatures and rejects anything else, without throwing", () => {
    const { body, sig } = fixture("success");
    expect(sig).toBe(createHmac("sha256", TEST_SECRET).update(body).digest("hex"));
    expect(verifyHeygenSignature(body, sig, TEST_SECRET)).toBe(true);
    expect(verifyHeygenSignature(body, sig.toUpperCase(), TEST_SECRET)).toBe(true);
    expect(verifyHeygenSignature(body, sig, "another-secret")).toBe(false);
    expect(verifyHeygenSignature(body + " ", sig, TEST_SECRET)).toBe(false);
    expect(verifyHeygenSignature(body, sig.slice(0, 10), TEST_SECRET)).toBe(false); // length differs
    expect(verifyHeygenSignature(body, "zz".repeat(32), TEST_SECRET)).toBe(false); // not hex
    expect(verifyHeygenSignature(body, null, TEST_SECRET)).toBe(false);
    expect(verifyHeygenSignature(body, "", TEST_SECRET)).toBe(false);
  });
});

describe("POST /api/webhooks/heygen", () => {
  it("success: 200, one stored event, MP4 downloaded at once into the private bucket, video rendered", async () => {
    const { body, sig } = fixture("success");
    const response = await post(body, sig);
    expect(response.status).toBe(200);
    expect(mem.events).toHaveLength(1);
    expect(mem.events[0]).toMatchObject({
      source: "heygen",
      event_key: "heygen:avatar_video.success:video_mock_90000000-0000-4000-8000-000000000001",
    });
    expect(mem.events[0].processed_at).not.toBeNull();
    const video = mem.videos[0];
    expect(video).toMatchObject({ status: "rendered", raw_path: `raw/${BRAND_ID}/${video.id}.mp4`, duration_s: 16 });
    expect(files.files[video.raw_path!].bytes).toEqual(new Uint8Array(readFileSync(MOCK_FIXTURE_VIDEO)));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the same success sent twice: one processed event, one stored row, one download", async () => {
    const { body, sig } = fixture("success");
    expect((await post(body, sig)).status).toBe(200);
    const second = await post(body, sig);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, message: "Already handled." });
    expect(mem.events).toHaveLength(1);
    expect(files.uploads).toHaveLength(1);
  });

  it("fail: the reason is saved (plain) on the video and the post goes to the team queue", async () => {
    const { body, sig } = fixture("fail");
    expect((await post(body, sig)).status).toBe(200);
    expect(mem.videos[0]).toMatchObject({ status: "failed", error: "HeyGen could not make the video: Avatar render failed: face not detected" });
    expect(mem.posts[0].status).toBe("team_review");
    expect(files.uploads).toHaveLength(0);
  });

  it("bad signature: 401 and nothing stored or changed", async () => {
    const { body } = fixture("success");
    const forged = createHmac("sha256", "wrong-secret").update(body).digest("hex");
    expect((await post(body, forged)).status).toBe(401);
    expect((await post(body, null)).status).toBe(401);
    expect(mem.events).toHaveLength(0);
    expect(mem.videos[0].status).toBe("rendering");
  });

  it("tampered body (signature of the original): 401 and nothing stored", async () => {
    const { body, sig } = fixture("success");
    const tampered = body.replace("avatar_video.success", "avatar_video.fail");
    expect((await post(tampered, sig)).status).toBe(401);
    expect(mem.events).toHaveLength(0);
    expect(mem.videos[0].status).toBe("rendering");
  });

  it("missing HEYGEN_WEBHOOK_SECRET: 503 with a plain message, never 200, nothing stored", async () => {
    delete process.env.HEYGEN_WEBHOOK_SECRET;
    const { body, sig } = fixture("success");
    const response = await post(body, sig);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, message: "HeyGen webhooks are not set up yet." });
    expect(mem.events).toHaveLength(0);
  });

  it("signed but not JSON, or an unknown event: no crash, nothing processed", async () => {
    const notJson = "hello";
    expect((await post(notJson, createHmac("sha256", TEST_SECRET).update(notJson).digest("hex"))).status).toBe(400);
    const other = JSON.stringify({ event_type: "video_translate.success", event_data: { video_id: "x" } });
    const response = await post(other, createHmac("sha256", TEST_SECRET).update(other).digest("hex"));
    expect(response.status).toBe(200);
    expect(mem.events).toHaveLength(0);
    expect(mem.videos[0].status).toBe("rendering");
  });

  it("an event for a video we don't know: 200 (so HeyGen stops), stored once, nothing changed", async () => {
    const other = JSON.stringify({ event_type: "avatar_video.success", event_data: { video_id: "hg_unknown", callback_id: null } });
    const response = await post(other, createHmac("sha256", TEST_SECRET).update(other).digest("hex"));
    expect(response.status).toBe(200);
    expect(mem.events).toHaveLength(1);
    expect(mem.videos[0].status).toBe("rendering");
  });

  it("processing fails (e.g. Storage down): 500, the event stays unprocessed, and HeyGen's retry processes it", async () => {
    const { body, sig } = fixture("success");
    const upload = files.storage.upload;
    files.storage.upload = vi.fn(async () => {
      throw new Error("storage down");
    });
    expect((await post(body, sig)).status).toBe(500);
    expect(mem.events[0].processed_at).toBeNull();
    files.storage.upload = upload;
    expect((await post(body, sig)).status).toBe(200);
    expect(mem.videos[0].status).toBe("rendered");
    expect(mem.events).toHaveLength(1);
    expect(mem.events[0].processed_at).not.toBeNull();
  });

  it("QA MUST FIX 1 (g): a signed payload URL to a metadata IP or a look-alike host is never fetched; video not done; plain reason; no URL in logs", async () => {
    const dns = await import("node:dns");
    const lookup = vi.spyOn(dns.promises, "lookup").mockRejectedValue(new Error("real DNS must not be used in tests"));
    process.env.MOCK_HEYGEN = "false";
    process.env.HEYGEN_API_KEY = "test-key-not-real";
    // HeyGen's GET /v3/videos says "still processing", so the webhook falls back to the payload URL.
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.heygen.com/v3/videos/")) {
        return new Response(JSON.stringify({ data: { status: "processing" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("this host must never be fetched");
    });
    const errors = vi.mocked(console.error);
    for (const name of ["success-metadata-url", "success-evil-host"]) {
      const body = readFileSync(`${DIR}/${name}.json`, "utf8");
      const sig = createHmac("sha256", TEST_SECRET).update(body, "utf8").digest("hex");
      const response = await post(body, sig);
      expect(response.status, name).toBe(500);
    }
    // Only the free API status check was called; the payload hosts never were, and no DNS lookup ran.
    const fetched: string[] = fetchSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.startsWith("https://api.heygen.com/v3/videos/"))).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(mem.videos[0]).toMatchObject({ status: "rendering", raw_path: null, error: "The video link from HeyGen is not usable." });
    expect(files.uploads).toHaveLength(0);
    expect(mem.events.every((e) => e.processed_at === null)).toBe(true);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain("169.254.169.254");
    expect(logged).not.toContain("evil-cdn");
    expect(logged).not.toContain("test-key-not-real");
  });

  // ---- p4-fix c2: a success that arrives AFTER the claim was cleared ----

  /** The POST answer was lost (no HeyGen id), 40 minutes passed, and an admin cleared the claim. */
  async function lostThenCleared() {
    const video = mem.videos[0];
    Object.assign(video, { heygen_video_id: null, render_started_at: new Date(Date.now() - 40 * 60_000).toISOString(), error: null });
    expect(await memoryClaimStore(mem).claims.clear("video", video.id, "admin@example.com")).toBe("render");
    expect(video).toMatchObject({ status: "failed", heygen_video_id: null, render_started_at: null });
    expect(mem.posts[0].status).toBe("approved");
    return video;
  }
  const spendRowsFor = (videoId: string) => spend.rows.filter((r) => r.video_id === videoId).length;

  it("late success after a clear: HeyGen's id saved, logged, the paid file downloaded; NO new provider_usage row", async () => {
    const video = await lostThenCleared();
    const before = spendRowsFor(video.id);
    expect(before).toBe(1); // the original (mock) render reservation
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { body, sig } = fixture("success");
    const response = await post(body, sig);
    expect(response.status).toBe(200);
    expect(mem.videos[0]).toMatchObject({
      id: video.id,
      heygen_video_id: "video_mock_90000000-0000-4000-8000-000000000001",
      status: "rendered",
      raw_path: `raw/${BRAND_ID}/${video.id}.mp4`,
    });
    expect(files.uploads).toEqual([`raw/${BRAND_ID}/${video.id}.mp4`]);
    expect(mem.posts[0].status).toBe("rendering");
    expect(spendRowsFor(video.id)).toBe(before);
    expect(spend.rows).toHaveLength(1);
    expect(warn.mock.calls.map((c) => c.join(" "))).toContain(
      `[webhook] late HeyGen success adopted video=${video.id} heygen=video_mock_90000000-0000-4000-8000-000000000001`,
    );
    expect(mem.events[0].processed_at).not.toBeNull();
  });

  it("late success when a NEW render exists for the post: the new one is kept untouched; only the late id is recorded and logged", async () => {
    const old = await lostThenCleared();
    const fresh = await createPostRender(POST_ID, { videos: mem.store });
    await mem.store.updateVideo(fresh.id, { status: "rendering", render_started_at: new Date().toISOString() });
    const freshBefore = structuredClone(mem.videos.find((v) => v.id === fresh.id));
    const before = spend.rows.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { body, sig } = fixture("success");
    expect((await post(body, sig)).status).toBe(200);
    expect(mem.videos.find((v) => v.id === fresh.id)).toEqual(freshBefore);
    expect(mem.videos.find((v) => v.id === old.id)).toMatchObject({ status: "failed", heygen_video_id: null });
    expect(mem.lateHeygenIds.get(old.id)).toBe("video_mock_90000000-0000-4000-8000-000000000001");
    expect(files.uploads).toEqual([]);
    expect(spend.rows).toHaveLength(before);
    expect(warn.mock.calls.map((c) => c.join(" "))).toContain(
      `[webhook] late HeyGen success recorded (a newer render was kept) video=${old.id} heygen=video_mock_90000000-0000-4000-8000-000000000001`,
    );
    expect(mem.events[0].processed_at).not.toBeNull();
  });

  it("the same late success twice: adopted once, then 'Already handled.' (one download, no spend row)", async () => {
    await lostThenCleared();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { body, sig } = fixture("success");
    expect((await post(body, sig)).status).toBe(200);
    const second = await post(body, sig);
    expect(await second.json()).toMatchObject({ ok: true, message: "Already handled." });
    expect(files.uploads).toHaveLength(1);
    expect(spend.rows).toHaveLength(1);
  });

  it("with TRIGGER_SECRET_KEY: success hands the download to the poll-render task (key = event) and answers fast", async () => {
    process.env.TRIGGER_SECRET_KEY = "tr_dev_dummy";
    const { body, sig } = fixture("success");
    expect((await post(body, sig)).status).toBe(200);
    expect(trigger).toHaveBeenCalledWith(
      "poll-render",
      { videoId: mem.videos[0].id },
      { idempotencyKey: "key:webhook-heygen:avatar_video.success:video_mock_90000000-0000-4000-8000-000000000001" },
    );
    expect(files.uploads).toHaveLength(0);
    expect(mem.events[0].processed_at).not.toBeNull();
  });
});
