import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEYGEN_DOWNLOAD_HOSTS,
  HEYGEN_RETRY_AFTER_MAX_S,
  HEYGEN_VIDEO_RESOLUTION,
  MOCK_FIXTURE_VIDEO,
  createHeygenClient,
  heygen,
} from "@/lib/heygen";
import { RENDER } from "@/lib/qa/config";

// Phase 3 part B step 2: POST /v3/videos, the video download and
// POST /v3/webhooks/endpoints. Mock mode never fetches; with mock off the
// requests go to an injected FAKE fetch only (tests/setup/no-network.ts
// makes globalThis.fetch a thrower anyway).

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const VIDEO_ID = "90000000-0000-4000-8000-000000000001";
const input = {
  lookId: "look_1",
  spokenText: "Assalam o alaikum. Aaj hum baat karein ge.",
  voiceId: "voice_1",
  engine: "avatar_v",
  callbackId: VIDEO_ID,
};

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: (() => Response)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no more fake answers");
    return next();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A FAKE resolver: HeyGen's file host resolves to a public address. Never real DNS in tests. */
const publicDns = () =>
  vi.fn(async (host: string) => {
    void host;
    return [{ address: "93.184.216.34", family: 4 }];
  });
const realClient = (fakeFetchFn: typeof globalThis.fetch, sleep = vi.fn(async () => {}), resolve = publicDns()) =>
  createHeygenClient({ mock: false, apiKey: "test-key-not-real", fetch: fakeFetchFn, sleep, resolve, downloadTransport: fakeFetchFn });
const mp4 = (bytes: number[]) => () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "video/mp4" } });

describe("mock mode: renders, downloads and webhook setup never fetch", () => {
  it("createVideo gives a mock id per video, downloadVideo gives the fixture bytes, webhook setup a mock endpoint", async () => {
    delete process.env.MOCK_HEYGEN;
    process.env.HEYGEN_API_KEY = "dummy-key-for-test";
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    const client = heygen();
    expect(client.mock).toBe(true);

    expect(await client.createVideo(input)).toEqual({ videoId: `video_mock_${VIDEO_ID}` });
    const bytes = await client.downloadVideo("https://files.example.invalid/video.mp4");
    expect(Buffer.from(bytes).equals(readFileSync(MOCK_FIXTURE_VIDEO))).toBe(true);
    expect(
      await client.createWebhookEndpoint({ url: "https://example.invalid/api/webhooks/heygen", events: ["avatar_video.success"] }),
    ).toEqual({ endpointId: "endpoint_mock_0001", secret: "mock-webhook-secret-not-real" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("POST /v3/videos (mock off, fake fetch)", () => {
  it("sends our spoken_text as `script`, the look, voice, engine object, 1080p, 9:16 and callback_id", async () => {
    const fake = fakeFetch([json({ data: { video_id: "hg_video_1" } })]);
    const result = await realClient(fake.fetch).createVideo({ ...input, title: "Post 1" });

    expect(result).toEqual({ videoId: "hg_video_1" });
    expect(fake.calls).toHaveLength(1);
    const [{ url, init }] = fake.calls;
    expect(url).toBe("https://api.heygen.com/v3/videos");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("test-key-not-real");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "avatar",
      avatar_id: "look_1",
      script: "Assalam o alaikum. Aaj hum baat karein ge.",
      voice_id: "voice_1",
      engine: { type: "avatar_v" },
      resolution: HEYGEN_VIDEO_RESOLUTION,
      aspect_ratio: "9:16",
      callback_id: VIDEO_ID,
      title: "Post 1",
    });
    expect(HEYGEN_VIDEO_RESOLUTION).toBe("1080p");
  });

  it("adds callback_url only when one is given", async () => {
    const fake = fakeFetch([json({ data: { video_id: "hg_video_2" } })]);
    await realClient(fake.fetch).createVideo({ ...input, callbackUrl: "https://app.example.com/api/webhooks/heygen" });
    expect(JSON.parse(String(fake.calls[0].init.body)).callback_url).toBe("https://app.example.com/api/webhooks/heygen");
  });

  it("refuses to send without spoken text, look, voice or engine (nothing fetched)", async () => {
    const fake = fakeFetch([]);
    const client = realClient(fake.fetch);
    await expect(client.createVideo({ ...input, spokenText: "  " })).rejects.toThrow("There is no text to say.");
    await expect(client.createVideo({ ...input, engine: "" })).rejects.toThrow("No engine chosen");
    await expect(client.createVideo({ ...input, voiceId: "" })).rejects.toThrow("no voice");
    expect(fake.calls).toHaveLength(0);
  });

  it("429 with Retry-After: waits exactly that long, then sends again", async () => {
    const sleep = vi.fn(async () => {});
    const fake = fakeFetch([json({ error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "7" }), json({ data: { video_id: "hg_3" } })]);
    expect(await realClient(fake.fetch, sleep).createVideo(input)).toEqual({ videoId: "hg_3" });
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(fake.calls).toHaveLength(2);
  });

  it("429 with a Retry-After above the ceiling: plain 'try again in N minutes', no second POST", async () => {
    const fake = fakeFetch([json({}, 429, { "retry-after": String(HEYGEN_RETRY_AFTER_MAX_S + 60) })]);
    await expect(realClient(fake.fetch).createVideo(input)).rejects.toMatchObject({ code: "busy", message: "HeyGen is busy. Try again in 16 minutes." });
    expect(fake.calls).toHaveLength(1);
  });

  it("a 500 is NOT retried (the render may have started)", async () => {
    const fake = fakeFetch([json({ error: { code: "internal_error" } }, 500), json({ data: { video_id: "never" } })]);
    await expect(realClient(fake.fetch).createVideo(input)).rejects.toMatchObject({ code: "failed" });
    expect(fake.calls).toHaveLength(1);
  });

  it("an engine the look doesn't support comes back as a plain bad_request (invalid_parameter)", async () => {
    const fake = fakeFetch([json({ error: { code: "invalid_parameter", message: "engine" } }, 400)]);
    await expect(realClient(fake.fetch).createVideo(input)).rejects.toMatchObject({
      code: "bad_request",
      message: "HeyGen refused the request (invalid_parameter).",
    });
  });

  it("reads the id from data.video_id, and from data.id or a bare video_id (docs disagree)", async () => {
    for (const body of [{ data: { id: "hg_a" } }, { video_id: "hg_a" }]) {
      const fake = fakeFetch([json(body)]);
      expect(await realClient(fake.fetch).createVideo(input)).toEqual({ videoId: "hg_a" });
    }
    const bad = fakeFetch([json({ data: {} })]);
    await expect(realClient(bad.fetch).createVideo(input)).rejects.toMatchObject({ code: "bad_output" });
  });
});

describe("downloadVideo (mock off, fake fetch): the safe downloader (QA MUST FIX 1)", () => {
  it("the allowlist is HeyGen's documented file host only; limits live in lib/qa/config.ts RENDER", () => {
    expect(HEYGEN_DOWNLOAD_HOSTS).toEqual(["resource2.heygen.ai"]);
    expect(RENDER.download_max_bytes).toBe(200 * 1024 * 1024);
    expect(RENDER.download_max_redirects).toBe(3);
    expect(RENDER.download_timeout_s).toBe(300);
  });

  it("downloads from the allowed host over https: no API key, redirect manual, DNS checked with the injected resolver", async () => {
    const fake = fakeFetch([mp4([1, 2, 3, 4])]);
    const resolve = publicDns();
    const bytes = await realClient(fake.fetch, undefined, resolve).downloadVideo("https://resource2.heygen.ai/videos/abc/VIDEO.mp4?sig=1");
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(fake.calls[0].url).toBe("https://resource2.heygen.ai/videos/abc/VIDEO.mp4?sig=1");
    expect(fake.calls[0].init.redirect).toBe("manual");
    expect(JSON.stringify(fake.calls[0].init.headers ?? {})).not.toContain("test-key-not-real");
    expect(resolve).toHaveBeenCalledWith("resource2.heygen.ai");
  });

  it("refuses non-https, off-allowlist hosts, look-alikes and metadata IPs with one plain message (nothing fetched, no DNS)", async () => {
    const fake = fakeFetch([]);
    const resolve = publicDns();
    const client = realClient(fake.fetch, undefined, resolve);
    for (const url of [
      "http://resource2.heygen.ai/a.mp4",
      "file:///etc/passwd",
      "not a url",
      "",
      "https://files.heygen.ai/v/abc.mp4",
      "https://evil-heygen.com/a.mp4",
      "https://resource2.heygen.ai.evil.com/a.mp4",
      "https://resource2.heygen.ai@evil.com/a.mp4",
      "https://169.254.169.254/latest/meta-data/",
    ]) {
      const error = await client.downloadVideo(url).catch((e: Error) => e);
      expect(error, url).toMatchObject({ code: "bad_output", message: "The video link from HeyGen is not usable." });
      expect(String((error as Error & { cause?: Error }).cause?.message)).not.toContain("://");
    }
    expect(fake.calls).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private address (nothing fetched)", async () => {
    const fake = fakeFetch([mp4([1])]);
    const resolve = vi.fn(async () => [{ address: "10.0.0.7", family: 4 }]);
    await expect(realClient(fake.fetch, undefined, resolve).downloadVideo("https://resource2.heygen.ai/a.mp4")).rejects.toThrow(
      "The video link from HeyGen is not usable.",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an answer that is not a video (no retry)", async () => {
    const fake = fakeFetch([() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })]);
    await expect(realClient(fake.fetch).downloadVideo("https://resource2.heygen.ai/a.mp4")).rejects.toThrow(
      "The video link from HeyGen is not usable.",
    );
    expect(fake.calls).toHaveLength(1);
  });

  it("without an injected downloadTransport, downloads never use the general fetch (default = pinned node:https)", async () => {
    const fake = fakeFetch([mp4([1])]);
    const sleep = vi.fn(async () => {});
    const client = createHeygenClient({ mock: false, apiKey: "test-key-not-real", fetch: fake.fetch, sleep, resolve: publicDns() });
    // node:https is blocked by the test guard, so the pinned transport fails as a network error.
    await expect(client.downloadVideo("https://resource2.heygen.ai/a.mp4")).rejects.toThrow(
      "Could not download the video from HeyGen. Try again later.",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("retries a failed download (5xx) with backoff, then gives a plain error", async () => {
    const sleep = vi.fn(async () => {});
    const fake = fakeFetch([json({}, 503), json({}, 503), json({}, 503)]);
    await expect(realClient(fake.fetch, sleep).downloadVideo("https://resource2.heygen.ai/a.mp4")).rejects.toThrow(
      "Could not download the video from HeyGen. Try again later.",
    );
    expect(fake.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("POST /v3/webhooks/endpoints (mock off, fake fetch)", () => {
  it("sends url and events, returns the endpoint id and the one-time secret", async () => {
    const fake = fakeFetch([json({ data: { endpoint_id: "ep_1", secret: "shown-once" } })]);
    const result = await realClient(fake.fetch).createWebhookEndpoint({
      url: "https://app.example.com/api/webhooks/heygen",
      events: ["avatar_video.success", "avatar_video.fail"],
    });
    expect(result).toEqual({ endpointId: "ep_1", secret: "shown-once" });
    expect(fake.calls[0].url).toBe("https://api.heygen.com/v3/webhooks/endpoints");
    expect(fake.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0].init.body))).toEqual({
      url: "https://app.example.com/api/webhooks/heygen",
      events: ["avatar_video.success", "avatar_video.fail"],
    });
  });
});
