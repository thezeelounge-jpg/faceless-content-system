import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_FIXTURE_VIDEO, createHeygenClient } from "@/lib/heygen";
import { handleHeygenWebhook } from "@/lib/heygen-webhook";
import { RENDER } from "@/lib/qa/config";
import {
  UNKNOWN_TIMEOUT,
  completeRender,
  createPostRender,
  pollRenderOnce,
  pollRenderUntilDone,
  renderVideo,
  rollingWordsPerSecond,
} from "@/lib/render";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";
import { POST_ID, memoryVideoFiles, memoryVideoStore } from "@/tests/helpers/video-memory";

// Items 7 and 8: finishing a render (from the webhook or the polling backup):
// download the MP4 at once into the PRIVATE bucket, save duration and status,
// update brands.words_per_second; on failure save a plain reason. Never twice.

const FIXTURE = new Uint8Array(readFileSync(MOCK_FIXTURE_VIDEO));
let mem: ReturnType<typeof memoryVideoStore>;
let files: ReturnType<typeof memoryVideoFiles>;
const download = vi.fn(async (url: string | null) => {
  void url;
  return FIXTURE;
});

beforeEach(() => {
  mem = memoryVideoStore();
  files = memoryVideoFiles();
  download.mockClear();
  delete process.env.MOCK_HEYGEN;
});
afterEach(() => vi.restoreAllMocks());

const mockClient = () => createHeygenClient({ apiKey: "dummy" });

async function renderingVideo() {
  await mem.seedReadyTwin();
  mem.seedApprovedPost();
  const video = await createPostRender(POST_ID, { videos: mem.store });
  await renderVideo(video.id, { videos: mem.store, heygen: mockClient(), spend: memorySpendStore().store });
  return (await mem.store.getVideo(video.id))!;
}

/** SF3: a real-mode POST that timed out (FAKE fetch): the video is left in the unknown state. */
async function unknownVideo() {
  await mem.seedReadyTwin();
  mem.seedApprovedPost();
  const video = await createPostRender(POST_ID, { videos: mem.store });
  const fakeFetch = vi.fn(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const live = createHeygenClient({ mock: false, apiKey: "test-key-not-real", fetch: fakeFetch as unknown as typeof fetch });
  // Throws or answers "unknown" depending on the code under test; the state is what matters.
  await renderVideo(video.id, { videos: mem.store, heygen: live, spend: memorySpendStore().store, confirmSpend: true }).catch(() => null);
  expect(fakeFetch).toHaveBeenCalledTimes(1);
  return (await mem.store.getVideo(video.id))!;
}

const SECRET = "test-webhook-secret-not-real";
function signedSuccess(videoId: string, heygenId: string) {
  const rawBody = JSON.stringify({
    event_type: "avatar_video.success",
    event_data: { video_id: heygenId, url: null, callback_id: videoId },
  });
  return { rawBody, signature: createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex"), secret: SECRET };
}

describe("SF3 + SF5: a render whose POST answer was lost", () => {
  it("SF3: the webhook for that callback_id saves HeyGen's id and completes it (downloaded, rendered)", async () => {
    const video = await unknownVideo();
    const result = await handleHeygenWebhook(signedSuccess(video.id, "hg_late_1"), {
      videos: mem.store,
      heygen: mockClient(),
      files: files.storage,
      download,
    });
    expect(result.status).toBe(200);
    expect(mem.videos[0]).toMatchObject({ status: "rendered", heygen_video_id: "hg_late_1", raw_path: `raw/${BRAND_ID}/${video.id}.mp4`, error: null });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("SF3: the poll completes it once HeyGen's id is known", async () => {
    const video = await unknownVideo();
    await mem.store.updateVideo(video.id, { heygen_video_id: "hg_late_2" });
    const result = await pollRenderOnce(video.id, { videos: mem.store, heygen: mockClient(), files: files.storage, download });
    expect(result).toEqual({ done: true, status: "rendered" });
    expect(mem.videos[0].status).toBe("rendered");
  });

  it("SF5: before the 30-minute window the poll keeps waiting (still unknown, post untouched)", async () => {
    const video = await unknownVideo();
    const started = Date.parse(video.render_started_at!);
    const now = () => new Date(started + (RENDER.poll_max_s - 1) * 1000);
    const result = await pollRenderOnce(video.id, { videos: mem.store, heygen: mockClient(), files: files.storage, download, now });
    expect(result).toEqual({ done: false, status: "unknown" });
    expect(mem.videos[0]).toMatchObject({ status: "rendering", heygen_video_id: null });
    expect(mem.posts[0].status).toBe("rendering");
    expect(download).not.toHaveBeenCalled();
  });

  it("SF5: once the window has passed with no word: video failed (claim kept), post → team_review with the plain team reason", async () => {
    const video = await unknownVideo();
    const started = Date.parse(video.render_started_at!);
    const now = () => new Date(started + RENDER.poll_max_s * 1000);
    const result = await pollRenderOnce(video.id, { videos: mem.store, heygen: mockClient(), files: files.storage, download, now });
    expect(result).toEqual({ done: true, status: "failed" });
    expect(mem.videos[0]).toMatchObject({ status: "failed", heygen_video_id: null, error: UNKNOWN_TIMEOUT });
    expect(mem.videos[0].render_started_at).not.toBeNull();
    expect(mem.posts[0]).toMatchObject({ status: "team_review", status_reason: "The video could not be made. The team will look at it." });
  });
});

describe("rollingWordsPerSecond", () => {
  it("averages words/duration over the newest 10 samples, rounded to 2 decimals", () => {
    const samples = [
      ...Array.from({ length: 10 }, () => ({ words: 30, durationS: 10 })), // 3.0 each
      { words: 10, durationS: 10 }, // 11th, older: ignored
    ];
    expect(rollingWordsPerSecond(samples)).toBe(3);
    expect(rollingWordsPerSecond([{ words: 25, durationS: 10 }, { words: 20, durationS: 10 }])).toBe(2.25);
    expect(rollingWordsPerSecond([{ words: 10, durationS: 3 }])).toBe(3.33);
  });

  it("ignores zero, tiny or huge durations and absurd speeds; null when nothing is left", () => {
    expect(
      rollingWordsPerSecond([
        { words: 30, durationS: 0 },
        { words: 30, durationS: 1 },
        { words: 30, durationS: 4000 },
        { words: 0, durationS: 20 },
        { words: 300, durationS: 10 }, // 30 words a second
        { words: 24, durationS: 10 },
      ]),
    ).toBe(2.4);
    expect(rollingWordsPerSecond([{ words: 30, durationS: Number.NaN }])).toBeNull();
    expect(rollingWordsPerSecond([])).toBeNull();
  });

  it("absurd samples do not use up the window of 10", () => {
    const bad = Array.from({ length: 12 }, () => ({ words: 30, durationS: 0 }));
    expect(rollingWordsPerSecond([...bad, { words: 20, durationS: 10 }])).toBe(2);
  });
});

describe("completeRender: success", () => {
  it("downloads at once into the private bucket, saves path, duration and status rendered", async () => {
    const video = await renderingVideo();
    const result = await completeRender(video.id, { ok: true, videoUrl: "https://files.heygen.ai/x.mp4", durationS: 5.2 }, {
      videos: mem.store,
      heygen: mockClient(),
      files: files.storage,
      download,
    });
    expect(result).toEqual({ status: "rendered" });
    expect(download).toHaveBeenCalledWith("https://files.heygen.ai/x.mp4");
    const rawPath = `raw/${BRAND_ID}/${video.id}.mp4`;
    expect(files.files[rawPath]).toEqual({ bytes: FIXTURE, contentType: "video/mp4" });
    expect(mem.videos[0]).toMatchObject({ status: "rendered", raw_path: rawPath, duration_s: 5.2, error: null });
    expect(mem.videos[0].rendered_at).not.toBeNull();
  });

  it("updates brands.words_per_second from the real duration (13 words in 5.2 s = 2.5)", async () => {
    const video = await renderingVideo();
    await completeRender(video.id, { ok: true, videoUrl: null, durationS: 5.2 }, { videos: mem.store, heygen: mockClient(), files: files.storage, download });
    expect(mem.brand(BRAND_ID)!.words_per_second).toBe(2.5);
  });

  it("likeness-test videos are excluded from words_per_second", async () => {
    const video = await renderingVideo();
    const test = await mem.store.insertVideo({ brand_id: BRAND_ID, script_id: null, avatar_id: video.avatar_id, kind: "likeness_test", engine: "avatar_v", spoken_words: 40 });
    await mem.store.updateVideo(test.id, { status: "rendering", heygen_video_id: "hg_t" });
    await completeRender(test.id, { ok: true, videoUrl: null, durationS: 10 }, { videos: mem.store, heygen: mockClient(), files: files.storage, download });
    expect(mem.brand(BRAND_ID)!.words_per_second).toBe(2.4); // unchanged default
    await completeRender(video.id, { ok: true, videoUrl: null, durationS: 6.5 }, { videos: mem.store, heygen: mockClient(), files: files.storage, download });
    expect(mem.brand(BRAND_ID)!.words_per_second).toBe(2);
  });

  it("a second completion (webhook twice, or webhook + poll) does nothing: one download, same row", async () => {
    const video = await renderingVideo();
    const deps = { videos: mem.store, heygen: mockClient(), files: files.storage, download };
    await completeRender(video.id, { ok: true, videoUrl: null, durationS: 5.2 }, deps);
    const again = await completeRender(video.id, { ok: true, videoUrl: null, durationS: 99 }, deps);
    expect(again).toEqual({ status: "already_done" });
    expect(download).toHaveBeenCalledTimes(1);
    expect(mem.videos[0].duration_s).toBe(5.2);
  });

  it("a failed download saves a plain error and leaves the video rendering (the poll tries again)", async () => {
    const video = await renderingVideo();
    const broken = vi.fn(async () => {
      throw new Error("socket hang up key=sk-ant-abcdefghijklmnop");
    });
    await expect(
      completeRender(video.id, { ok: true, videoUrl: null, durationS: 5 }, { videos: mem.store, heygen: mockClient(), files: files.storage, download: broken }),
    ).rejects.toThrow();
    expect(mem.videos[0]).toMatchObject({ status: "rendering", error: "Could not save the finished video. It will be tried again." });
  });

  it("without an injected downloader, mock HeyGen hands out the fixture (no fetch)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const video = await renderingVideo();
    await completeRender(video.id, { ok: true, videoUrl: null, durationS: 16 }, { videos: mem.store, heygen: mockClient(), files: files.storage });
    expect(files.files[`raw/${BRAND_ID}/${video.id}.mp4`].bytes).toEqual(FIXTURE);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("completeRender: failure", () => {
  it("saves a plain, redacted reason; the post goes to the team queue", async () => {
    const video = await renderingVideo();
    const result = await completeRender(
      video.id,
      { ok: false, reason: "Avatar render failed token=abcdefghijklmnopqrstuvwxyz0123456789" },
      { videos: mem.store, heygen: mockClient(), files: files.storage, download },
    );
    expect(result).toEqual({ status: "failed" });
    expect(mem.videos[0].status).toBe("failed");
    expect(mem.videos[0].error).toBe("HeyGen could not make the video: Avatar render failed token=[redacted]");
    expect(mem.posts[0]).toMatchObject({ status: "team_review", status_reason: "The video could not be made. The team will look at it." });
    expect(download).not.toHaveBeenCalled();
  });

  it("no reason from HeyGen: a plain default", async () => {
    const video = await renderingVideo();
    await completeRender(video.id, { ok: false, reason: null }, { videos: mem.store, heygen: mockClient(), files: files.storage, download });
    expect(mem.videos[0].error).toBe("HeyGen could not make the video (no reason given).");
  });
});

describe("polling backup", () => {
  it("mock mode: one check finishes the video from the fixture (no fetch)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const video = await renderingVideo();
    const result = await pollRenderOnce(video.id, { videos: mem.store, heygen: mockClient(), files: files.storage });
    expect(result).toEqual({ done: true, status: "rendered" });
    expect(mem.videos[0]).toMatchObject({ status: "rendered", duration_s: 16 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not double-process a video the webhook already finished (no HeyGen call, no download)", async () => {
    const video = await renderingVideo();
    await completeRender(video.id, { ok: true, videoUrl: null, durationS: 5.2 }, { videos: mem.store, heygen: mockClient(), files: files.storage, download });
    const client = mockClient();
    const get = vi.spyOn(client, "getVideo");
    download.mockClear();
    const result = await pollRenderOnce(video.id, { videos: mem.store, heygen: client, files: files.storage, download });
    expect(result).toEqual({ done: true, status: "rendered" });
    expect(get).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("HeyGen says failed: saves the reason", async () => {
    const video = await renderingVideo();
    const client = mockClient();
    vi.spyOn(client, "getVideo").mockResolvedValue({
      videoId: video.heygen_video_id!,
      status: "failed",
      videoUrl: null,
      durationS: null,
      failureMessage: "moderation_rejected",
      fixturePath: null,
    });
    expect(await pollRenderOnce(video.id, { videos: mem.store, heygen: client, files: files.storage, download })).toEqual({ done: true, status: "failed" });
    expect(mem.videos[0].error).toBe("HeyGen could not make the video: moderation_rejected");
  });

  it("checks every 30 s, at most 30 minutes, then marks the video failed with a plain reason", async () => {
    const video = await renderingVideo();
    const client = mockClient();
    const get = vi.spyOn(client, "getVideo").mockResolvedValue({
      videoId: video.heygen_video_id!,
      status: "processing",
      videoUrl: null,
      durationS: null,
      failureMessage: null,
      fixturePath: null,
    });
    const wait = vi.fn(async () => {});
    const result = await pollRenderUntilDone(video.id, { videos: mem.store, heygen: client, files: files.storage, download, wait });
    const attempts = RENDER.poll_max_s / RENDER.poll_every_s;
    expect(attempts).toBe(60);
    expect(get).toHaveBeenCalledTimes(attempts);
    expect(wait).toHaveBeenCalledTimes(attempts - 1);
    expect(wait).toHaveBeenCalledWith(30);
    expect(result).toEqual({ done: true, status: "failed" });
    expect(mem.videos[0]).toMatchObject({
      status: "failed",
      error: "HeyGen did not finish within 30 minutes. Check the HeyGen dashboard before rendering again.",
    });
  });

  it("stops as soon as the webhook finished the video meanwhile", async () => {
    const video = await renderingVideo();
    const client = mockClient();
    vi.spyOn(client, "getVideo").mockImplementation(async () => {
      // The webhook lands while we wait.
      await completeRender(video.id, { ok: true, videoUrl: null, durationS: 5.2 }, { videos: mem.store, heygen: mockClient(), files: files.storage, download });
      return { videoId: "x", status: "processing", videoUrl: null, durationS: null, failureMessage: null, fixturePath: null };
    });
    const wait = vi.fn(async () => {});
    const result = await pollRenderUntilDone(video.id, { videos: mem.store, heygen: client, files: files.storage, download, wait });
    expect(result).toEqual({ done: true, status: "rendered" });
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
