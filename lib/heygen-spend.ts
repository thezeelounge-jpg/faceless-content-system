import { HEYGEN_DAILY_CAP_DEFAULTS } from "@/lib/config";
import { PlainError } from "@/lib/plain-error";

// The HeyGen spend guard. Every HeyGen call that can cost money goes through
// guardHeygenSpend (or withHeygenSpend) BEFORE the POST:
//   - create_twin: POST /v3/avatars (lib/twin.ts)
//   - render:      POST /v3/videos  (Phase 3 part B step 2)
// It refuses (plain error, nothing sent to HeyGen) when app_settings
// renders_paused is true, or when today's guarded calls of that kind (Asia/
// Karachi day) reached the cap in app_settings heygen_daily_caps (defaults in
// lib/config.ts). Otherwise it reserves a provider_usage row ('reserved'),
// which is marked 'succeeded' or 'failed' after the call. Every row counts
// toward the cap, failed ones too (a failed call may still have cost money).
// In mock mode the row is still written (cost 0, note 'mock') so QA can see it.
// This is provider spend, NOT the customer's plan slots (usage_ledger).

export type SpendKind = "create_twin" | "render";

export interface SpendStore {
  getSettings(): Promise<{ rendersPaused: boolean; caps: Partial<Record<SpendKind, number>> | null }>;
  /**
   * Atomically: if fewer than `cap` heygen rows of `kind` were created since
   * `since`, insert a 'reserved' row and return its id; else return null.
   */
  reserve(row: {
    kind: SpendKind;
    avatarId: string | null;
    videoId: string | null;
    since: string;
    cap: number;
    note: string | null;
  }): Promise<string | null>;
  finish(id: string, status: "succeeded" | "failed", note: string | null): Promise<void>;
}

export class SpendGuardError extends PlainError {
  constructor(message: string) {
    super(message);
    this.name = "SpendGuardError";
  }
}

const KIND_WORDS: Record<SpendKind, string> = { create_twin: "new twins", render: "videos" };

/** Pakistan has no daylight saving: the Karachi day starts at 19:00 UTC the evening before. */
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function karachiDayStart(now: Date): Date {
  const local = now.getTime() + KARACHI_OFFSET_MS;
  return new Date(local - (local % DAY_MS) - KARACHI_OFFSET_MS);
}

type GuardOptions = {
  kind: SpendKind;
  avatarId?: string | null;
  videoId?: string | null;
  /** The HeyGen client's mock flag: mock rows get cost 0 and note 'mock'. */
  mock: boolean;
  store: SpendStore;
  now?: Date;
};

/** Checks the pause switch and today's cap, then reserves a provider_usage row. Returns its id. */
export async function guardHeygenSpend(opts: GuardOptions): Promise<string> {
  const settings = await opts.store.getSettings();
  if (settings.rendersPaused) {
    throw new SpendGuardError("HeyGen work is paused (renders_paused is on). Nothing was sent to HeyGen.");
  }
  const configured = settings.caps?.[opts.kind];
  const cap = typeof configured === "number" && Number.isInteger(configured) && configured >= 0
    ? configured
    : HEYGEN_DAILY_CAP_DEFAULTS[opts.kind];
  const id = await opts.store.reserve({
    kind: opts.kind,
    avatarId: opts.avatarId ?? null,
    videoId: opts.videoId ?? null,
    since: karachiDayStart(opts.now ?? new Date()).toISOString(),
    cap,
    note: opts.mock ? "mock" : null,
  });
  if (!id) {
    throw new SpendGuardError(
      `Today's HeyGen limit for ${KIND_WORDS[opts.kind]} is reached (${cap} a day). Nothing was sent to HeyGen. Try again tomorrow, or raise heygen_daily_caps in Settings.`,
    );
  }
  return id;
}

/** guardHeygenSpend, then the call, then the row is marked succeeded or failed. */
export async function withHeygenSpend<T>(opts: GuardOptions, call: () => Promise<T>): Promise<T> {
  const id = await guardHeygenSpend(opts);
  let result: T;
  try {
    result = await call();
  } catch (error) {
    const note = error instanceof PlainError ? error.message.slice(0, 300) : "failed (see server logs)";
    await opts.store.finish(id, "failed", note).catch(() => null);
    throw error;
  }
  // The paid call worked: a bookkeeping failure must not hide that (the caller
  // still has to save the HeyGen id). The row then stays 'reserved', which still counts.
  await opts.store.finish(id, "succeeded", null).catch(() => null);
  return result;
}
