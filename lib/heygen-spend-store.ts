import "server-only";
import type { SpendKind, SpendStore } from "@/lib/heygen-spend";
import { createAdminClient } from "@/lib/supabase/admin";

// Supabase version of SpendStore (provider_usage + app_settings). Uses the
// SECRET key: call only from background tasks or after requireAdmin().
// Tests use tests/helpers/spend-memory.ts.

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[spend] ${what}: ${error?.message ?? "no data"}`);
}

export function createSpendStore(): SpendStore {
  const db = createAdminClient();
  return {
    async getSettings() {
      const { data, error } = await db
        .from("app_settings")
        .select("key, value")
        .in("key", ["renders_paused", "heygen_daily_caps"]);
      if (error) fail("load settings", error);
      const byKey = new Map((data ?? []).map((row) => [row.key as string, row.value as unknown]));
      const caps = byKey.get("heygen_daily_caps");
      return {
        // Anything other than a plain false counts as paused (fail safe).
        rendersPaused: byKey.has("renders_paused") ? byKey.get("renders_paused") !== false : false,
        caps: caps && typeof caps === "object" ? (caps as Partial<Record<SpendKind, number>>) : null,
      };
    },
    async isBrandPaused(brandId) {
      const { data, error } = await db.from("brands").select("paused").eq("id", brandId).maybeSingle();
      if (error) fail("load brand pause", error);
      // A missing brand counts as paused (fail safe).
      return data ? data.paused !== false : true;
    },
    async reserve(row) {
      const { data, error } = await db.rpc("reserve_heygen_spend", {
        p_kind: row.kind,
        p_since: row.since,
        p_cap: row.cap,
        p_avatar_id: row.avatarId,
        p_video_id: row.videoId,
        p_note: row.note,
      });
      if (error) fail("reserve", error);
      return (data as string | null) ?? null;
    },
    async finish(id, status, note) {
      const patch: { status: string; note?: string } = { status };
      if (note !== null) patch.note = note;
      const { error } = await db.from("provider_usage").update(patch).eq("id", id);
      if (error) fail("finish", error);
    },
  };
}
