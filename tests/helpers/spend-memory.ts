import type { SpendKind, SpendStore } from "@/lib/heygen-spend";

// In-memory stand-in for provider_usage + app_settings (heygen_daily_caps,
// renders_paused) + the spend-cap alerts in email_outbox, mirroring the
// reserve_heygen_spend database function and the email_outbox dedupe_key.

export type SpendRow = {
  id: string;
  provider: "heygen";
  /** 'renders_resumed' = the audit row of an admin un-pause (p4-fix e), never counted. */
  kind: SpendKind | "renders_resumed";
  avatar_id: string | null;
  video_id: string | null;
  status: "reserved" | "succeeded" | "failed";
  cost_usd: number;
  note: string | null;
  /** Decision (a): mock rows are recorded but never count toward the cap. */
  mock: boolean;
  created_at: string;
};

export type AlertRow = { dedupe_key: string; to_email: string; kind: "spend_cap_alert"; subject: string; body: string; status: "mocked" };

export function memorySpendStore(
  settings: { rendersPaused?: boolean; caps?: Partial<Record<SpendKind, number>> | null; pausedBrands?: string[] } = {},
) {
  const rows: SpendRow[] = [];
  const alerts: AlertRow[] = [];
  let n = 0;
  const store: SpendStore = {
    async getSettings() {
      return { rendersPaused: settings.rendersPaused ?? false, caps: settings.caps ?? null };
    },
    async isBrandPaused(brandId) {
      return (settings.pausedBrands ?? []).includes(brandId);
    },
    async reserve(row) {
      const used = rows.filter((r) => r.kind === row.kind && r.created_at >= row.since && !r.mock).length;
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
        mock: row.note === "mock",
        created_at: new Date().toISOString(),
      });
      return id;
    },
    async finish(id, status, note) {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, { status, note: note ?? row.note });
    },
    async pauseRenders() {
      settings.rendersPaused = true;
    },
    // Mirrors resume_renders (migration 20261122140000): flag off + one audit row, or nothing.
    async resumeRenders(adminEmail) {
      if (!settings.rendersPaused) return "not_paused";
      settings.rendersPaused = false;
      rows.push({
        id: `50000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
        provider: "heygen",
        kind: "renders_resumed",
        avatar_id: null,
        video_id: null,
        status: "succeeded",
        cost_usd: 0,
        note: `renders resumed by ${adminEmail} after checking today's HeyGen spend`,
        mock: false,
        created_at: new Date().toISOString(),
      });
      return "resumed";
    },
    async queueCapAlert(alert) {
      let added = 0;
      for (const to of alert.recipients) {
        const key = `${alert.dedupeKey}:${to}`;
        if (alerts.some((a) => a.dedupe_key === key)) continue;
        alerts.push({ dedupe_key: key, to_email: to, kind: "spend_cap_alert", subject: alert.subject, body: alert.body, status: "mocked" });
        added += 1;
      }
      return added;
    },
  };
  /** Pretend earlier REAL (non-mock) guarded calls happened at `at`. */
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
        mock: false,
        created_at: at,
      });
    }
  };
  return { store, rows, alerts, settings, seed };
}
