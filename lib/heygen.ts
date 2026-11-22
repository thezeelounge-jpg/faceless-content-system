import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isMockHeygen, readEnv } from "@/lib/config";
import { PlainError } from "@/lib/plain-error";
import { RENDER } from "@/lib/qa/config";
import { SafeDownloadError, safeDownload, systemResolver, type Resolver, type Transport } from "@/lib/safe-download";
import mockAvatarGroup from "@/tests/fixtures/heygen/avatar-group.json";
import mockConsent from "@/tests/fixtures/heygen/consent.json";
import mockCreateAvatar from "@/tests/fixtures/heygen/create-avatar.json";
import mockDirectUpload from "@/tests/fixtures/heygen/direct-upload.json";
import mockLooks from "@/tests/fixtures/heygen/looks.json";
import mockUsersMe from "@/tests/fixtures/heygen/users-me.json";
import mockWebhookEndpoint from "@/tests/fixtures/heygen/webhook-endpoint.json";

// Every HeyGen API call in the app lives in this file (CLAUDE.md "HeyGen rules").
// - API v3 only, base https://api.heygen.com, header X-Api-Key.
// - MOCK MODE (default): answers come from tests/fixtures/heygen/*.json and go
//   through the same parsers as real answers. fetch is never called. Real calls
//   happen only when MOCK_HEYGEN is exactly "false" (lib/config.ts).
// - Every call has a timeout; GETs retry with backoff; a 429 waits for
//   Retry-After (any method, because HeyGen did not process the request).
//   Other POST failures are NOT retried, since the POST might have worked.
// - Errors are HeygenError: plain words, safe to show an admin. The key is
//   never put in a message.
// Field names come from the docs; see docs/HEYGEN-NOTES.md for the pages.
// Anything marked UNCONFIRMED was not in the docs and must be checked on the
// first real call (staging, with the owner's OK).

export const HEYGEN_BASE_URL = "https://api.heygen.com";

/** The video file mock mode hands out wherever a real video would come back. */
export const MOCK_FIXTURE_VIDEO = "tests/fixtures/consent-good.mp4";

/**
 * QA MUST FIX 1: the ONLY hosts we download finished videos from (exact host
 * match; lib/safe-download.ts). Source: HeyGen docs, "Avatar 6" model page
 * (developers.heygen.com/docs/models/avatar-6, completed-video example:
 * `"video_url": "https://resource2.heygen.ai/videos/.../VIDEO.mp4"`).
 * UNCONFIRMED (docs: no example host is shown for GET /v3/videos/{id} or the
 * avatar_video.success webhook `url`, and no CDN list exists). Fails closed:
 * a video on any other host is refused with a plain error. Check the real
 * host on the first real render and add it here with its source.
 */
export const HEYGEN_DOWNLOAD_HOSTS: readonly string[] = ["resource2.heygen.ai"];

const TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
/**
 * SF6: the longest we will wait for HeyGen's Retry-After (seconds), in task code.
 * Why a ceiling at all: a Trigger.dev task has a maxDuration (create-twin 900 s,
 * poll-twin 600 s of compute), and serverless functions are killed sooner. A
 * longer wait would be cut off mid-sleep. Above the ceiling we do NOT shorten
 * the wait (that would just get another 429): we fail at once with a plain
 * "HeyGen is busy. Try again in N minutes." and the task's own retry or the
 * admin tries later.
 */
export const HEYGEN_RETRY_AFTER_MAX_S = 15 * 60;
/**
 * Server Actions and routes (a person is waiting on the page): wait at most
 * this long, otherwise refuse with the same plain "try again in N minutes".
 */
export const HEYGEN_PAGE_MAX_WAIT_S = 30;

/**
 * Decision 3: every render asks for 1080p explicitly (POST /v3/videos
 * `resolution`, Phase 3 part B step 2). The docs disagree on the default
 * (Avatar 6 page: 1080p; Usage Limits: 720p for `avatar`). No endpoint used
 * so far (assets, avatars, consent, looks) takes a resolution field.
 */
export const HEYGEN_VIDEO_RESOLUTION = "1080p";

export type HeygenErrorCode =
  | "not_set_up"
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "busy"
  | "failed"
  | "bad_output";

export class HeygenError extends PlainError {
  constructor(
    readonly code: HeygenErrorCode,
    message: string,
    readonly extra: { status?: number; heygenCode?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: extra.cause });
    this.name = "HeygenError";
  }
  get status() {
    return this.extra.status;
  }
  get heygenCode() {
    return this.extra.heygenCode;
  }
}

export type HeygenDeps = {
  /** Defaults to MOCK_HEYGEN (mock unless exactly "false"). */
  mock: boolean;
  apiKey: string | undefined;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Longest Retry-After this caller may wait (seconds). Tasks: HEYGEN_RETRY_AFTER_MAX_S; pages: HEYGEN_PAGE_MAX_WAIT_S. */
  maxWaitS: number;
  /** DNS lookup for the safe downloader. Tests inject a fake; never real DNS in tests. */
  resolve: Resolver;
  /**
   * Video downloads only. Unset = node:https with the resolved IP pinned
   * (lib/safe-download.ts). Never the general `fetch` above. Tests pass a fake.
   */
  downloadTransport?: Transport;
};

// ---------------------------------------------------------------------------
// Answer shapes (only the fields we use; HeyGen may send more)
// ---------------------------------------------------------------------------

const nullableString = z.string().nullish().transform((v) => v ?? null);

// Decision 3: the docs name the voice `default_voice_id`, but some pages and
// answers use `voice_id`. Read both; the documented one wins when they differ.
const voiceFields = { default_voice_id: nullableString, voice_id: nullableString };
const voiceOf = (x: { default_voice_id: string | null; voice_id: string | null }) => x.default_voice_id ?? x.voice_id;

// Docs: API Key page ("billing_type and corresponding billing field").
// `username` is UNCONFIRMED (docs: user-profile page not readable via Context7).
const usersMeSchema = z.object({
  data: z.object({ billing_type: nullableString, username: nullableString }),
});

// Docs: "Create Avatar" / "Video to Avatar".
const createAvatarSchema = z.object({
  data: z.object({
    avatar_item: z.object({ id: z.string(), group_id: z.string(), status: z.string(), ...voiceFields }),
    avatar_group: z.object({
      id: z.string(),
      status: nullableString,
      consent_status: nullableString,
      ...voiceFields,
    }),
  }),
});

// Docs: "Avatar Consent". Where the consent page `url` sits inside the answer
// is UNCONFIRMED (docs: "avatar_group containing consent_status and ... url").
const consentSchema = z.object({
  data: z.object({ avatar_group: z.object({ consent_status: z.string(), url: nullableString }) }),
});

// Docs: "Avatar Groups".
const groupSchema = z.object({
  data: z.object({
    id: z.string(),
    status: nullableString,
    consent_status: nullableString,
    ...voiceFields,
  }),
});

// Docs: "Avatar Looks".
const lookSchema = z.object({
  id: z.string(),
  group_id: nullableString,
  status: nullableString,
  supported_api_engines: z.array(z.string()).nullish().transform((v) => v ?? []),
  ...voiceFields,
});
const looksSchema = z.object({ data: z.array(lookSchema) });
const oneLookSchema = z.object({ data: lookSchema });

// Docs: "Video Agent" / "Avatar 6" (GET /v3/videos/{video_id}).
const videoSchema = z.object({
  data: z.object({
    id: z.string().optional(),
    status: z.string(),
    video_url: nullableString,
    duration: z.number().nullish(),
    failure_message: nullableString,
  }),
});

// Docs: "Avatar 6" says `data.video_id`; "Avatar Looks" shows `id` and "Video
// Agent" a bare `video_id`. All three are read (UNCONFIRMED which one is real).
const createdVideoSchema = z.object({
  data: z.object({ video_id: z.string().optional(), id: z.string().optional() }).nullish(),
  video_id: z.string().optional(),
});

// Docs: "Webhooks" (POST /v3/webhooks/endpoints → endpoint_id, secret).
const webhookEndpointSchema = z.object({
  data: z.object({ endpoint_id: z.string().optional(), secret: z.string().nullish() }).nullish(),
  endpoint_id: z.string().optional(),
  secret: z.string().nullish(),
});

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Docs: "Direct Upload to S3".
const directUploadSchema = z.object({
  data: z.object({
    asset_id: z.string(),
    upload_url: z.string(),
    upload_headers: z.record(z.string(), z.string()).nullish(),
  }),
});

export type HeygenUser = { mock: boolean; billingType: string | null; username: string | null };
export type TwinFile = { type: "url"; url: string } | { type: "asset_id"; asset_id: string };
export type CreatedTwin = {
  groupId: string;
  lookId: string;
  voiceId: string | null;
  lookStatus: string;
  groupStatus: string | null;
  consentStatus: string | null;
};
export type ConsentStart = { consentStatus: string; consentUrl: string | null };
export type AvatarGroup = { groupId: string; status: string | null; consentStatus: string | null; voiceId: string | null };
export type AvatarLook = {
  lookId: string;
  groupId: string | null;
  /** Training status: processing | completed | failed (docs). */
  status: string | null;
  supportedEngines: string[];
  voiceId: string | null;
};
/** What we send to POST /v3/videos (our names; mapped to HeyGen's fields in createVideo). */
export type NewVideo = {
  /** HeyGen look id (`avatar_id`). */
  lookId: string;
  /** Our scripts.spoken_text (never display_text). Sent as HeyGen's `script`. */
  spokenText: string;
  voiceId: string;
  /** The brand's chosen engine (`engine.type`). Never a silent fallback. */
  engine: string;
  /** Our videos.id, echoed back by HeyGen in webhooks (`callback_id`). */
  callbackId: string;
  /** Only when a public https site URL is configured. */
  callbackUrl?: string | null;
  title?: string;
};
export type WebhookEndpoint = { endpointId: string; secret: string | null };

export type VideoStatus = {
  videoId: string;
  status: string;
  videoUrl: string | null;
  durationS: number | null;
  failureMessage: string | null;
  /** Mock mode only: the local fixture video to use instead of a download. */
  fixturePath: string | null;
};

function toLook(look: z.output<typeof lookSchema>): AvatarLook {
  return {
    lookId: look.id,
    groupId: look.group_id,
    status: look.status,
    supportedEngines: look.supported_api_engines,
    voiceId: voiceOf(look),
  };
}

function parse<S extends z.ZodType>(schema: S, json: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HeygenError("bad_output", `HeyGen gave an unexpected answer (${what}).`, { cause: parsed.error });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Low-level request with timeout, retry and Retry-After
// ---------------------------------------------------------------------------

/** Retry-After in seconds when HeyGen sent a usable number, else null. */
function retryAfterSeconds(retryAfter: string | null): number | null {
  const seconds = Number(retryAfter);
  return retryAfter && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Retry-After in ms (in full; callers check the ceiling first), or 2 s, 4 s, ... */
export function heygenBackoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfterSeconds(retryAfter);
  return seconds !== null ? seconds * 1000 : 2000 * 2 ** (attempt - 1);
}

function busyFor(seconds: number, status: number): HeygenError {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return new HeygenError("busy", `HeyGen is busy. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, { status });
}

function errorFor(status: number, body: unknown): HeygenError {
  // Docs ("Error Codes"): code, message, param, doc_url, request_id, inside an
  // `error` envelope. We keep only the code; HeyGen's message is not shown.
  const envelope = (body as { error?: { code?: unknown } } | null)?.error;
  const heygenCode = typeof envelope?.code === "string" ? envelope.code : undefined;
  const extra = { status, heygenCode };
  if (status === 401 || status === 403) {
    return new HeygenError("unauthorized", "HeyGen did not accept the API key. Check HEYGEN_API_KEY.", extra);
  }
  if (status === 404) return new HeygenError("not_found", "HeyGen could not find that item.", extra);
  if (status === 429) return new HeygenError("busy", "HeyGen is busy right now. Try again in a few minutes.", extra);
  if (status >= 400 && status < 500) {
    return new HeygenError("bad_request", `HeyGen refused the request (${heygenCode ?? status}).`, extra);
  }
  return new HeygenError("failed", `HeyGen had a problem (${heygenCode ?? status}). Try again later.`, extra);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type RequestOptions = { method: "GET" | "POST" | "PUT"; body?: unknown; timeoutMs?: number };

function makeRequester(deps: HeygenDeps) {
  return async function request(path: string, options: RequestOptions): Promise<unknown> {
    if (!deps.apiKey) {
      throw new HeygenError("not_set_up", "HeyGen is not set up. Add HEYGEN_API_KEY, or keep MOCK_HEYGEN=true.");
    }
    const headers: Record<string, string> = { "X-Api-Key": deps.apiKey, Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const init = {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    };
    return send(deps, `${HEYGEN_BASE_URL}${path}`, init, options);
  };
}

/** One HTTP call with retries. Used for the API and for the upload PUT (never for video downloads: see downloadVideo). */
async function send(
  deps: HeygenDeps,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: BodyInit },
  options: { method: string; timeoutMs?: number },
): Promise<unknown> {
  const canRetryFailures = options.method === "GET";
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
    } catch (cause) {
      // Network error or timeout. Safe to repeat only for GET.
      if (canRetryFailures && attempt < MAX_ATTEMPTS) {
        await deps.sleep(heygenBackoffMs(attempt, null));
        continue;
      }
      throw new HeygenError("failed", "Could not reach HeyGen. Try again later.", { cause });
    }
    if (response.ok) return readJson(response);

    const body = await readJson(response);
    const retryable = response.status === 429 || (canRetryFailures && response.status >= 500);
    const waitS = response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : null;
    // SF6: never cut HeyGen's Retry-After short. Too long for this caller → plain retry-later error now.
    if (waitS !== null && waitS > deps.maxWaitS) throw busyFor(waitS, response.status);
    if (retryable && attempt < MAX_ATTEMPTS) {
      await deps.sleep(heygenBackoffMs(attempt, response.headers.get("retry-after")));
      continue;
    }
    throw errorFor(response.status, body);
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export function createHeygenClient(overrides: Partial<HeygenDeps> = {}) {
  const deps: HeygenDeps = {
    mock: isMockHeygen(),
    apiKey: readEnv("HEYGEN_API_KEY"),
    fetch: (...args) => globalThis.fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxWaitS: HEYGEN_RETRY_AFTER_MAX_S,
    resolve: systemResolver,
    ...overrides,
  };
  const request = makeRequester(deps);
  /** In mock mode the fixture answer; otherwise the real call. Never both. */
  const call = (fixture: unknown, path: string, options: RequestOptions) =>
    deps.mock ? Promise.resolve(structuredClone(fixture)) : request(path, options);

  return {
    mock: deps.mock,

    /** GET /v3/users/me: checks the key works (no cost). */
    async getCurrentUser(): Promise<HeygenUser> {
      const json = await call(mockUsersMe, "/v3/users/me", { method: "GET" });
      const { data } = parse(usersMeSchema, json, "users/me");
      return { mock: deps.mock, billingType: data.billing_type, username: data.username };
    },

    /**
     * Uploads a file with HeyGen's direct upload (videos up to 200 MB, per the
     * docs): create → PUT the bytes → complete. Returns the asset_id.
     */
    async uploadAsset(file: { bytes: Uint8Array; filename: string; contentType: string }): Promise<string> {
      const checksum = createHash("sha256").update(file.bytes).digest("hex");
      const created = parse(
        directUploadSchema,
        await call(mockDirectUpload, "/v3/assets/direct-uploads", {
          method: "POST",
          body: {
            filename: file.filename,
            content_type: file.contentType,
            size_bytes: file.bytes.byteLength,
            checksum_sha256: checksum,
          },
        }),
        "direct upload",
      ).data;
      if (deps.mock) return created.asset_id;
      // The upload URL is a storage host, not api.heygen.com: no API key here.
      await send(
        deps,
        created.upload_url,
        {
          method: "PUT",
          headers: { ...(created.upload_headers ?? { "Content-Type": file.contentType }) },
          body: file.bytes as BodyInit,
        },
        { method: "PUT", timeoutMs: UPLOAD_TIMEOUT_MS },
      );
      await request(`/v3/assets/${enc(created.asset_id)}/complete`, {
        method: "POST",
        body: { checksum_sha256: checksum },
      });
      return created.asset_id;
    },

    /** POST /v3/avatars (type digital_twin): starts training a new twin in a new group. */
    async createDigitalTwin(input: { name: string; file: TwinFile }): Promise<CreatedTwin> {
      const json = await call(mockCreateAvatar, "/v3/avatars", {
        method: "POST",
        body: { type: "digital_twin", name: input.name, file: input.file },
      });
      const { avatar_item: look, avatar_group: group } = parse(createAvatarSchema, json, "create twin").data;
      return {
        groupId: group.id,
        lookId: look.id,
        voiceId: voiceOf(group) ?? voiceOf(look),
        lookStatus: look.status,
        groupStatus: group.status,
        consentStatus: group.consent_status,
      };
    },

    /** POST /v3/avatars/{group_id}/consent: HeyGen's own webcam consent (link valid 24 h). */
    async startConsent(groupId: string): Promise<ConsentStart> {
      const json = await call(mockConsent, `/v3/avatars/${enc(groupId)}/consent`, { method: "POST", body: {} });
      const group = parse(consentSchema, json, "consent").data.avatar_group;
      return { consentStatus: group.consent_status, consentUrl: group.url };
    },

    /** GET /v3/avatars/{group_id}: consent_status and group status (no webhook for consent). */
    async getAvatarGroup(groupId: string): Promise<AvatarGroup> {
      const json = await call(mockAvatarGroup, `/v3/avatars/${enc(groupId)}`, { method: "GET" });
      const data = parse(groupSchema, json, "avatar group").data;
      return { groupId: data.id, status: data.status, consentStatus: data.consent_status, voiceId: voiceOf(data) };
    },

    /** GET /v3/avatars/looks?group_id=…: the looks in one group, with engines and voice. */
    async listLooks(groupId: string): Promise<AvatarLook[]> {
      const json = await call(mockLooks, `/v3/avatars/looks?group_id=${enc(groupId)}`, { method: "GET" });
      return parse(looksSchema, json, "looks").data.map(toLook);
    },

    /** GET /v3/avatars/looks/{look_id}. */
    async getLook(lookId: string): Promise<AvatarLook> {
      const fixture = { data: mockLooks.data[0] };
      const json = await call(fixture, `/v3/avatars/looks/${enc(lookId)}`, { method: "GET" });
      return toLook(parse(oneLookSchema, json, "look").data);
    },

    /** GET /v3/videos/{video_id}. The video_url expires, so download it at once (Phase 3 part B). */
    async getVideo(videoId: string): Promise<VideoStatus> {
      const fixture = { data: { id: videoId, status: "completed", video_url: null, duration: 16 } };
      const json = await call(fixture, `/v3/videos/${enc(videoId)}`, { method: "GET" });
      const data = parse(videoSchema, json, "video").data;
      return {
        videoId: data.id ?? videoId,
        status: data.status,
        videoUrl: data.video_url,
        durationS: data.duration ?? null,
        failureMessage: data.failure_message,
        fixturePath: deps.mock ? MOCK_FIXTURE_VIDEO : null,
      };
    },

    /**
     * POST /v3/videos: starts a PAID render. Callers go through withHeygenSpend
     * first (lib/render.ts). Docs: "Avatar 6" (body fields, `engine: {type}`,
     * resolution, aspect_ratio) and "HeyGen Video" (callback_id; "send
     * callback_id alone to deliver to the webhook endpoints registered for your
     * workspace"). No idempotency key is documented for this call, so
     * lib/render.ts keeps its own claim (videos.render_started_at).
     */
    async createVideo(input: NewVideo): Promise<{ videoId: string }> {
      if (!input.spokenText.trim()) throw new HeygenError("bad_request", "There is no text to say. Write the script first.");
      if (!input.engine) throw new HeygenError("bad_request", "No engine chosen for this client. Run the likeness test first.");
      if (!input.lookId || !input.voiceId) {
        throw new HeygenError("bad_request", "The twin has no look or no voice yet. Check the twin first.");
      }
      const body: Record<string, unknown> = {
        type: "avatar",
        avatar_id: input.lookId,
        script: input.spokenText,
        voice_id: input.voiceId,
        engine: { type: input.engine },
        resolution: HEYGEN_VIDEO_RESOLUTION,
        aspect_ratio: "9:16",
        callback_id: input.callbackId,
      };
      if (input.callbackUrl) body.callback_url = input.callbackUrl;
      if (input.title) body.title = input.title;
      const fixture = { data: { video_id: `video_mock_${input.callbackId}` } };
      const json = await call(fixture, "/v3/videos", { method: "POST", body });
      const parsed = parse(createdVideoSchema, json, "create video");
      const videoId = parsed.data?.video_id ?? parsed.data?.id ?? parsed.video_id;
      if (!videoId) throw new HeygenError("bad_output", "HeyGen gave an unexpected answer (create video).");
      return { videoId };
    },

    /**
     * Downloads a finished video file (the signed `video_url`, which expires:
     * download at once) through the safe downloader (lib/safe-download.ts):
     * https only, HEYGEN_DOWNLOAD_HOSTS only, every DNS answer public, manual
     * redirects (each hop re-checked), video/* only, byte cap and timeout
     * (RENDER in lib/qa/config.ts). Our API key is NOT sent to the file host.
     * Timeouts, network errors and 5xx are retried with backoff; refusals are
     * not. Errors never contain the URL. Mock: the fixture bytes, no fetch.
     */
    async downloadVideo(url: string): Promise<Uint8Array> {
      if (deps.mock) return new Uint8Array(await readFile(path.resolve(MOCK_FIXTURE_VIDEO)));
      for (let attempt = 1; ; attempt++) {
        try {
          const { bytes } = await safeDownload(url, {
            transport: deps.downloadTransport,
            resolve: deps.resolve,
            allowedHosts: HEYGEN_DOWNLOAD_HOSTS,
            maxBytes: RENDER.download_max_bytes,
            maxRedirects: RENDER.download_max_redirects,
            timeoutMs: RENDER.download_timeout_s * 1000,
          });
          return bytes;
        } catch (cause) {
          const retryable = cause instanceof SafeDownloadError && cause.retryable;
          if (retryable && attempt < MAX_ATTEMPTS) {
            await deps.sleep(heygenBackoffMs(attempt, null));
            continue;
          }
          if (cause instanceof SafeDownloadError && !retryable && cause.code !== "too_big" && cause.code !== "http_error") {
            throw new HeygenError("bad_output", "The video link from HeyGen is not usable.", { cause });
          }
          throw new HeygenError("failed", "Could not download the video from HeyGen. Try again later.", { cause });
        }
      }
    },

    /**
     * POST /v3/webhooks/endpoints (one-time setup script only). Docs
     * ("Webhooks"): body `url` (https) and `events`; the answer has
     * `endpoint_id` and `secret`, which "will not be shown again". Whether
     * they sit under `data` is UNCONFIRMED, so both shapes are read.
     */
    async createWebhookEndpoint(input: { url: string; events: string[] }): Promise<WebhookEndpoint> {
      if (!isHttpsUrl(input.url)) throw new HeygenError("bad_request", "The webhook URL must start with https://.");
      const json = await call(mockWebhookEndpoint, "/v3/webhooks/endpoints", {
        method: "POST",
        body: { url: input.url, events: input.events },
      });
      const parsed = parse(webhookEndpointSchema, json, "webhook endpoint");
      const endpointId = parsed.data?.endpoint_id ?? parsed.endpoint_id;
      if (!endpointId) throw new HeygenError("bad_output", "HeyGen gave an unexpected answer (webhook endpoint).");
      return { endpointId, secret: parsed.data?.secret ?? parsed.secret ?? null };
    },
  };
}

export type HeygenClient = ReturnType<typeof createHeygenClient>;

/**
 * The app's HeyGen client, set up from env (mock unless MOCK_HEYGEN is exactly "false").
 * Background tasks: heygen(). Pages, Server Actions and routes: heygen({ forPage: true }).
 */
export function heygen(opts: { forPage?: boolean } = {}): HeygenClient {
  return createHeygenClient(opts.forPage ? { maxWaitS: HEYGEN_PAGE_MAX_WAIT_S } : {});
}
