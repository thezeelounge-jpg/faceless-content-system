import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEYGEN_RETRY_AFTER_MAX_S, createHeygenClient } from "@/lib/heygen";
import { RENDER } from "@/lib/qa/config";
import { LOST_RENDER, NOT_APPROVED_FOR_VIDEO, OTHER_SCRIPT_VIDEO, RENDER_UNKNOWN, createPostRender, heygenCallbackUrl, renderVideo } from "@/lib/render";
import { postRenderResult } from "@/lib/video-store";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";
import { POST_ID, SCRIPT_ID, memoryVideoStore } from "@/tests/helpers/video-memory";

// Item 7: the render path. Money rules under test:
// (a) mock mode → zero fetches; (b) MOCK_HEYGEN=false without the admin's
// confirm → refused before any HeyGen call; (c) with confirm → reaches the
// injected FAKE fetch, through the spend guard (provider_usage row).

const savedEnv = { ...process.env };
let mem: ReturnType<typeof memoryVideoStore>;
let spend: ReturnType<typeof memorySpendStore>;

beforeEach(() => {
  mem = memoryVideoStore();
  spend = memorySpendStore();
  delete process.env.MOCK_HEYGEN;
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: (() => Response)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no more fake answers");
    return next();
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** MOCK_HEYGEN=false from env, with a FAKE fetch injected (never the real one). */
function liveClient(fake: { fetch: typeof globalThis.fetch }, sleep = vi.fn(async () => {})) {
  process.env.MOCK_HEYGEN = "false";
  return createHeygenClient({ apiKey: "test-key-not-real", fetch: fake.fetch, sleep });
}

async function queuedPostVideo() {
  await mem.seedReadyTwin();
  mem.seedApprovedPost();
  return createPostRender(POST_ID, { videos: mem.store });
}

describe("createPostRender: only an approved script, with a chosen engine and a ready twin", () => {
  it("makes one queued post video with the brand's engine, the twin and the word count", async () => {
    const video = await queuedPostVideo();
    expect(video).toMatchObject({
      brand_id: BRAND_ID,
      script_id: SCRIPT_ID,
      kind: "post",
      engine: "avatar_v",
      status: "queued",
      spoken_words: 13,
      heygen_video_id: null,
      counts_toward_plan: false,
    });
    expect(video.avatar_id).toBe(mem.consentMem.avatars[0].id);
  });

  it("is idempotent: a second call returns the same video", async () => {
    const first = await queuedPostVideo();
    const second = await createPostRender(POST_ID, { videos: mem.store });
    expect(second.id).toBe(first.id);
    expect(mem.videos).toHaveLength(1);
  });

  it("refuses a post that is not approved, a script that did not pass, or an empty spoken_text", async () => {
    await mem.seedReadyTwin();
    mem.seedApprovedPost({ postStatus: "script_review" });
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow("Only an approved script can be made into a video.");
    mem.posts[0].status = "approved";
    mem.scripts[0].qa_status = "failed";
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow("The script has not passed its checks.");
    mem.scripts[0].qa_status = "passed";
    mem.scripts[0].spoken_text = " ";
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow("The script has no spoken text.");
    expect(mem.videos).toHaveLength(0);
  });

  it("p4-b3 (Q8): v1 already has an active video, then a newer v2 passes → Make video is refused (no second paid render)", async () => {
    await queuedPostVideo(); // V1 for script v1, queued: the post stays 'approved'
    mem.scripts.push({ ...mem.scripts[0], id: "30000000-0000-4000-8000-0000000000a2", version: 2, spoken_text: "A rewritten script." });
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow(OTHER_SCRIPT_VIDEO);
    expect(OTHER_SCRIPT_VIDEO).toBe("This post already has a video for an earlier version of its script. Clear that one first.");
    expect(mem.videos).toHaveLength(1);
    // The real store reads the rpc's new answer.
    expect(postRenderResult({ outcome: "other_script", video_id: mem.videos[0].id }, null)).toEqual({
      outcome: "other_script",
      videoId: mem.videos[0].id,
    });
  });

  it("p5-a: the script's QA changes after the app's check → the rpc re-check refuses (plain not-approved), no video", async () => {
    mem.seedApprovedPost();
    await mem.seedReadyTwin({ engine: "avatar_v" });
    const realGetAvatar = mem.store.getReadyAvatar.bind(mem.store);
    mem.store.getReadyAvatar = async (brandId) => {
      mem.scripts[0].qa_status = "team_review"; // e.g. a re-run of the checks between check and insert
      return realGetAvatar(brandId);
    };
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow(NOT_APPROVED_FOR_VIDEO);
    expect(mem.videos).toHaveLength(0);
  });

  it("refuses without a chosen engine, or without a ready twin that supports it (never falls back)", async () => {
    mem.seedApprovedPost();
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow(
      "This client has no ready twin yet. Finish the likeness test first.",
    );
    await mem.seedReadyTwin({ engine: "avatar_v" });
    mem.brand(BRAND_ID)!.engine = null;
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow("No engine chosen for this client.");
    mem.brand(BRAND_ID)!.engine = "heygen-avatar-6";
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow(
      "The twin does not support the chosen engine (heygen-avatar-6). Run the likeness test again.",
    );
    expect(mem.videos).toHaveLength(0);
  });

  it("p4-b1 race B: a late webhook adopts the old render WHILE Make video runs → no second video (the store refuses)", async () => {
    const v1 = await queuedPostVideo();
    // V1 was claimed, then cleared after the wait: failed + retired, post back to approved.
    Object.assign(mem.videos[0], { status: "failed", render_started_at: new Date(Date.now() - 40 * 60_000).toISOString() });
    mem.clearedAt.set(v1.id, new Date().toISOString());
    const realGetAvatar = mem.store.getReadyAvatar.bind(mem.store);
    let adopted: string | null = null;
    // QA's interleaving: the webhook lands between Make video's checks and its insert.
    mem.store.getReadyAvatar = async (brandId) => {
      adopted ??= await mem.store.adoptLateRender(v1.id, "hg_late_race");
      return realGetAvatar(brandId);
    };
    await expect(createPostRender(POST_ID, { videos: mem.store })).rejects.toThrow(NOT_APPROVED_FOR_VIDEO);
    expect(adopted).toBe("adopted");
    expect(mem.videos.filter((v) => !["failed", "skipped"].includes(v.status)).map((v) => v.id)).toEqual([v1.id]);
  });
});

describe("postRenderResult (create_post_render answer from Supabase)", () => {
  it("maps the answer, a unique violation (second active video of the post) to other_script, and throws on other errors", () => {
    const id = "90000000-0000-4000-8000-000000000001";
    expect(postRenderResult({ outcome: "created", video_id: id }, null)).toEqual({ outcome: "created", videoId: id });
    expect(postRenderResult({ outcome: "existing", video_id: id }, null)).toEqual({ outcome: "existing", videoId: id });
    expect(postRenderResult({ outcome: "not_approved", video_id: null }, null)).toEqual({ outcome: "not_approved", videoId: null });
    // p5-a (QA SF2): the per-post index backstop gets the same plain words as the rpc's other_script.
    expect(
      postRenderResult(null, {
        code: "23505",
        message: 'duplicate key value violates unique constraint "videos_one_active_post_video_per_post"',
      }),
    ).toEqual({ outcome: "other_script", videoId: null });
    expect(() => postRenderResult(null, { code: "42501", message: "permission denied" })).toThrow(/create post render/);
    expect(() => postRenderResult({ outcome: "weird" }, null)).toThrow(/create post render/);
  });
});

describe("renderVideo: money rules", () => {
  it("(a) mock mode: zero fetches, a mock HeyGen id, status rendering, post rendering, one provider_usage row (mock)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const video = await queuedPostVideo();
    const client = createHeygenClient({ apiKey: "dummy" });
    const create = vi.spyOn(client, "createVideo");

    const result = await renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store });

    expect(result).toEqual({ status: "started", heygenVideoId: `video_mock_${video.id}` });
    expect(spy).not.toHaveBeenCalled();
    // spoken_text, never display_text.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        spokenText: "Doctor Aaysha says brush twice a day. Floss once. See you next week.",
        engine: "avatar_v",
        lookId: "look_mock_0001",
        voiceId: "voice_mock_0001",
        callbackId: video.id,
      }),
    );
    expect(mem.videos[0]).toMatchObject({ status: "rendering", heygen_video_id: `video_mock_${video.id}`, error: null });
    expect(mem.videos[0].render_started_at).not.toBeNull();
    expect(mem.posts[0].status).toBe("rendering");
    expect(spend.rows).toEqual([
      expect.objectContaining({ kind: "render", video_id: video.id, status: "succeeded", note: "mock", cost_usd: 0 }),
    ]);
  });

  it("(b) MOCK_HEYGEN=false without the admin's confirm: refused before any HeyGen call, nothing claimed or reserved", async () => {
    const video = await queuedPostVideo();
    const fake = fakeFetch([json({ data: { video_id: "never" } })]);
    const client = liveClient(fake);
    expect(client.mock).toBe(false);

    await expect(renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store })).rejects.toThrow(
      "A real HeyGen render costs money. Tick “I agree to spend” first. Nothing was sent to HeyGen.",
    );
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store, confirmSpend: "yes" as unknown as boolean }),
    ).rejects.toThrow("Nothing was sent to HeyGen.");
    expect(fake.calls).toHaveLength(0);
    expect(spend.rows).toEqual([]);
    expect(mem.videos[0]).toMatchObject({ status: "queued", render_started_at: null, heygen_video_id: null });
  });

  it("(c) MOCK_HEYGEN=false with confirm: one POST /v3/videos to the FAKE fetch, through the spend guard", async () => {
    const video = await queuedPostVideo();
    const fake = fakeFetch([json({ data: { video_id: "hg_real_1" } })]);
    const result = await renderVideo(video.id, {
      videos: mem.store,
      heygen: liveClient(fake),
      spend: spend.store,
      confirmSpend: true,
      callbackUrl: "https://app.example.com/api/webhooks/heygen",
    });
    expect(result).toEqual({ status: "started", heygenVideoId: "hg_real_1" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe("https://api.heygen.com/v3/videos");
    const body = JSON.parse(String(fake.calls[0].init.body));
    expect(body).toMatchObject({
      script: "Doctor Aaysha says brush twice a day. Floss once. See you next week.",
      engine: { type: "avatar_v" },
      resolution: "1080p",
      aspect_ratio: "9:16",
      callback_id: video.id,
      callback_url: "https://app.example.com/api/webhooks/heygen",
    });
    expect(spend.rows).toEqual([expect.objectContaining({ kind: "render", status: "succeeded", note: null, video_id: video.id })]);
  });
});

describe("renderVideo: never twice, pause switches, caps", () => {
  it("heygen_video_id already saved: never POSTs again", async () => {
    const video = await queuedPostVideo();
    await mem.store.updateVideo(video.id, { heygen_video_id: "hg_saved", status: "rendering", render_started_at: "2026-11-22T00:00:00Z" });
    const fake = fakeFetch([]);
    const result = await renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true });
    expect(result).toEqual({ status: "already_started", heygenVideoId: "hg_saved" });
    expect(fake.calls).toHaveLength(0);
    expect(spend.rows).toEqual([]);
  });

  it("crash after the POST but before saving the id: the retry refuses (no second paid render) and says so", async () => {
    const video = await queuedPostVideo();
    const fake = fakeFetch([json({ data: { video_id: "hg_lost" } }), json({ data: { video_id: "hg_second" } })]);
    const client = liveClient(fake);
    const update = mem.store.updateVideo.bind(mem.store);
    const crashOnce = vi.spyOn(mem.store, "updateVideo").mockImplementation(async (id, patch) => {
      if (patch.heygen_video_id) throw new Error("database went away");
      return update(id, patch);
    });
    await expect(renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store, confirmSpend: true })).rejects.toThrow(
      "database went away",
    );
    crashOnce.mockRestore();

    // SF3: the retry treats it as "unknown": no second POST, the claim stays, webhook/poll finish it.
    await expect(renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store, confirmSpend: true })).resolves.toEqual({
      status: "unknown",
    });
    expect(fake.calls).toHaveLength(1);
    expect(mem.videos[0]).toMatchObject({ status: "rendering", heygen_video_id: null });
    expect(mem.videos[0].render_started_at).not.toBeNull();
  });

  it("10 renders at once: the 11th waits (stays queued, no POST, no spend row) and never errors the post", async () => {
    const video = await queuedPostVideo();
    for (let i = 0; i < RENDER.max_concurrent; i++) {
      const other = await mem.store.insertVideo({ brand_id: BRAND_ID, script_id: null, avatar_id: null, kind: "post", engine: "avatar_v", spoken_words: 10 });
      await mem.store.updateVideo(other.id, { status: "rendering" });
    }
    const fake = fakeFetch([]);
    const result = await renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true });
    expect(result).toEqual({ status: "waiting" });
    expect(fake.calls).toHaveLength(0);
    expect(spend.rows).toEqual([]);
    await expect(mem.store.getVideo(video.id)).resolves.toMatchObject({ status: "queued", render_started_at: null });
    expect(mem.posts[0]).toMatchObject({ status: "approved", status_reason: null });
  });

  it("429 with Retry-After: waits for it, then renders", async () => {
    const video = await queuedPostVideo();
    const sleep = vi.fn(async () => {});
    const fake = fakeFetch([json({}, 429, { "retry-after": "12" }), json({ data: { video_id: "hg_after_wait" } })]);
    const result = await renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake, sleep), spend: spend.store, confirmSpend: true });
    expect(result).toEqual({ status: "started", heygenVideoId: "hg_after_wait" });
    expect(sleep).toHaveBeenCalledWith(12_000);
  });

  it("429 above the Retry-After ceiling: claim freed, video back to queued with a plain error, post not errored", async () => {
    const video = await queuedPostVideo();
    const fake = fakeFetch([json({}, 429, { "retry-after": String(HEYGEN_RETRY_AFTER_MAX_S * 2) })]);
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(mem.videos[0]).toMatchObject({ status: "queued", render_started_at: null, heygen_video_id: null, error: "HeyGen is busy. Try again in 30 minutes." });
    expect(mem.posts[0].status).toBe("approved");
    expect(spend.rows).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("renders_paused: refused, nothing sent, claim freed, video queued with the reason", async () => {
    const video = await queuedPostVideo();
    spend = memorySpendStore({ rendersPaused: true });
    const fake = fakeFetch([]);
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true }),
    ).rejects.toThrow("renders_paused is on");
    expect(fake.calls).toHaveLength(0);
    expect(mem.videos[0]).toMatchObject({ status: "queued", render_started_at: null });
    expect(mem.videos[0].error).toContain("paused");
  });

  it("brands.paused: refused, nothing sent, no spend row", async () => {
    const video = await queuedPostVideo();
    spend = memorySpendStore({ pausedBrands: [BRAND_ID] });
    const fake = fakeFetch([]);
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true }),
    ).rejects.toThrow("This client is paused. Nothing was sent to HeyGen.");
    expect(fake.calls).toHaveLength(0);
    expect(spend.rows).toEqual([]);
    expect(mem.videos[0]).toMatchObject({ status: "queued", render_started_at: null });
  });

  it("daily render cap reached: refused before the POST", async () => {
    const video = await queuedPostVideo();
    spend = memorySpendStore({ caps: { render: 0 } });
    const fake = fakeFetch([]);
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true }),
    ).rejects.toThrow("Today's HeyGen limit for videos is reached");
    expect(fake.calls).toHaveLength(0);
  });

  it("HeyGen refuses (400): video failed with a plain error, claim freed (a fixed retry may run)", async () => {
    const video = await queuedPostVideo();
    const fake = fakeFetch([json({ error: { code: "invalid_parameter" } }, 400)]);
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true }),
    ).rejects.toThrow("HeyGen refused the request (invalid_parameter).");
    expect(mem.videos[0]).toMatchObject({ status: "failed", render_started_at: null, error: "HeyGen refused the request (invalid_parameter)." });
  });

  it("SF3: HeyGen 500 after the POST: NOT failed; unknown (rendering, claim kept, no id), post rendering, a retry never POSTs", async () => {
    const video = await queuedPostVideo();
    const fake = fakeFetch([json({}, 500)]);
    const client = liveClient(fake);
    await expect(renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store, confirmSpend: true })).resolves.toEqual({
      status: "unknown",
    });
    expect(mem.videos[0]).toMatchObject({ status: "rendering", heygen_video_id: null, error: RENDER_UNKNOWN });
    expect(mem.videos[0].render_started_at).not.toBeNull();
    expect(mem.posts[0]).toMatchObject({ status: "rendering", status_reason: null });
    await expect(renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store, confirmSpend: true })).resolves.toEqual({
      status: "unknown",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("SF3: a POST timeout: unknown state, claim kept, and no second POST on retry", async () => {
    const video = await queuedPostVideo();
    const timeout = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const fake = fakeFetch([timeout, json({ data: { video_id: "hg_second_paid" } })]);
    const client = liveClient(fake);
    const deps = { videos: mem.store, heygen: client, spend: spend.store, confirmSpend: true };
    expect(await renderVideo(video.id, deps)).toEqual({ status: "unknown" });
    expect(mem.videos[0]).toMatchObject({ status: "rendering", heygen_video_id: null, error: RENDER_UNKNOWN });
    expect(await renderVideo(video.id, deps)).toEqual({ status: "unknown" });
    expect(await renderVideo(video.id, deps)).toEqual({ status: "unknown" });
    expect(fake.calls).toHaveLength(1);
    expect(spend.rows).toHaveLength(1);
  });

  it("a claim without an id on a video that is no longer rendering (after the window): refuses with 'check HeyGen'", async () => {
    const video = await queuedPostVideo();
    await mem.store.updateVideo(video.id, { status: "failed", render_started_at: "2026-11-22T00:00:00Z" });
    const fake = fakeFetch([]);
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true }),
    ).rejects.toThrow(LOST_RENDER);
    expect(fake.calls).toHaveLength(0);
  });

  it("the twin's HeyGen consent is not accepted: refused before any HeyGen call", async () => {
    await mem.seedReadyTwin({ heygenConsent: "pending" });
    mem.seedApprovedPost();
    const video = await createPostRender(POST_ID, { videos: mem.store });
    const fake = fakeFetch([]);
    await expect(
      renderVideo(video.id, { videos: mem.store, heygen: liveClient(fake), spend: spend.store, confirmSpend: true }),
    ).rejects.toThrow("HeyGen's own consent for this twin is not accepted yet. Nothing was sent to HeyGen.");
    expect(fake.calls).toHaveLength(0);
    expect(spend.rows).toEqual([]);
  });

  it("the twin no longer supports the video's engine: refused, never a different engine", async () => {
    const video = await queuedPostVideo();
    await mem.consentMem.store.updateAvatar(video.avatar_id!, { supported_engines: ["avatar_iv"] });
    const client = createHeygenClient({ apiKey: "dummy" });
    const create = vi.spyOn(client, "createVideo");
    await expect(renderVideo(video.id, { videos: mem.store, heygen: client, spend: spend.store })).rejects.toThrow(
      "The twin does not support the chosen engine (avatar_v). Run the likeness test again.",
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("heygenCallbackUrl", () => {
  it("only with a public https NEXT_PUBLIC_SITE_URL", () => {
    expect(heygenCallbackUrl({ NEXT_PUBLIC_SITE_URL: "https://app.example.com/" })).toBe("https://app.example.com/api/webhooks/heygen");
    expect(heygenCallbackUrl({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })).toBeNull();
    expect(heygenCallbackUrl({})).toBeNull();
    expect(heygenCallbackUrl({ NEXT_PUBLIC_SITE_URL: "not a url" })).toBeNull();
  });
});
