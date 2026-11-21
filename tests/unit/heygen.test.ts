import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEYGEN_PAGE_MAX_WAIT_S,
  HEYGEN_RETRY_AFTER_MAX_S,
  HEYGEN_VIDEO_RESOLUTION,
  HeygenError,
  MOCK_FIXTURE_VIDEO,
  createHeygenClient,
  heygen,
} from "@/lib/heygen";

// HeyGen costs money. These tests prove two things:
// 1. in mock mode (the default) no helper ever calls fetch, even with a key set;
// 2. with MOCK_HEYGEN=false the requests have the documented shape.

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

/** Runs every helper once. */
async function callEveryHelper(client: ReturnType<typeof createHeygenClient>) {
  return {
    me: await client.getCurrentUser(),
    asset: await client.uploadAsset({ bytes: new Uint8Array([1, 2, 3]), filename: "clip.mp4", contentType: "video/mp4" }),
    twin: await client.createDigitalTwin({ name: "Brand twin", file: { type: "asset_id", asset_id: "asset_1" } }),
    consent: await client.startConsent("group_1"),
    group: await client.getAvatarGroup("group_1"),
    looks: await client.listLooks("group_1"),
    look: await client.getLook("look_1"),
    video: await client.getVideo("video_1"),
  };
}

describe("mock mode never calls HeyGen", () => {
  for (const value of [undefined, "true", "TRUE", "False", "0", "no", ""]) {
    it(`MOCK_HEYGEN=${JSON.stringify(value)}: zero fetches from every helper, even with a dummy key`, async () => {
      if (value === undefined) delete process.env.MOCK_HEYGEN;
      else process.env.MOCK_HEYGEN = value;
      process.env.HEYGEN_API_KEY = "dummy-key-for-test";
      const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));

      const results = await callEveryHelper(heygen());

      expect(spy).not.toHaveBeenCalled();
      expect(results.me).toEqual({ mock: true, billingType: "wallet", username: "mock-heygen-user" });
      expect(results.asset).toBe("asset_mock_0001");
      expect(results.twin).toMatchObject({ groupId: "group_mock_0001", lookId: "look_mock_0001", voiceId: "voice_mock_0001" });
      expect(results.consent).toEqual({
        consentStatus: "pending",
        consentUrl: "https://consent.example.invalid/mock/group_mock_0001",
      });
      expect(results.group).toEqual({
        groupId: "group_mock_0001",
        status: "completed",
        consentStatus: "accepted",
        voiceId: "voice_mock_0001",
      });
      expect(results.looks).toEqual([
        {
          lookId: "look_mock_0001",
          groupId: "group_mock_0001",
          status: "completed",
          supportedEngines: ["avatar_iv", "avatar_v"],
          voiceId: "voice_mock_0001",
        },
      ]);
      expect(results.video).toMatchObject({ status: "completed", fixturePath: MOCK_FIXTURE_VIDEO });
    });
  }

  it("even an injected fetch is never used in mock mode", async () => {
    const fake = vi.fn();
    await callEveryHelper(createHeygenClient({ mock: true, apiKey: "dummy", fetch: fake }));
    expect(fake).not.toHaveBeenCalled();
  });

  it("the fixture video is a real file in tests/fixtures", async () => {
    const { existsSync } = await import("node:fs");
    expect(MOCK_FIXTURE_VIDEO).toMatch(/^tests\/fixtures\/.+\.mp4$/);
    expect(existsSync(MOCK_FIXTURE_VIDEO)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real path (MOCK_HEYGEN=false) with a fake fetch
// ---------------------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; signal: unknown };

function fakeFetch(responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === "string") body = JSON.parse(raw);
    calls.push({ url: String(url), method: init?.method ?? "GET", headers, body, signal: init?.signal });
    const next = responses.shift() ?? { status: 500, json: {} };
    return new Response(next.json === undefined ? null : JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...next.headers },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const sleep = vi.fn(async () => {});
const real = (fetchFn: typeof fetch, apiKey: string | null = "test-key") =>
  createHeygenClient({ mock: false, apiKey: apiKey ?? undefined, fetch: fetchFn, sleep });

beforeEach(() => sleep.mockClear());

describe("real requests (MOCK_HEYGEN=false) have the documented shape", () => {
  it("GET /v3/users/me with the X-Api-Key header and a timeout signal", async () => {
    const { fn, calls } = fakeFetch([{ json: { data: { username: "zee", billing_type: "wallet" } } }]);
    expect(await real(fn).getCurrentUser()).toEqual({ mock: false, billingType: "wallet", username: "zee" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.heygen.com/v3/users/me");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers["x-api-key"]).toBe("test-key");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("POST /v3/avatars creates a digital twin from a file", async () => {
    const { default: fixture } = await import("@/tests/fixtures/heygen/create-avatar.json");
    const { fn, calls } = fakeFetch([{ json: fixture }]);
    const twin = await real(fn).createDigitalTwin({ name: "Brand twin", file: { type: "url", url: "https://files.example/clip.mp4" } });
    expect(calls[0].url).toBe("https://api.heygen.com/v3/avatars");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].body).toEqual({
      type: "digital_twin",
      name: "Brand twin",
      file: { type: "url", url: "https://files.example/clip.mp4" },
    });
    expect(twin).toEqual({
      groupId: "group_mock_0001",
      lookId: "look_mock_0001",
      voiceId: "voice_mock_0001",
      lookStatus: "processing",
      groupStatus: "pending_consent",
      consentStatus: "pending",
    });
  });

  it("POST /v3/avatars/{group_id}/consent starts the consent flow", async () => {
    const { fn, calls } = fakeFetch([
      { json: { data: { avatar_group: { id: "g 1", consent_status: "pending", url: "https://heygen.example/c" } } } },
    ]);
    expect(await real(fn).startConsent("g 1")).toEqual({ consentStatus: "pending", consentUrl: "https://heygen.example/c" });
    expect(calls[0].url).toBe("https://api.heygen.com/v3/avatars/g%201/consent");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({});
  });

  it("GET group, looks by group_id, one look and one video", async () => {
    const { fn, calls } = fakeFetch([
      { json: { data: { id: "g1", status: "pending_consent", consent_status: "pending", default_voice_id: null } } },
      { json: { data: [], has_more: false, next_token: null } },
      { json: { data: { id: "l1", group_id: "g1", status: "failed", supported_api_engines: [], default_voice_id: null } } },
      { json: { data: { id: "v1", status: "completed", video_url: "https://cdn.example/v.mp4", duration: 15.2 } } },
    ]);
    const client = real(fn);
    expect(await client.getAvatarGroup("g1")).toEqual({
      groupId: "g1",
      status: "pending_consent",
      consentStatus: "pending",
      voiceId: null,
    });
    expect(await client.listLooks("g1")).toEqual([]);
    expect(await client.getLook("l1")).toEqual({
      lookId: "l1",
      groupId: "g1",
      status: "failed",
      supportedEngines: [],
      voiceId: null,
    });
    expect(await client.getVideo("v1")).toEqual({
      videoId: "v1",
      status: "completed",
      videoUrl: "https://cdn.example/v.mp4",
      durationS: 15.2,
      failureMessage: null,
      fixturePath: null,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.heygen.com/v3/avatars/g1",
      "GET https://api.heygen.com/v3/avatars/looks?group_id=g1",
      "GET https://api.heygen.com/v3/avatars/looks/l1",
      "GET https://api.heygen.com/v3/videos/v1",
    ]);
  });

  it("direct upload: create, PUT the bytes (no API key to the storage host), complete", async () => {
    const { fn, calls } = fakeFetch([
      {
        json: {
          data: { asset_id: "a1", upload_url: "https://upload.example/put-here", upload_headers: { "Content-Type": "video/mp4" } },
        },
      },
      { status: 200 },
      { json: { data: { asset_id: "a1" } } },
    ]);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(await real(fn).uploadAsset({ bytes, filename: "clip.mp4", contentType: "video/mp4" })).toBe("a1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.heygen.com/v3/assets/direct-uploads",
      "PUT https://upload.example/put-here",
      "POST https://api.heygen.com/v3/assets/a1/complete",
    ]);
    expect(calls[0].body).toEqual({ filename: "clip.mp4", content_type: "video/mp4", size_bytes: 4, checksum_sha256: sha });
    expect(calls[1].headers["x-api-key"]).toBeUndefined();
    expect(calls[1].headers["content-type"]).toBe("video/mp4");
    expect(calls[2].body).toEqual({ checksum_sha256: sha });
  });
});

describe("decision 3: tolerant voice parsing (voice_id OR default_voice_id)", () => {
  const twinAnswer = (voice: Record<string, string>) => ({
    data: {
      avatar_item: { id: "look_1", group_id: "group_1", status: "processing", ...voice },
      avatar_group: { id: "group_1", status: "pending_consent", consent_status: "pending", ...voice },
    },
  });

  it("create twin: reads voice_id when default_voice_id is missing", async () => {
    const { fn } = fakeFetch([{ json: twinAnswer({ voice_id: "voice_plain" }) }]);
    const twin = await real(fn).createDigitalTwin({ name: "x", file: { type: "asset_id", asset_id: "a" } });
    expect(twin.voiceId).toBe("voice_plain");
  });

  it("group and look: read voice_id when default_voice_id is missing", async () => {
    const { fn } = fakeFetch([
      { json: { data: { id: "group_1", status: "completed", consent_status: "accepted", voice_id: "voice_g" } } },
      { json: { data: [{ id: "look_1", group_id: "group_1", status: "completed", voice_id: "voice_l" }] } },
      { json: { data: { id: "look_1", status: "completed", voice_id: "voice_one" } } },
    ]);
    const client = real(fn);
    expect((await client.getAvatarGroup("group_1")).voiceId).toBe("voice_g");
    expect((await client.listLooks("group_1"))[0].voiceId).toBe("voice_l");
    expect((await client.getLook("look_1")).voiceId).toBe("voice_one");
  });

  it("both present and different: the documented default_voice_id wins", async () => {
    const { fn } = fakeFetch([
      { json: { data: { id: "g", status: null, consent_status: null, default_voice_id: "voice_doc", voice_id: "voice_other" } } },
    ]);
    expect((await real(fn).getAvatarGroup("g")).voiceId).toBe("voice_doc");
  });

  it("the documented default_voice_id shape still works", async () => {
    const { fn } = fakeFetch([{ json: twinAnswer({ default_voice_id: "voice_doc" }) }]);
    const twin = await real(fn).createDigitalTwin({ name: "x", file: { type: "asset_id", asset_id: "a" } });
    expect(twin.voiceId).toBe("voice_doc");
  });

  it("renders will always ask for 1080p explicitly (docs disagree on the default)", () => {
    expect(HEYGEN_VIDEO_RESOLUTION).toBe("1080p");
  });
});

describe("errors, retries and 429", () => {
  it("waits for Retry-After on a 429, then succeeds", async () => {
    const { fn, calls } = fakeFetch([
      { status: 429, headers: { "retry-after": "7" }, json: { error: { code: "rate_limit_exceeded", message: "slow down" } } },
      { json: { data: { username: "zee", billing_type: "wallet" } } },
    ]);
    await real(fn).getCurrentUser();
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("a 429 on a POST is retried too (the request was not processed)", async () => {
    const { default: fixture } = await import("@/tests/fixtures/heygen/create-avatar.json");
    const { fn, calls } = fakeFetch([{ status: 429, headers: { "retry-after": "3" } }, { json: fixture }]);
    await real(fn).createDigitalTwin({ name: "x", file: { type: "asset_id", asset_id: "a" } });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("a 429 without Retry-After backs off 2 s, then 4 s, then gives a plain busy error", async () => {
    const { fn, calls } = fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
    const error = await real(fn).getCurrentUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeygenError);
    expect((error as HeygenError).code).toBe("busy");
    expect((error as HeygenError).message).toBe("HeyGen is busy right now. Try again in a few minutes.");
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[2000], [4000]]);
  });

  it("SF6: the Retry-After ceiling is 15 minutes, in one constant", () => {
    expect(HEYGEN_RETRY_AFTER_MAX_S).toBe(900);
  });

  it("SF6: a Retry-After under the ceiling (600 s) is honoured in full, not truncated", async () => {
    const { fn, calls } = fakeFetch([
      { status: 429, headers: { "retry-after": "600" } },
      { json: { data: { username: "z", billing_type: "wallet" } } },
    ]);
    await real(fn).getCurrentUser();
    expect(sleep).toHaveBeenCalledWith(600_000);
    expect(calls).toHaveLength(2);
  });

  it("SF6: a Retry-After over the ceiling (999 s) fails at once with a plain retry-later error", async () => {
    const { fn, calls } = fakeFetch([{ status: 429, headers: { "retry-after": "999" } }, { json: { data: {} } }]);
    const error = (await real(fn).getCurrentUser().catch((e: unknown) => e)) as HeygenError;
    expect(error).toBeInstanceOf(HeygenError);
    expect(error.code).toBe("busy");
    expect(error.message).toBe("HeyGen is busy. Try again in 17 minutes.");
    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("SF6: pages pass a short wait limit, so a page refuses instead of waiting (120 s > 30 s)", async () => {
    const { fn, calls } = fakeFetch([{ status: 429, headers: { "retry-after": "120" } }]);
    const client = createHeygenClient({ mock: false, apiKey: "k", fetch: fn, sleep, maxWaitS: HEYGEN_PAGE_MAX_WAIT_S });
    const error = (await client.getAvatarGroup("g").catch((e: unknown) => e)) as HeygenError;
    expect(HEYGEN_PAGE_MAX_WAIT_S).toBe(30);
    expect(error.message).toBe("HeyGen is busy. Try again in 2 minutes.");
    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("a 500 on a GET is retried; a 500 on a POST is not (it might have worked)", async () => {
    const get = fakeFetch([{ status: 502 }, { json: { data: { username: "z", billing_type: "wallet" } } }]);
    await real(get.fn).getCurrentUser();
    expect(get.calls).toHaveLength(2);

    const post = fakeFetch([{ status: 500, json: { error: { code: "internal_error", message: "x" } } }]);
    const error = await real(post.fn).startConsent("g1").catch((e: unknown) => e);
    expect(post.calls).toHaveLength(1);
    expect((error as HeygenError).code).toBe("failed");
  });

  it("network errors and timeouts on GET are retried", async () => {
    let n = 0;
    const flaky = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response(JSON.stringify({ data: { username: "z", billing_type: "wallet" } }), { status: 200 });
    }) as unknown as typeof fetch;
    await real(flaky).getCurrentUser();
    expect(n).toBe(2);
  });

  it("401 → plain 'key' error, no retry, and the key never appears in the message", async () => {
    const { fn, calls } = fakeFetch([{ status: 401, json: { error: { code: "unauthorized", message: "bad key test-key" } } }]);
    const error = (await real(fn).getCurrentUser().catch((e: unknown) => e)) as HeygenError;
    expect(calls).toHaveLength(1);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe("HeyGen did not accept the API key. Check HEYGEN_API_KEY.");
    expect(error.message).not.toContain("test-key");
  });

  it("400 keeps HeyGen's error code for the admin log", async () => {
    const { fn } = fakeFetch([
      { status: 400, json: { error: { code: "invalid_parameter", message: "engine not supported", param: "engine" } } },
    ]);
    const error = (await real(fn).getLook("l1").catch((e: unknown) => e)) as HeygenError;
    expect(error.code).toBe("bad_request");
    expect(error.heygenCode).toBe("invalid_parameter");
    expect(error.status).toBe(400);
    expect(error.message).toBe("HeyGen refused the request (invalid_parameter).");
  });

  it("real mode without a key fails plainly and makes no request", async () => {
    const { fn, calls } = fakeFetch([]);
    const error = (await real(fn, null).getCurrentUser().catch((e: unknown) => e)) as HeygenError;
    expect(error.code).toBe("not_set_up");
    expect(error.message).toBe("HeyGen is not set up. Add HEYGEN_API_KEY, or keep MOCK_HEYGEN=true.");
    expect(calls).toHaveLength(0);
  });

  it("an answer that is not the documented shape is a plain error", async () => {
    const { fn } = fakeFetch([{ json: { data: { avatar_item: {} } } }]);
    const error = (await real(fn)
      .createDigitalTwin({ name: "x", file: { type: "asset_id", asset_id: "a" } })
      .catch((e: unknown) => e)) as HeygenError;
    expect(error.code).toBe("bad_output");
  });

  it("real mode is chosen only when MOCK_HEYGEN is exactly 'false'", async () => {
    process.env.MOCK_HEYGEN = "false";
    delete process.env.HEYGEN_API_KEY;
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
    const error = (await heygen().getCurrentUser().catch((e: unknown) => e)) as HeygenError;
    expect(error.code).toBe("not_set_up");
    expect(spy).not.toHaveBeenCalled();
  });
});
