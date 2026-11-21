import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeygenClient, HeygenError, type HeygenClient } from "@/lib/heygen";
import { TWIN_POLL, createTwin, pollTwinOnce, pollTwinUntilReady } from "@/lib/twin";
import { BRAND_ID, memoryClipStorage, memoryConsentStore } from "@/tests/helpers/consent-memory";

const MB = 1024 * 1024;
let mem: ReturnType<typeof memoryConsentStore>;
let clips: ReturnType<typeof memoryClipStorage>;

beforeEach(() => {
  mem = memoryConsentStore();
  clips = memoryClipStorage();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
});
afterEach(() => vi.restoreAllMocks());

/** A consent with a passing clip, in the given admin status. */
async function consentWith(status: "pending" | "approved" | "rejected") {
  const consent = await mem.store.insertConsent({
    brand_id: BRAND_ID,
    person_legal_name: "Ayesha Khan",
    checkbox_at: new Date().toISOString(),
    words: ["apple", "river", "tiger"],
    words_expire_at: new Date(Date.now() + 1_800_000).toISOString(),
    ip: null,
    user_agent: null,
  });
  const clipPath = `${BRAND_ID}/${consent.id}/55555555-5555-4555-8555-555555555555.mp4`;
  clips.files[clipPath] = { size: 1 * MB, contentType: "video/mp4", fixture: "consent-good.mp4" };
  await mem.store.updateConsent(consent.id, { clip_path: clipPath, admin_status: status });
  return consent;
}

const mockHeygen = () => createHeygenClient({ mock: true, apiKey: "dummy" });

/** Wraps a client so every HeyGen helper call is counted. */
function counted(client: HeygenClient) {
  const calls: string[] = [];
  const wrapped = Object.fromEntries(
    Object.entries(client).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args: unknown[]) => {
            calls.push(key);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  ) as HeygenClient;
  return { client: wrapped, calls };
}

describe("no twin before admin approval", () => {
  for (const status of ["pending", "rejected"] as const) {
    it(`a ${status} consent: createTwin refuses and HeyGen is never called`, async () => {
      const consent = await consentWith(status);
      const { client, calls } = counted(mockHeygen());
      await expect(createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen: client })).rejects.toThrow(
        "No twin before the consent clip is approved.",
      );
      expect(calls).toEqual([]);
      expect(mem.avatars).toHaveLength(0);
    });
  }

  it("an avatar row alone is not enough: the consent itself must be approved", async () => {
    const consent = await consentWith("pending");
    await mem.store.insertAvatar({ brand_id: BRAND_ID, consent_id: consent.id, status: "training" });
    const { client, calls } = counted(mockHeygen());
    await expect(createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen: client })).rejects.toThrow(
      "No twin before the consent clip is approved.",
    );
    expect(calls).toEqual([]);
  });
});

describe("createTwin (mock HeyGen)", () => {
  it("uploads the clip, creates the twin, starts consent and 'emails' the link to the mock outbox", async () => {
    const consent = await consentWith("approved");
    const { client, calls } = counted(mockHeygen());
    const avatar = await createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen: client });

    expect(calls).toEqual(["uploadAsset", "createDigitalTwin", "startConsent"]);
    expect(avatar).toMatchObject({
      consent_id: consent.id,
      heygen_group_id: "group_mock_0001",
      heygen_look_id: "look_mock_0001",
      voice_id: "voice_mock_0001",
      status: "consent_pending",
      error: null,
    });
    expect(await mem.store.getConsent(consent.id)).toMatchObject({
      heygen_consent_status: "pending",
      heygen_consent_url: "https://consent.example.invalid/mock/group_mock_0001",
    });
    expect(mem.outbox).toHaveLength(1);
    expect(mem.outbox[0]).toMatchObject({
      kind: "consent_link",
      to_email: "owner@example.com",
      status: "mocked",
      subject: "Please confirm your consent on HeyGen (within 24 hours)",
    });
    expect(mem.outbox[0].body).toContain("https://consent.example.invalid/mock/group_mock_0001");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("running twice (a retry) makes no second twin and no second email", async () => {
    const consent = await consentWith("approved");
    const { client, calls } = counted(mockHeygen());
    const deps = { store: mem.store, storage: clips.storage, heygen: client };
    await createTwin(consent.id, deps);
    await createTwin(consent.id, deps);
    expect(calls.filter((c) => c === "createDigitalTwin")).toHaveLength(1);
    expect(calls.filter((c) => c === "startConsent")).toHaveLength(1);
    expect(mem.avatars).toHaveLength(1);
    expect(mem.outbox).toHaveLength(1);
  });

  it("a HeyGen error is saved on the avatar in plain words, then thrown (so the task retries)", async () => {
    const consent = await consentWith("approved");
    const client = {
      ...mockHeygen(),
      createDigitalTwin: async () => {
        throw new HeygenError("bad_request", "HeyGen refused the request (invalid_parameter).");
      },
    } as HeygenClient;
    await expect(createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen: client })).rejects.toThrow(
      "HeyGen refused the request (invalid_parameter).",
    );
    expect(mem.avatars[0]).toMatchObject({ status: "training", error: "HeyGen refused the request (invalid_parameter)." });
  });
});

// A scripted HeyGen: each poll returns the next group/looks answer.
function scripted(steps: Array<{ group: { status: string | null; consentStatus: string | null }; look?: { status: string } }>) {
  let i = 0;
  const base = mockHeygen();
  const client = {
    ...base,
    getAvatarGroup: async (groupId: string) => {
      const step = steps[Math.min(i, steps.length - 1)];
      return { groupId, voiceId: "voice_group_1", ...step.group };
    },
    listLooks: async (groupId: string) => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return step.look
        ? [{ lookId: "look_final", groupId, status: step.look.status, supportedEngines: ["avatar_iv", "avatar_v"], voiceId: "voice_look_1" }]
        : [];
    },
  } as HeygenClient;
  return client;
}

async function avatarAwaitingConsent() {
  const consent = await consentWith("approved");
  const avatar = await mem.store.insertAvatar({ brand_id: BRAND_ID, consent_id: consent.id, status: "consent_pending" });
  await mem.store.updateAvatar(avatar.id, { heygen_group_id: "group_1" });
  return { consent, avatar };
}

describe("polling until the twin is ready", () => {
  it("waits while consent is pending or the look is training; then saves look id, voice id and engines", async () => {
    const { consent, avatar } = await avatarAwaitingConsent();
    const heygen = scripted([
      { group: { status: "pending_consent", consentStatus: "pending" }, look: { status: "processing" } },
      { group: { status: "completed", consentStatus: "accepted" }, look: { status: "processing" } },
      { group: { status: "completed", consentStatus: "accepted" }, look: { status: "completed" } },
    ]);
    const deps = { store: mem.store, heygen };

    expect(await pollTwinOnce(avatar.id, deps)).toEqual({ done: false, status: "consent_pending" });
    expect(await pollTwinOnce(avatar.id, deps)).toEqual({ done: false, status: "training" });
    expect((await mem.store.getConsent(consent.id))?.heygen_consent_status).toBe("accepted");
    expect(await pollTwinOnce(avatar.id, deps)).toEqual({ done: true, status: "likeness_test" });

    expect(await mem.store.getAvatar(avatar.id)).toMatchObject({
      heygen_look_id: "look_final",
      voice_id: "voice_group_1",
      supported_engines: ["avatar_iv", "avatar_v"],
      status: "likeness_test",
      error: null,
    });
  });

  it("a failed group (e.g. consent rejected on HeyGen) marks the avatar failed with a plain reason", async () => {
    const { avatar } = await avatarAwaitingConsent();
    const heygen = scripted([{ group: { status: "failed", consentStatus: "rejected" } }]);
    expect(await pollTwinOnce(avatar.id, { store: mem.store, heygen })).toEqual({ done: true, status: "failed" });
    expect((await mem.store.getAvatar(avatar.id))?.error).toBe(
      "The person did not accept HeyGen's consent check. Start a new consent.",
    );
  });

  it("a failed look (training failed) marks the avatar reshoot_needed", async () => {
    const { avatar } = await avatarAwaitingConsent();
    const heygen = scripted([{ group: { status: "completed", consentStatus: "accepted" }, look: { status: "failed" } }]);
    expect(await pollTwinOnce(avatar.id, { store: mem.store, heygen })).toEqual({ done: true, status: "reshoot_needed" });
    expect((await mem.store.getAvatar(avatar.id))?.error).toBe("HeyGen could not train the twin from this clip. Ask for a reshoot.");
  });

  it("is bounded: backs off (doubling, capped) and gives up with a saved error after max attempts", async () => {
    const { avatar } = await avatarAwaitingConsent();
    const heygen = scripted([{ group: { status: "pending_consent", consentStatus: "pending" } }]);
    const wait = vi.fn(async (_seconds: number) => {});
    const result = await pollTwinUntilReady(avatar.id, { store: mem.store, heygen, wait, maxAttempts: 6 });
    expect(result).toEqual({ done: false, status: "consent_pending" });
    expect(wait.mock.calls.map(([s]) => s)).toEqual([60, 120, 240, 480, 960]);
    expect((await mem.store.getAvatar(avatar.id))?.error).toBe(
      "Still waiting for HeyGen after many checks. Check the consent email was completed, then press “Check twin again”.",
    );
    expect(TWIN_POLL.max_wait_s).toBe(1800);
  });

  it("mock HeyGen: ready on the first check, no waiting, zero fetches", async () => {
    const { avatar } = await avatarAwaitingConsent();
    await mem.store.updateAvatar(avatar.id, { heygen_group_id: "group_mock_0001" });
    const wait = vi.fn(async () => {});
    const result = await pollTwinUntilReady(avatar.id, { store: mem.store, heygen: mockHeygen(), wait });
    expect(result).toEqual({ done: true, status: "likeness_test" });
    expect(wait).not.toHaveBeenCalled();
    expect(await mem.store.getAvatar(avatar.id)).toMatchObject({
      heygen_look_id: "look_mock_0001",
      voice_id: "voice_mock_0001",
      supported_engines: ["avatar_iv", "avatar_v"],
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("an avatar without a HeyGen group cannot be polled", async () => {
    const consent = await consentWith("approved");
    const avatar = await mem.store.insertAvatar({ brand_id: BRAND_ID, consent_id: consent.id, status: "training" });
    await expect(pollTwinOnce(avatar.id, { store: mem.store, heygen: mockHeygen() })).rejects.toThrow(
      "This twin has not been created on HeyGen yet.",
    );
  });
});
