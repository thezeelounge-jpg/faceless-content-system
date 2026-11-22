import { claimWaitS, type ClaimStore, type ClearedClaim, type StuckClaim } from "@/lib/claims";
import type { memoryVideoStore } from "@/tests/helpers/video-memory";

// In-memory ClaimStore over the video + consent memory stores, mirroring the
// clear_stuck_claim database function (migration 20261122130000):
//   - a claim is cleared ONLY while it has no HeyGen id;
//   - only after claimWaitS(target) from the claim (twins: the twin poll maximum, p4-b1), or once the row failed
//     ('too_soon' otherwise, nothing written);
//   - a cleared video is retired (claim_cleared_at) and never claimed again;
//   - a cleared POST render puts its post back to 'approved' (from
//     'rendering' or 'team_review');
//   - every clear writes one audit row (provider_usage kind 'claim_cleared',
//     never counted toward a cap) in the same step.

export type ClaimAuditRow = {
  provider: "heygen";
  kind: "claim_cleared";
  status: "succeeded";
  cost_usd: 0;
  mock: false;
  video_id: string | null;
  avatar_id: string | null;
  note: string;
};

export const CLEARED_VIDEO_ERROR = "Claim cleared by an admin after checking HeyGen. Start it again when ready.";

export function memoryClaimStore(mem: ReturnType<typeof memoryVideoStore>) {
  const audit: ClaimAuditRow[] = [];
  const tooSoon = (startedAt: string, status: string, target: "video" | "twin") =>
    status !== "failed" && Date.now() - Date.parse(startedAt) < claimWaitS(target) * 1000;

  function stuck(): StuckClaim[] {
    const out: StuckClaim[] = [];
    for (const v of mem.videos) {
      if (v.render_started_at && !v.heygen_video_id) {
        out.push({
          target: "video",
          id: v.id,
          kind: v.kind === "likeness_test" ? "likeness_test" : "render",
          brandId: v.brand_id,
          label: v.kind === "likeness_test" ? `Likeness test (${v.engine ?? "?"})` : "Post video",
          startedAt: v.render_started_at,
          status: v.status,
        });
      }
    }
    for (const a of mem.consentMem.avatars) {
      if (a.create_started_at && !a.heygen_group_id) {
        out.push({ target: "twin", id: a.id, kind: "twin", brandId: a.brand_id, label: "Twin", startedAt: a.create_started_at, status: a.status });
      }
    }
    return out;
  }

  const claims: ClaimStore = {
    async listStuck() {
      return stuck();
    },
    async getStuck(target, id) {
      return stuck().find((c) => c.target === target && c.id === id) ?? null;
    },
    async clear(target, id, adminEmail) {
      let kind: ClearedClaim;
      if (target === "video") {
        const v = mem.videos.find((row) => row.id === id && row.render_started_at && !row.heygen_video_id);
        if (!v) return "none";
        if (tooSoon(v.render_started_at!, v.status, "video")) return "too_soon";
        Object.assign(v, { render_started_at: null, status: "failed", error: CLEARED_VIDEO_ERROR });
        mem.clearedAt.set(v.id, new Date().toISOString());
        kind = v.kind === "likeness_test" ? "likeness_test" : "render";
        if (v.kind === "post" && v.script_id) {
          const postId = mem.scripts.find((s) => s.id === v.script_id)?.post_id;
          const post = mem.posts.find((p) => p.id === postId);
          if (post && ["rendering", "team_review"].includes(post.status)) Object.assign(post, { status: "approved", status_reason: null });
        }
      } else {
        const a = mem.consentMem.avatars.find((row) => row.id === id && row.create_started_at && !row.heygen_group_id);
        if (!a) return "none";
        if (tooSoon(a.create_started_at!, a.status, "twin")) return "too_soon";
        Object.assign(a, { create_started_at: null, error: null });
        kind = "twin";
      }
      audit.push({
        provider: "heygen",
        kind: "claim_cleared",
        status: "succeeded",
        cost_usd: 0,
        mock: false,
        video_id: target === "video" ? id : null,
        avatar_id: target === "twin" ? id : null,
        note: `${kind} claim cleared by ${adminEmail} after checking HeyGen`,
      });
      return kind;
    },
  };
  return { claims, audit };
}
