import type { SpendKind, SpendStore } from "@/lib/heygen-spend";

// In-memory stand-in for provider_usage + app_settings (heygen_daily_caps,
// renders_paused), mirroring the reserve_heygen_spend database function.

export type SpendRow = {
  id: string;
  provider: "heygen";
  kind: SpendKind;
  avatar_id: string | null;
  video_id: string | null;
  status: "reserved" | "succeeded" | "failed";
  cost_usd: number;
  note: string | null;
  created_at: string;
};

export function memorySpendStore(
  settings: { rendersPaused?: boolean; caps?: Partial<Record<SpendKind, number>> | null; pausedBrands?: string[] } = {},
) {
  const rows: SpendRow[] = [];
  let n = 0;
  const store: SpendStore = {
    async getSettings() {
      return { rendersPaused: settings.rendersPaused ?? false, caps: settings.caps ?? null };
    },
    async isBrandPaused(brandId) {
      return (settings.pausedBrands ?? []).includes(brandId);
    },
    async reserve(row) {
      const used = rows.filter((r) => r.kind === row.kind && r.created_at >= row.since).length;
      if (used >= row.cap) return null;
      const id = `50000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      rows.push({
        id,
        provider: "heygen",
        kind: row.kind,
        avatar_id: row.avatarId,
        video_id: row.videoId,
        status: "reserved",
        cost_usd: 0,
        note: row.note,
        created_at: new Date().toISOString(),
      });
      return id;
    },
    async finish(id, status, note) {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, { status, note: note ?? row.note });
    },
  };
  /** Pretend earlier guarded calls happened at `at`. */
  const seed = (kind: SpendKind, at: string, count = 1) => {
    for (let i = 0; i < count; i++) {
      rows.push({
        id: `seed-${++n}`,
        provider: "heygen",
        kind,
        avatar_id: null,
        video_id: null,
        status: "succeeded",
        cost_usd: 0,
        note: "seed",
        created_at: at,
      });
    }
  };
  return { store, rows, settings, seed };
}
