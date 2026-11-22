import "server-only";
import type { ClaimStore, ClearedClaim, StuckClaim } from "@/lib/claims";
import { createAdminClient } from "@/lib/supabase/admin";

// Supabase version of ClaimStore. Uses the SECRET key: call only after
// requireAdmin(). Tests use tests/helpers/claims-memory.ts.
// Lists every stuck claim (with its status); lib/claims.ts withClearTiming
// decides which ones may be cleared yet (p4-fix c1).

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[claims] ${what}: ${error?.message ?? "no data"}`);
}

type VideoClaimRow = { id: string; brand_id: string; kind: string; engine: string | null; status: string; render_started_at: string };
type TwinClaimRow = { id: string; brand_id: string; status: string; create_started_at: string };

const videoClaim = (v: VideoClaimRow): StuckClaim => ({
  target: "video",
  id: v.id,
  kind: v.kind === "likeness_test" ? "likeness_test" : "render",
  brandId: v.brand_id,
  label: v.kind === "likeness_test" ? `Likeness test (${v.engine ?? "?"})` : "Post video",
  startedAt: v.render_started_at,
  status: v.status,
});

const twinClaim = (a: TwinClaimRow): StuckClaim => ({
  target: "twin",
  id: a.id,
  kind: "twin",
  brandId: a.brand_id,
  label: "Twin",
  startedAt: a.create_started_at,
  status: a.status,
});

export function createClaimStore(): ClaimStore {
  const db = createAdminClient();
  const videos = () =>
    db
      .from("videos")
      .select("id, brand_id, kind, engine, status, render_started_at")
      .not("render_started_at", "is", null)
      .is("heygen_video_id", null);
  const twins = () =>
    db.from("avatars").select("id, brand_id, status, create_started_at").not("create_started_at", "is", null).is("heygen_group_id", null);

  return {
    async listStuck() {
      const { data: videoRows, error } = await videos().order("render_started_at", { ascending: true });
      if (error) fail("list stuck renders", error);
      const { data: twinRows, error: twinError } = await twins().order("create_started_at", { ascending: true });
      if (twinError) fail("list stuck twins", twinError);
      return [...(videoRows ?? []).map(videoClaim), ...(twinRows ?? []).map(twinClaim)];
    },
    async getStuck(target, id) {
      if (target === "video") {
        const { data, error } = await videos().eq("id", id).maybeSingle();
        if (error) fail("load stuck render", error);
        return data ? videoClaim(data) : null;
      }
      const { data, error } = await twins().eq("id", id).maybeSingle();
      if (error) fail("load stuck twin", error);
      return data ? twinClaim(data) : null;
    },
    async clear(target, id, adminEmail) {
      const { data, error } = await db.rpc("clear_stuck_claim", { p_target: target, p_id: id, p_admin_email: adminEmail });
      if (error) fail("clear", error);
      return data as ClearedClaim | "none" | "too_soon";
    },
  };
}
