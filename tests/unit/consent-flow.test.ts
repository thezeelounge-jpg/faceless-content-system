import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_UPLOAD,
  approveConsent,
  checkConsentClip,
  clipPlaybackUrl,
  confirmUpload,
  newWords,
  prepareUpload,
  rejectConsent,
  runClipCheckJob,
  startConsent,
  validateUpload,
} from "@/lib/consent-flow";
import { validateUpload as browserValidateUpload } from "@/lib/consent-upload-rules";
import { CONSENT_WORD_LIST } from "@/lib/consent-words";

const BIG_TIP =
  "The clip is too big (over 50 MB). To make it smaller: record at 1080p and 30 fps (not 4K or 60 fps), keep it to about 2 minutes, or on iPhone choose Settings → Camera → Formats → Most Compatible.";
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

  it("decision 6: the client's own email (optional) is saved on the brand; a bad one is refused", async () => {
    const deps = { store: mem.store, now: NOW };
    const base = { brandId: BRAND_ID, legalName: "Ayesha Khan", agreed: true, ip: null, userAgent: null };
    await expect(startConsent({ ...base, clientEmail: "not-an-email" }, deps)).rejects.toThrow(
      "Type the client's email address, or leave it empty.",
    );
    expect(mem.consents).toHaveLength(0);
    await startConsent({ ...base, clientEmail: "  Ayesha@Clinic.example " }, deps);
    expect(mem.getContactEmail()).toBe("ayesha@clinic.example");
    await startConsent({ ...base, clientEmail: "" }, deps);
    expect(mem.getContactEmail()).toBe("ayesha@clinic.example"); // empty leaves it as it was
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
  it("decision 4: the cap is 50 MB, with a plain tip on making the file smaller", () => {
    expect(CONSENT_UPLOAD.max_bytes).toBe(50 * MB);
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: 50 * MB })).toBeNull();
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: 50 * MB + 1 })).toBe(BIG_TIP);
    expect(validateUpload({ name: "clip.webm", type: "video/webm", size: 80 * MB })).toBe(BIG_TIP);
  });

  it("decision 4: the browser uses the very same check before uploading", () => {
    expect(browserValidateUpload).toBe(validateUpload);
  });

  it("decision 4: prepare and confirm both refuse a file over 50 MB", async () => {
    const consent = await started();
    const big = `${BRAND_ID}/${consent.id}/22222222-2222-4222-8222-222222222222.mp4`;
    const { storage, uploadUrls } = memoryClipStorage({ [big]: { size: 60 * MB, contentType: "video/mp4" } });
    await expect(
      prepareUpload(consent.id, { name: "c.mp4", type: "video/mp4", size: 60 * MB }, { store: mem.store, storage, now: LATER }),
    ).rejects.toThrow(BIG_TIP);
    expect(uploadUrls).toEqual([]);
    await expect(confirmUpload(consent.id, big, { store: mem.store, storage, now: LATER })).rejects.toThrow(BIG_TIP);
  });

  it("decision 5: .mov (video/quicktime) is allowed at upload and confirm", async () => {
    expect(validateUpload({ name: "IMG_0001.MOV", type: "video/quicktime", size: 40 * MB })).toBeNull();
    const consent = await started();
    const mov = `${BRAND_ID}/${consent.id}/11111111-1111-4111-8111-111111111111.mov`;
    const { storage } = memoryClipStorage({ [mov]: { size: 40 * MB, contentType: "video/quicktime" } });
    const ticket = await prepareUpload(consent.id, { name: "IMG_0001.MOV", type: "video/quicktime", size: 40 * MB }, {
      store: mem.store,
      storage,
      now: LATER,
    });
    expect(ticket.path).toMatch(/\.mov$/);
    expect((await confirmUpload(consent.id, mov, { store: mem.store, storage, now: LATER })).clip_path).toBe(mov);
  });

  it("validates type and size on the server", () => {
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: 40 * MB })).toBeNull();
    expect(validateUpload({ name: "clip.webm", type: "video/webm", size: 30 * MB })).toBeNull();
    expect(validateUpload({ name: "clip.avi", type: "video/x-msvideo", size: 20 * MB })).toBe(
      "Upload an MP4, WebM or MOV video. On iPhone: Settings → Camera → Formats → Most Compatible.",
    );
    expect(validateUpload({ name: "clip.mp4", type: "video/mp4", size: 201 * MB })).toBe(BIG_TIP);
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
    await expect(confirmUpload(consent.id, huge, deps)).rejects.toThrow(BIG_TIP);
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

  describe("SF1: confirm re-checks the 30-minute window (Supabase upload tokens last 2 hours)", () => {
    async function uploaded() {
      const consent = await started(); // words expire 10:30
      const clip = `${BRAND_ID}/${consent.id}/11111111-1111-4111-8111-111111111111.mp4`;
      const { storage } = memoryClipStorage({ [clip]: { size: 40 * MB, contentType: "video/mp4" } });
      return { consent, clip, storage };
    }

    it("the grace for an in-flight upload is 2 minutes, in one constant", () => {
      expect(CONSENT_UPLOAD.confirm_grace_s).toBe(120);
    });

    it("confirm inside the grace (10:31:59) still counts", async () => {
      const { consent, clip, storage } = await uploaded();
      const saved = await confirmUpload(consent.id, clip, { store: mem.store, storage, now: new Date("2026-11-22T10:31:59.000Z") });
      expect(saved.clip_path).toBe(clip);
    });

    it("confirm after words expiry + grace (10:32) is refused and nothing is saved", async () => {
      const { consent, clip, storage } = await uploaded();
      await expect(
        confirmUpload(consent.id, clip, { store: mem.store, storage, now: new Date("2026-11-22T10:32:00.000Z") }),
      ).rejects.toThrow("The 3 words have expired. Press “New words”, then record again saying the new words.");
      expect((await mem.store.getConsent(consent.id))?.clip_path).toBeNull();
    });

    it("a token used near the end of its 2 hours (11:59) is refused", async () => {
      const { consent, clip, storage } = await uploaded();
      await expect(
        confirmUpload(consent.id, clip, { store: mem.store, storage, now: new Date("2026-11-22T11:59:00.000Z") }),
      ).rejects.toThrow("The 3 words have expired.");
    });
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

  it("bad clip: fails with tips; decision 6: the reshoot tips 'email' goes to the admins only (mock outbox, not sent)", async () => {
    const { consent, storage } = await withClip("consent-bad.mp4");
    mem.setContactEmail("client@clinic.example");
    const result = await checkConsentClip(consent.id, {
      store: mem.store,
      storage,
      claude,
      fixtureName: "consent-bad.mp4",
      adminEmails: ["admin@studio.example"],
    });
    expect(result.passed).toBe(false);
    expect(mem.outbox).toHaveLength(1);
    expect(mem.outbox[0]).toMatchObject({
      kind: "reshoot_tips",
      to_email: "admin@studio.example",
      consent_id: consent.id,
      brand_id: BRAND_ID,
      status: "mocked",
      subject: "Reshoot needed for Dr Ayesha Clinic (forward these tips to the client)",
    });
    expect(mem.outbox[0].body).toContain("Only you should be in the clip.");
    expect(mem.outbox[0].body).toContain("Face a window in daylight");
  });

  it("decision 5: a .mov is converted to mp4, checked as the mp4, and the mp4 becomes the clip", async () => {
    const consent = await started();
    const mov = `${BRAND_ID}/${consent.id}/44444444-4444-4444-8444-444444444444.mov`;
    const { storage, files, uploaded, removed } = memoryClipStorage({
      [mov]: { size: 1 * MB, contentType: "video/quicktime", fixture: "consent-good.mov" },
    });
    await mem.store.updateConsent(consent.id, { clip_path: mov });
    const result = await checkConsentClip(consent.id, { store: mem.store, storage, claude, fixtureName: "consent-good.mov" });

    const saved = await mem.store.getConsent(consent.id);
    expect(saved?.clip_path).toMatch(new RegExp(`^${BRAND_ID}/${consent.id}/[0-9a-f-]{36}\\.mp4$`));
    expect(result.passed).toBe(true);
    expect(result.clip_path).toBe(saved?.clip_path);
    expect(saved?.clip_checks?.clip_path).toBe(saved?.clip_path);
    expect(files[saved!.clip_path!].contentType).toBe("video/mp4");
    expect([...uploaded[saved!.clip_path!].subarray(4, 8)].map((b) => String.fromCharCode(b)).join("")).toBe("ftyp");
    expect(removed).toEqual([mov]);
    // Approval now works on the converted clip.
    await expect(approveConsent(consent.id, "", { store: mem.store })).resolves.toBeTruthy();
  });

  it("decision 5: a corrupt .mov keeps the 'Most Compatible' tip and nothing changes", async () => {
    const consent = await started();
    const mov = `${BRAND_ID}/${consent.id}/44444444-4444-4444-8444-444444444444.mov`;
    const { storage, uploaded } = memoryClipStorage({
      [mov]: { size: 1 * MB, contentType: "video/quicktime", fixture: "consent-corrupt.mov" },
    });
    await mem.store.updateConsent(consent.id, { clip_path: mov });
    await expect(
      checkConsentClip(consent.id, { store: mem.store, storage, claude, fixtureName: "consent-corrupt.mov" }),
    ).rejects.toThrow(
      "We couldn't read this .mov video. On iPhone: Settings → Camera → Formats → Most Compatible, then record again.",
    );
    const saved = await mem.store.getConsent(consent.id);
    expect(saved?.clip_path).toBe(mov);
    expect(saved?.clip_checks).toBeNull();
    expect(Object.keys(uploaded)).toEqual([]);
  });

  it("decision 2 job: status running then done; results saved on the clip", async () => {
    const { consent, storage } = await withClip("consent-good.mp4");
    const seen: (string | null | undefined)[] = [];
    const update = mem.store.updateConsent.bind(mem.store);
    mem.store.updateConsent = async (id, patch, only) => {
      if ("clip_check_status" in patch) seen.push(patch.clip_check_status);
      return update(id, patch, only);
    };
    const clipPath = (await mem.store.getConsent(consent.id))!.clip_path!;
    const outcome = await runClipCheckJob(consent.id, clipPath, { store: mem.store, storage, claude, fixtureName: "consent-good.mp4" });
    expect(outcome).toEqual({ status: "done", passed: true });
    expect(seen).toEqual(["running", "done"]);
    expect(await mem.store.getConsent(consent.id)).toMatchObject({ clip_check_status: "done", clip_check_error: null });
  });

  it("decision 2 job: a plain failure (corrupt .mov) → status failed with the tip, not thrown (no pointless retry)", async () => {
    const consent = await started();
    const mov = `${BRAND_ID}/${consent.id}/44444444-4444-4444-8444-444444444444.mov`;
    const { storage } = memoryClipStorage({ [mov]: { size: MB, contentType: "video/quicktime", fixture: "consent-corrupt.mov" } });
    await mem.store.updateConsent(consent.id, { clip_path: mov });
    const outcome = await runClipCheckJob(consent.id, mov, { store: mem.store, storage, claude });
    expect(outcome).toEqual({ status: "failed" });
    expect(await mem.store.getConsent(consent.id)).toMatchObject({
      clip_check_status: "failed",
      clip_check_error: "We couldn't read this .mov video. On iPhone: Settings → Camera → Formats → Most Compatible, then record again.",
    });
  });

  it("SF4: the result names the clip it measured", async () => {
    const { consent, storage } = await withClip("consent-good.mp4");
    const result = await checkConsentClip(consent.id, { store: mem.store, storage, claude, fixtureName: "consent-good.mp4" });
    expect(result.clip_path).toBe((await mem.store.getConsent(consent.id))?.clip_path);
  });

  it("SF4: a re-upload while the check runs cannot inherit the old pass", async () => {
    const { consent, storage } = await withClip("consent-good.mp4");
    const newer = `${BRAND_ID}/${consent.id}/99999999-9999-4999-8999-999999999999.mp4`;
    const download = storage.download.bind(storage);
    // A second tab confirms a new clip while the first check is downloading.
    storage.download = async (p: string) => {
      const bytes = await download(p);
      await mem.store.updateConsent(consent.id, { clip_path: newer, clip_checks: null });
      return bytes;
    };
    await expect(
      checkConsentClip(consent.id, { store: mem.store, storage, claude, fixtureName: "consent-good.mp4" }),
    ).rejects.toThrow("A new clip was uploaded while this one was being checked. Check the new clip.");
    const saved = await mem.store.getConsent(consent.id);
    expect(saved?.clip_path).toBe(newer);
    expect(saved?.clip_checks).toBeNull();
    await expect(approveConsent(consent.id, "", { store: mem.store })).rejects.toThrow("The clip checks must pass");
  });
});

describe("decision 2: the clip-check job (lib function the Trigger task calls)", () => {
  const claude = { mock: true, logUsage: async () => {} };

  it("a newer clip was uploaded since the job was queued: skipped, nothing touched", async () => {
    const consent = await started();
    await mem.store.updateConsent(consent.id, { clip_path: `${BRAND_ID}/${consent.id}/new.mp4` });
    const { storage } = memoryClipStorage();
    const outcome = await runClipCheckJob(consent.id, `${BRAND_ID}/${consent.id}/old.mp4`, { store: mem.store, storage, claude });
    expect(outcome).toEqual({ status: "skipped" });
    expect((await mem.store.getConsent(consent.id))?.clip_check_status).toBeUndefined();
  });

  it("an unexpected error: status failed with a plain sentence, then thrown so the task retries", async () => {
    const consent = await started();
    const clip = `${BRAND_ID}/${consent.id}/11111111-1111-4111-8111-111111111111.mp4`;
    await mem.store.updateConsent(consent.id, { clip_path: clip });
    const { storage } = memoryClipStorage(); // no file behind the path: download throws a raw Error
    await expect(runClipCheckJob(consent.id, clip, { store: mem.store, storage, claude })).rejects.toThrow("no such object");
    expect(await mem.store.getConsent(consent.id)).toMatchObject({
      clip_check_status: "failed",
      clip_check_error: "The clip check stopped unexpectedly. Press “Run checks” to try again.",
    });
  });
});

describe("admin approval", () => {
  async function checked(passed: boolean, checkedPath?: string) {
    const consent = await started();
    const clipPath = `${BRAND_ID}/${consent.id}/c.mp4`;
    await mem.store.updateConsent(consent.id, {
      clip_path: clipPath,
      clip_checks: {
        passed,
        clip_path: checkedPath ?? clipPath,
        checked_at: NOW.toISOString(),
        checks: [],
        tips: [],
        measurements: {} as never,
      },
    });
    return consent;
  }

  it("SF4: a pass for a different clip (or one with no clip_path) does not count", async () => {
    const other = await checked(true, `${BRAND_ID}/elsewhere/old.mp4`);
    await expect(approveConsent(other.id, "", { store: mem.store })).rejects.toThrow(
      "The clip checks must pass before approval. Ask for a reshoot.",
    );
    const legacy = await started();
    await mem.store.updateConsent(legacy.id, {
      clip_path: `${BRAND_ID}/${legacy.id}/c.mp4`,
      clip_checks: { passed: true, checked_at: NOW.toISOString(), checks: [], tips: [], measurements: {} as never },
    });
    await expect(approveConsent(legacy.id, "", { store: mem.store })).rejects.toThrow("The clip checks must pass");
    expect(mem.avatars).toHaveLength(0);
  });

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
