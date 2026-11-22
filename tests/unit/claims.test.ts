import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeygenClient } from "@/lib/heygen";
import {
  CLAIM_CLEAR_WAIT_S,
  TWIN_CLAIM_CLEAR_WAIT_S,
  canClearClaim,
  claimWaitS,
  clearStuckClaim,
  clearableAt,
  tooSoonMessage,
  withClearTiming,
} from "@/lib/claims";
import { prepareLikenessTest } from "@/lib/likeness";
import { RENDER, TWIN_POLL_MAX_S } from "@/lib/qa/config";
import { createPostRender } from "@/lib/render";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { CLEARED_VIDEO_ERROR, memoryClaimStore } from "@/tests/helpers/claims-memory";
import { memoryVideoStore } from "@/tests/helpers/video-memory";

// Decision (b) (Rowan): admin-only "Clear stuck claim" for
// - render claims: videos.render_started_at set, no heygen_video_id (post videos)
// - likeness-test rows holding a claim (p3-fix1 SF6 made those block re-testing the engine)
// - twin claims: avatars.create_started_at set, no heygen_group_id
// It needs an explicit "I checked the HeyGen dashboard" confirm, and writes an
// audit row (provider_usage kind 'claim_cleared') in the same database step.

const requireAdmin = vi.fn();
let mem: ReturnType<typeof memoryVideoStore>;
let claimMem: ReturnType<typeof memoryClaimStore>;

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/claims-store", () => ({ createClaimStore: () => claimMem.claims }));

const { clearStuckClaimAction } = await import("@/app/admin/claims-actions");

const ADMIN = "admin@example.com";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
// p4-fix c1: a claim may be cleared only after the 30-minute wait (or once failed).
let STARTED: string;
let YOUNG: string;
const idle = { status: "idle" as const, message: "" };
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  STARTED = minutesAgo(31);
  YOUNG = minutesAgo(5);
  mem = memoryVideoStore();
  claimMem = memoryClaimStore(mem);
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: ADMIN, isAdmin: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A post video whose POST answer was lost: claim held, no HeyGen id. */
async function stuckPostVideo(startedAt = STARTED, scriptId: string | null = null) {
  const video = await mem.store.insertVideo({
    brand_id: BRAND_ID,
    script_id: scriptId,
    avatar_id: null,
    kind: "post",
    engine: "avatar_v",
    spoken_words: 12,
  });
  return (await mem.store.updateVideo(video.id, { status: "rendering", render_started_at: startedAt }))!;
}

/** A likeness-test row that failed after reaching HeyGen (claim held, only 5 minutes old), for avatar_v. */
async function stuckLikenessRow() {
  const { avatar } = await mem.seedReadyTwin({ status: "likeness_test" });
  const inserted = await mem.store.insertVideo({
    brand_id: BRAND_ID,
    script_id: null,
    avatar_id: avatar.id,
    kind: "likeness_test",
    engine: "avatar_v",
    spoken_words: 30,
  });
  const video = (await mem.store.updateVideo(inserted.id, {
    status: "failed",
    render_started_at: YOUNG,
    error: "HeyGen did not answer in time.",
  }))!;
  return { avatar, video };
}

/** A twin whose create POST answer was lost: claim held, no group id. */
/** Default: just past the twin wait (p4-b1 5c: TWIN_POLL_MAX_S, not 30 minutes), so it may be cleared. */
async function stuckTwin(startedAt = minutesAgo(TWIN_POLL_MAX_S / 60 + 1)) {
  const consent = await mem.consentMem.store.insertConsent({
    brand_id: BRAND_ID,
    person_legal_name: "Ayesha Khan",
    checkbox_at: new Date().toISOString(),
    words: ["a", "b", "c"],
    words_expire_at: new Date(Date.now() + 1_800_000).toISOString(),
    ip: null,
    user_agent: null,
  });
  const avatar = await mem.consentMem.store.insertAvatar({ brand_id: BRAND_ID, consent_id: consent.id, status: "training" });
  await mem.consentMem.store.updateAvatar(avatar.id, { create_started_at: startedAt, error: "A twin may already exist on HeyGen." });
  return avatar;
}

const confirmed = (target: "video" | "twin", id: string) => ({ target, id, confirmCheckedHeygen: true as const });

describe("clearStuckClaim (lib)", () => {
  it("render claim: cleared (no claim, status failed, plain note) and audited", async () => {
    const video = await stuckPostVideo();
    const message = await clearStuckClaim(confirmed("video", video.id), { claims: claimMem.claims, adminEmail: ADMIN });
    expect(message).toBe("Claim cleared. The video can be made again (this is logged).");
    expect(mem.videos[0]).toMatchObject({ render_started_at: null, heygen_video_id: null, status: "failed", error: CLEARED_VIDEO_ERROR });
    expect(claimMem.audit).toEqual([
      expect.objectContaining({ kind: "claim_cleared", video_id: video.id, avatar_id: null, note: `render claim cleared by ${ADMIN} after checking HeyGen` }),
    ]);
  });

  it("likeness-test row: cleared and audited, and the engine can be tested again (a new row, no reuse of the cleared one)", async () => {
    const { avatar, video } = await stuckLikenessRow();
    const heygen = createHeygenClient({ mock: true, apiKey: "dummy" });
    // Before: SF6 reuses the claimed row, so renderVideo would refuse ("check the HeyGen dashboard").
    expect((await prepareLikenessTest(avatar.id, { store: mem.consentMem.store, videos: mem.store, heygen })).map((v) => v.id)).toContain(video.id);
    const message = await clearStuckClaim(confirmed("video", video.id), { claims: claimMem.claims, adminEmail: ADMIN });
    expect(message).toBe("Claim cleared. That engine can be tested again (this is logged).");
    expect(claimMem.audit[0]).toMatchObject({ video_id: video.id, note: `likeness_test claim cleared by ${ADMIN} after checking HeyGen` });
    const after = await prepareLikenessTest(avatar.id, { store: mem.consentMem.store, videos: mem.store, heygen });
    const avatarV = after.find((v) => v.engine === "avatar_v")!;
    expect(avatarV.id).not.toBe(video.id);
    expect(avatarV).toMatchObject({ status: "queued", render_started_at: null });
  });

  it("twin claim: cleared (create_started_at null, error cleared) and audited", async () => {
    const avatar = await stuckTwin();
    const message = await clearStuckClaim(confirmed("twin", avatar.id), { claims: claimMem.claims, adminEmail: ADMIN });
    expect(message).toBe("Claim cleared. The twin can be created again (this is logged).");
    expect(mem.consentMem.avatars[0]).toMatchObject({ create_started_at: null, heygen_group_id: null, error: null });
    expect(claimMem.audit).toEqual([
      expect.objectContaining({ kind: "claim_cleared", avatar_id: avatar.id, video_id: null, note: `twin claim cleared by ${ADMIN} after checking HeyGen` }),
    ]);
  });

  it("refuses without the explicit confirm, and changes nothing", async () => {
    const video = await stuckPostVideo();
    await expect(
      clearStuckClaim({ target: "video", id: video.id, confirmCheckedHeygen: false } as never, { claims: claimMem.claims, adminEmail: ADMIN }),
    ).rejects.toThrow("Tick “I checked the HeyGen dashboard” first. Nothing was changed.");
    expect(mem.videos[0].render_started_at).toBe(STARTED);
    expect(claimMem.audit).toEqual([]);
  });

  it("never clears a claim that has a HeyGen id (that video exists and may cost money)", async () => {
    const video = await stuckPostVideo();
    await mem.store.updateVideo(video.id, { heygen_video_id: "hg_123" });
    await expect(clearStuckClaim(confirmed("video", video.id), { claims: claimMem.claims, adminEmail: ADMIN })).rejects.toThrow(
      "There is no stuck claim to clear here. Nothing was changed.",
    );
    expect(mem.videos[0]).toMatchObject({ render_started_at: STARTED, heygen_video_id: "hg_123" });
    expect(claimMem.audit).toEqual([]);
  });
});

describe("c1: the wait before a claim can be cleared (Sunny's blocker)", () => {
  const NOW = new Date("2026-11-22T10:00:00.000Z");
  const at = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

  it("the wait is the render wait (RENDER.poll_max_s = 30 minutes)", () => {
    expect(CLAIM_CLEAR_WAIT_S).toBe(RENDER.poll_max_s);
    expect(CLAIM_CLEAR_WAIT_S).toBe(1800);
  });

  it("lib refuses a 5-minute-old claim itself (the store's clear is never called), with the clear-after time", async () => {
    const video = await stuckPostVideo(YOUNG);
    const clear = vi.spyOn(claimMem.claims, "clear");
    await expect(clearStuckClaim(confirmed("video", video.id), { claims: claimMem.claims, adminEmail: ADMIN })).rejects.toThrow(
      tooSoonMessage(clearableAt(YOUNG)),
    );
    expect(clear).not.toHaveBeenCalled();
    expect(mem.videos[0]).toMatchObject({ status: "rendering", render_started_at: YOUNG });
    expect(claimMem.audit).toEqual([]);
  });

  it("if the database still says 'too_soon' (clock skew), the admin gets the same plain refusal", async () => {
    const video = await stuckPostVideo(STARTED);
    claimMem.claims.clear = async () => "too_soon";
    await expect(clearStuckClaim(confirmed("video", video.id), { claims: claimMem.claims, adminEmail: ADMIN })).rejects.toThrow(
      tooSoonMessage(clearableAt(STARTED)),
    );
  });

  it("p4-b1 5c: twins wait the whole twin poll (TWIN_POLL_MAX_S, about 27.5 h), not 30 minutes", () => {
    expect(TWIN_CLAIM_CLEAR_WAIT_S).toBe(TWIN_POLL_MAX_S);
    expect(TWIN_POLL_MAX_S).toBe(60 + 120 + 240 + 480 + 960 + 54 * 1800); // 99060 s
    expect(claimWaitS("twin")).toBe(TWIN_POLL_MAX_S);
    expect(claimWaitS("video")).toBe(RENDER.poll_max_s);
  });

  it("p4-b1 5c: a 31-minute-old twin claim is now TOO SOON (lib refuses, store never called); after the twin wait it clears", async () => {
    const twin = await stuckTwin(minutesAgo(31));
    const clear = vi.spyOn(claimMem.claims, "clear");
    const startedAt = mem.consentMem.avatars[0].create_started_at!;
    await expect(clearStuckClaim(confirmed("twin", twin.id), { claims: claimMem.claims, adminEmail: ADMIN })).rejects.toThrow(
      tooSoonMessage(clearableAt(startedAt, "twin"), true),
    );
    expect(clear).not.toHaveBeenCalled();
    expect(mem.consentMem.avatars[0].create_started_at).toBe(startedAt);
    mem.consentMem.avatars[0].create_started_at = minutesAgo(TWIN_POLL_MAX_S / 60 + 1);
    expect(await clearStuckClaim(confirmed("twin", twin.id), { claims: claimMem.claims, adminEmail: ADMIN })).toContain("Claim cleared");
  });

  it("p4-b1 5c: canClearClaim for twins: false at 31 min and just before the twin wait, true after it or once failed", () => {
    const twin = (minutes: number, status = "consent_pending") => ({ startedAt: at(minutes), status, target: "twin" as const });
    expect(canClearClaim(twin(31), NOW)).toBe(false);
    expect(canClearClaim(twin(TWIN_POLL_MAX_S / 60 - 1), NOW)).toBe(false);
    expect(canClearClaim(twin(TWIN_POLL_MAX_S / 60), NOW)).toBe(true);
    expect(canClearClaim(twin(1, "failed"), NOW)).toBe(true);
  });

  it("canClearClaim: only after 30 minutes, or at once when the row already failed", () => {
    expect(canClearClaim({ startedAt: at(5), status: "rendering" }, NOW)).toBe(false);
    expect(canClearClaim({ startedAt: at(29), status: "rendering" }, NOW)).toBe(false);
    expect(canClearClaim({ startedAt: at(30), status: "rendering" }, NOW)).toBe(true);
    expect(canClearClaim({ startedAt: at(31), status: "training" }, NOW)).toBe(true);
    expect(canClearClaim({ startedAt: at(1), status: "failed" }, NOW)).toBe(true);
  });

  it("the list marks the young claim (no button, 'can clear after') and lets the old one be cleared", () => {
    const base = { target: "video" as const, kind: "render" as const, brandId: BRAND_ID, label: "Post video" };
    const views = withClearTiming(
      [
        { ...base, id: "young", startedAt: at(5), status: "rendering" },
        { ...base, id: "old", startedAt: at(31), status: "rendering" },
        { ...base, id: "failed", startedAt: at(2), status: "failed" },
      ],
      NOW,
    );
    expect(views.map((v) => [v.id, v.canClear, v.clearableAt])).toEqual([
      ["young", false, new Date(NOW.getTime() + 25 * 60_000).toISOString()],
      ["old", true, new Date(NOW.getTime() - 60_000).toISOString()],
      ["failed", true, new Date(NOW.getTime() + 28 * 60_000).toISOString()],
    ]);
  });
});

describe("d: clearing a post render puts the post back to approved; the cleared row is retired", () => {
  it("team_review → approved (reason cleared) in the same step; 'Make video' then makes a NEW row", async () => {
    await mem.seedReadyTwin();
    const { scriptId, postId } = mem.seedApprovedPost({ postStatus: "team_review" });
    mem.posts[0].status_reason = "The video could not be made. The team will look at it.";
    const video = await stuckPostVideo(STARTED, scriptId);
    await clearStuckClaim(confirmed("video", video.id), { claims: claimMem.claims, adminEmail: ADMIN });
    expect(mem.posts[0]).toMatchObject({ id: postId, status: "approved", status_reason: null });
    // Retired: never claimed again; a new render uses a new row.
    expect(await mem.store.claimRenderSlot(video.id, 10)).toBe("taken");
    const next = await createPostRender(postId, { videos: mem.store });
    expect(next.id).not.toBe(video.id);
  });

  it("a likeness-test clear touches no post", async () => {
    mem.seedApprovedPost({ postStatus: "team_review" });
    const { video } = await stuckLikenessRow();
    await clearStuckClaim(confirmed("video", video.id), { claims: claimMem.claims, adminEmail: ADMIN });
    expect(mem.posts[0].status).toBe("team_review");
  });
});

describe("clearStuckClaimAction (admin → Clear stuck claim)", () => {
  it("a non-admin is stopped before anything runs", async () => {
    const video = await stuckPostVideo();
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(
      clearStuckClaimAction(idle, form({ target: "video", id: video.id, confirm_checked_heygen: "yes" })),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mem.videos[0].render_started_at).toBe(STARTED);
    expect(claimMem.audit).toEqual([]);
  });

  it("no confirm box → plain refusal, nothing changed", async () => {
    const video = await stuckPostVideo();
    expect(await clearStuckClaimAction(idle, form({ target: "video", id: video.id }))).toEqual({
      status: "error",
      message: "Tick “I checked the HeyGen dashboard” first. Nothing was changed.",
    });
    expect(mem.videos[0].render_started_at).toBe(STARTED);
    expect(claimMem.audit).toEqual([]);
  });

  it("bad input (unknown target, not a uuid) → plain refusal", async () => {
    expect(await clearStuckClaimAction(idle, form({ target: "post", id: "x", confirm_checked_heygen: "yes" }))).toEqual({
      status: "error",
      message: "That claim was not found. Nothing was changed.",
    });
  });

  it("clears and audits a render claim, with the admin's email in the audit", async () => {
    const video = await stuckPostVideo();
    const result = await clearStuckClaimAction(idle, form({ target: "video", id: video.id, confirm_checked_heygen: "yes" }));
    expect(result).toEqual({ status: "ok", message: "Claim cleared. The video can be made again (this is logged)." });
    expect(mem.videos[0].render_started_at).toBeNull();
    expect(claimMem.audit[0].note).toContain(ADMIN);
  });

  it("clears and audits a likeness-test row and a twin claim", async () => {
    const { video } = await stuckLikenessRow();
    const avatar = await stuckTwin();
    expect((await clearStuckClaimAction(idle, form({ target: "video", id: video.id, confirm_checked_heygen: "yes" }))).status).toBe("ok");
    expect((await clearStuckClaimAction(idle, form({ target: "twin", id: avatar.id, confirm_checked_heygen: "yes" }))).status).toBe("ok");
    expect(claimMem.audit.map((a) => [a.video_id, a.avatar_id])).toEqual([
      [video.id, null],
      [null, avatar.id],
    ]);
  });

  it("c1: a 5-minute-old claim is refused through the Server Action with 'can be cleared after HH:MM'; nothing changed", async () => {
    const video = await stuckPostVideo(YOUNG);
    const result = await clearStuckClaimAction(idle, form({ target: "video", id: video.id, confirm_checked_heygen: "yes" }));
    expect(result).toEqual({ status: "error", message: tooSoonMessage(clearableAt(YOUNG)) });
    expect(result.message).toMatch(/^HeyGen may still be making this\. It can be cleared after \d\d:\d\d \(Karachi time\)\. Nothing was changed\.$/);
    expect(mem.videos[0]).toMatchObject({ status: "rendering", render_started_at: YOUNG });
    expect(claimMem.audit).toEqual([]);
  });

  it("c1: a 31-minute-old claim clears through the Server Action", async () => {
    const video = await stuckPostVideo(minutesAgo(31));
    expect((await clearStuckClaimAction(idle, form({ target: "video", id: video.id, confirm_checked_heygen: "yes" }))).status).toBe("ok");
    expect(mem.videos[0].render_started_at).toBeNull();
  });

  it("a store failure gives a plain message (no technical detail)", async () => {
    const video = await stuckPostVideo();
    claimMem.claims.clear = async () => {
      throw new Error("[claims] clear: connection refused");
    };
    expect(await clearStuckClaimAction(idle, form({ target: "video", id: video.id, confirm_checked_heygen: "yes" }))).toEqual({
      status: "error",
      message: "Something went wrong. Please try again in a minute.",
    });
  });
});
