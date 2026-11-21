import "server-only";
import type { ClaimStore, ClearedClaim, StuckClaim } from "@/lib/claims";
import { createAdminClient } from "@/lib/supabase/admin";

// Supabase version of ClaimStore. Uses the SECRET key: call only after
// requireAdmin(). Tests use tests/helpers/claims-memory.ts.

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[claims] ${what}: ${error?.message ?? "no data"}`);
}

export function createClaimStore(): ClaimStore {
  const db = createAdminClient();
  return {
    async listStuck() {
      const { data: videos, error } = await db
        .from("videos")
        .select("id, brand_id, kind, engine, render_started_at")
        .not("render_started_at", "is", null)
        .is("heygen_video_id", null)
        .order("render_started_at", { ascending: true });
      if (error) fail("list stuck renders", error);
      const { data: avatars, error: avatarError } = await db
        .from("avatars")
        .select("id, brand_id, create_started_at")
        .not("create_started_at", "is", null)
        .is("heygen_group_id", null)
        .order("create_started_at", { ascending: true });
      if (avatarError) fail("list stuck twins", avatarError);
      const out: StuckClaim[] = (videos ?? []).map((v) => ({
        target: "video",
        id: v.id,
        kind: v.kind === "likeness_test" ? "likeness_test" : "render",
        brandId: v.brand_id,
        label: v.kind === "likeness_test" ? `Likeness test (${v.engine ?? "?"})` : "Post video",
        startedAt: v.render_started_at,
      }));
      for (const a of avatars ?? []) {
        out.push({ target: "twin", id: a.id, kind: "twin", brandId: a.brand_id, label: "Twin", startedAt: a.create_started_at });
      }
      return out;
    },
    async clear(target, id, adminEmail) {
      const { data, error } = await db.rpc("clear_stuck_claim", { p_target: target, p_id: id, p_admin_email: adminEmail });
      if (error) fail("clear", error);
      return data as ClearedClaim | "none";
    },
  };
}
