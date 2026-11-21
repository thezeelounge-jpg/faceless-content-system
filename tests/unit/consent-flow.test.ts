import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveConsent,
  checkConsentClip,
  clipPlaybackUrl,
  confirmUpload,
  newWords,
  prepareUpload,
  rejectConsent,
  startConsent,
  validateUpload,
} from "@/lib/consent-flow";
import { CONSENT_WORD_LIST } from "@/lib/consent-words";
import { BRAND_ID, memoryClipStorage, memoryConsentStore } from "@/tests/helpers/consent-memory";

const NOW = new Date("2026-11-22T10:00:00.000Z");
const LATER = new Date("2026-11-22T10:10:00.000Z");
const EXPIRED = new Date("2026-11-22T10:31:00.000Z");
const MB = 1024 * 1024;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

let mem: ReturnType<typeof memoryConsentStore>;
beforeEach(() => {
  mem = memoryConsentStore();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
});
afterEach(() => vi.restoreAllMocks());

async function started() {
  return startConsent(
    { brandId: BRAND_ID, legalName: "  Ayesha Khan ", agreed: true, ip: "203.0.113.9", userAgent: "Test/1.0" },
    { store: mem.store, now: NOW },
  );
}

describe("start consent", () => {
  it("saves a pending row with legal name, checkbox time, 3 words, 30-minute expiry, ip and user agent", async () => {
    const consent = await started();
    expect(consent).toMatchObject({
      brand_id: BRAND_ID,
      person_legal_name: "Ayesha Khan",
      checkbox_at: NOW.toISOString(),
      words_expire_at: "2026-11-22T10:30:00.000Z",
      admin_status: "pending",
      ip: "203.0.113.9",
      user_agent: "Test/1.0",
      clip_path: null,
    });
    expect(consent.words).toHaveLength(3);
    for (const word of consent.words) expect(CONSENT_WORD_LIST).toContain(word);
  });

  it("needs the checkbox, a real legal name and a known brand", async () => {
    const deps = { store: mem.store, now: NOW };
    const base = { brandId: BRAND_ID, legalName: "Ayesha Khan", agreed: true, ip: null, userAgent: null };
    await expect(startConsent({ ...base, agreed: false }, deps)).rejects.toThrow(
      "Tick the box to confirm the person agrees to a digital twin.",
    );
    await expect(startConsent({ ...base, legalName: " A " }, deps)).rejects.toThrow("Type the person's full legal name.");
    await expect(startConsent({ ...base, brandId: "10000000-0000-0000-0000-000000000999" }, deps)).rejects.toThrow(
      "Client not found.",
    );
    expect(mem.consents).toHaveLength(0);
  });

  it("New words: fresh words and expiry, and any clip with the old words is dropped", async () => {
    const consent = await started();
    await mem.store.updateConsent(consent.id, { clip_path: "x/y/z.mp4", clip_checks: null });
    const fixed = (max: number) => max - 1;
    const renewed = await newWords(consent.id, { store: mem.store, now: LATER, random: fixed });
    expect(renewed.words_expire_at).toBe("2026-11-22T10:40:00.000Z");
    expect(renewed.words).toEqual(CONSENT_WORD_LIST.slice(-3).reverse());
    expect(renewed.clip_path).toBeNull();
  });
});

describe("upload into the private bucket", () => {
  it("validates type and size on the server", () => {
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: 80 * MB })).toBeNull();
    expect(validateUpload({ name: "clip.webm", type: "video/webm", size: 30 * MB })).toBeNull();
    expect(validateUpload({ name: "clip.mov", type: "video/quicktime", size: 80 * MB })).toBe(
      "Upload an MP4 or WebM video. On iPhone: Settings → Camera → Formats → Most Compatible.",
    );
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: 201 * MB })).toBe(
      "The clip is too big (over 200 MB). Record about 2 minutes at 1080p.",
    );
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: 10_000 })).toBe(
      "The clip is too small to be a real recording. Record about 2 minutes.",
    );
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: Number.NaN })).toBe(
      "The clip is too small to be a real recording. Record about 2 minutes.",
    );
  });

  it("gives a one-time signed upload for a path inside this brand and consent", async () => {
    const { storage, uploadUrls } = memoryClipStorage();
    const consent = await started();
    const upload = await prepareUpload(consent.id, { name: "My Clip.MP4", type: "video/mp4", size: 50 * MB }, {
      store: mem.store,
      storage,
      now: LATER,
    });
    expect(upload.path).toMatch(new RegExp(`^${BRAND_ID}/${consent.id}/[0-9a-f-]{36}\\.mp4$`));
    expect(upload.token).toBe(`token-for-${upload.path}`);
    expect(uploadUrls).toEqual([upload.path]);
  });

  it("refuses an upload once the words have expired", async () => {
    const { storage, uploadUrls } = memoryClipStorage();
    const consent = await started();
    await expect(
      prepareUpload(consent.id, { name: "c.mp4", type: "video/mp4", size: 50 * MB }, { store: mem.store, storage, now: EXPIRED }),
    ).rejects.toThrow("The 3 words have expired. Press “New words”, then record again saying the new words.");
    expect(uploadUrls).toEqual([]);
  });

  it("confirm checks the stored file itself (size and type) and saves clip_path", async () => {
    const consent = await started();
    const good = `${BRAND_ID}/${consent.id}/11111111-1111-4111-8111-111111111111.mp4`;
    const huge = `${BRAND_ID}/${consent.id}/22222222-2222-4222-8222-222222222222.mp4`;
    const { storage } = memoryClipStorage({
      [good]: { size: 40 * MB, contentType: "video/mp4" },
      [huge]: { size: 500 * MB, contentType: "video/mp4" },
    });
    const deps = { store: mem.store, storage, now: LATER };
    await expect(confirmUpload(consent.id, huge, deps)).rejects.toThrow("The clip is too big (over 200 MB).");
    await expect(confirmUpload(consent.id, `${BRAND_ID}/other-consent/x.mp4`, deps)).rejects.toThrow(
      "That upload does not belong to this consent.",
    );
    await expect(confirmUpload(consent.id, `${BRAND_ID}/${consent.id}/../../x.mp4`, deps)).rejects.toThrow(
      "That upload does not belong to this consent.",
    );
    await expect(
      confirmUpload(consent.id, `${BRAND_ID}/${consent.id}/33333333-3333-4333-8333-333333333333.mp4`, deps),
    ).rejects.toThrow("We couldn't find the uploaded clip. Please upload it again.");
    const saved = await confirmUpload(consent.id, good, deps);
    expect(saved.clip_path).toBe(good);
    expect(saved.clip_checks).toBeNull();
  });

  it("playback uses a short-lived signed URL (5 minutes)", async () => {
    const { storage, signed } = memoryClipStorage();
    const url = await clipPlaybackUrl({ clip_path: "b/c/x.mp4" }, storage);
    expect(url).toContain("signed/b/c/x.mp4");
    expect(signed).toEqual([{ path: "b/c/x.mp4", seconds: 300 }]);
    expect(await clipPlaybackUrl({ clip_path: null }, storage)).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)("automatic clip checks are saved on the consent", () => {
  async function withClip(fixture: string) {
    const consent = await started();
    const clipPath = `${BRAND_ID}/${consent.id}/44444444-4444-4444-8444-444444444444.mp4`;
    const { storage } = memoryClipStorage({ [clipPath]: { size: 40 * MB, contentType: "video/mp4", fixture } });
    await mem.store.updateConsent(consent.id, { clip_path: clipPath });
    return { consent, storage };
  }
  const claude = { mock: true, logUsage: async () => {} };

  it("good clip: passes, saved to clip_checks, no reshoot email", async () => {
    const { consent, storage } = await withClip("consent-good.mp4");
    const result = await checkConsentClip(consent.id, { store: mem.store, storage, claude, fixtureName: "consent-good.mp4" });
    expect(result.passed).toBe(true);
    expect((await mem.store.getConsent(consent.id))?.clip_checks?.passed).toBe(true);
    expect(mem.outbox).toEqual([]);
  });

  it("bad clip: fails with tips, and the reshoot tips 'email' goes to the mock outbox (not sent)", async () => {
    const { consent, storage } = await withClip("consent-bad.mp4");
    const result = await checkConsentClip(consent.id, { store: mem.store, storage, claude, fixtureName: "consent-bad.mp4" });
    expect(result.passed).toBe(false);
    expect(mem.outbox).toHaveLength(1);
    expect(mem.outbox[0]).toMatchObject({
      kind: "reshoot_tips",
      to_email: "owner@example.com",
      consent_id: consent.id,
      brand_id: BRAND_ID,
      status: "mocked",
      subject: "Please record your clip again",
    });
    expect(mem.outbox[0].body).toContain("Only you should be in the clip.");
    expect(mem.outbox[0].body).toContain("Face a window in daylight");
  });
});

describe("admin approval", () => {
  async function checked(passed: boolean) {
    const consent = await started();
    await mem.store.updateConsent(consent.id, {
      clip_path: `${BRAND_ID}/${consent.id}/c.mp4`,
      clip_checks: { passed, checked_at: NOW.toISOString(), checks: [], tips: [], measurements: {} as never },
    });
    return consent;
  }

  it("approve: saves status and note, and creates ONE avatar row (training) for this consent", async () => {
    const consent = await checked(true);
    const { avatar } = await approveConsent(consent.id, "Words clear", { store: mem.store });
    expect(await mem.store.getConsent(consent.id)).toMatchObject({ admin_status: "approved", admin_note: "Words clear" });
    expect(avatar).toMatchObject({ consent_id: consent.id, brand_id: BRAND_ID, status: "training", heygen_group_id: null });
    await expect(approveConsent(consent.id, "", { store: mem.store })).rejects.toThrow(
      "This consent is already approved.",
    );
    expect(mem.avatars).toHaveLength(1);
  });

  it("cannot approve without a clip, or before the clip checks pass", async () => {
    const none = await started();
    await expect(approveConsent(none.id, "", { store: mem.store })).rejects.toThrow("Upload the clip first.");
    const failing = await checked(false);
    await expect(approveConsent(failing.id, "", { store: mem.store })).rejects.toThrow(
      "The clip checks must pass before approval. Ask for a reshoot.",
    );
    expect(mem.avatars).toHaveLength(0);
  });

  it("reject needs a note and creates no avatar", async () => {
    const consent = await checked(true);
    await expect(rejectConsent(consent.id, "  ", { store: mem.store })).rejects.toThrow(
      "Write a short note saying why.",
    );
    await rejectConsent(consent.id, "Words not said", { store: mem.store });
    expect(await mem.store.getConsent(consent.id)).toMatchObject({ admin_status: "rejected", admin_note: "Words not said" });
    expect(mem.avatars).toHaveLength(0);
    await expect(approveConsent(consent.id, "", { store: mem.store })).rejects.toThrow("This consent was rejected.");
  });
});
