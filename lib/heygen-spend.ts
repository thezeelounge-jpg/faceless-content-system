import { z } from "zod";
import { parseAdminEmails } from "@/lib/admin";
import { redact } from "@/lib/admin-errors";
import { HEYGEN_DAILY_CAP_DEFAULTS } from "@/lib/config";
import { adminRecipients } from "@/lib/email-recipients";
import { PlainError } from "@/lib/plain-error";

// The HeyGen spend guard. Every HeyGen call that can cost money goes through
// guardHeygenSpend (or withHeygenSpend) BEFORE the POST:
//   - create_twin: POST /v3/avatars (lib/twin.ts)
//   - render:      POST /v3/videos  (Phase 3 part B step 2)
// It refuses (plain error, nothing sent to HeyGen) when app_settings
// renders_paused is true, when the client's brands.paused is true (renders
// must name their brand), or when today's guarded calls of that kind (Asia/
// Karachi day) reached the cap in app_settings heygen_daily_caps (defaults in
// lib/config.ts). Otherwise it reserves a provider_usage row ('reserved'),
// which is marked 'succeeded' or 'failed' after the call. Every REAL row
// counts toward the cap, failed ones too (a failed call may still have cost
// money). Mock rows are still written (cost 0, note 'mock', provider_usage.mock
// = true) but do NOT count (decision (a), p3-fix2).
// When the cap is hit (SF4): renders_paused → true and one mocked alert email
// per admin, once per kind per Karachi day; the call is refused. The only
// supported way back is Admin → Settings → "Resume renders" (resumeRenders,
// rpc resume_renders: flag off + audit row in one transaction, p4-fix e).
// This is provider spend (provider_usage), NOT the customer's plan slots (usage_ledger).

export type SpendKind = "create_twin" | "render";

export interface SpendStore {
  getSettings(): Promise<{ rendersPaused: boolean; caps: Partial<Record<SpendKind, number>> | null }>;
  /** brands.paused for this brand (a missing brand counts as paused: fail safe). */
  isBrandPaused(brandId: string): Promise<boolean>;
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
  /** SF4: app_settings renders_paused = true (stops all HeyGen work until an admin turns it off). */
  pauseRenders(): Promise<void>;
  /**
   * SF4: queue one mocked email_outbox alert per recipient, at most once per
   * `dedupeKey` (+ recipient), even when two runs hit the cap at once.
   * Returns how many NEW rows were written.
   */
  queueCapAlert(alert: { dedupeKey: string; recipients: string[]; subject: string; body: string }): Promise<number>;
  /**
   * p4-fix e: rpc resume_renders. renders_paused → false AND one audit row
   * (provider_usage kind 'renders_resumed', cost 0, never counted) in one
   * transaction. 'not_paused' = nothing written. The ONLY supported lift path.
   */
  resumeRenders(adminEmail: string): Promise<"resumed" | "not_paused">;
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
  /** The client. Required for renders, so brands.paused is always checked. */
  brandId?: string | null;
  avatarId?: string | null;
  videoId?: string | null;
  /** The HeyGen client's mock flag: mock rows get cost 0 and note 'mock'. */
  mock: boolean;
  store: SpendStore;
  now?: Date;
  /** Who gets the cap alert (SF4). Defaults to ADMIN_EMAILS. */
  adminEmails?: string[];
};

/** Checks the pause switch and today's cap, then reserves a provider_usage row. Returns its id. */
export async function guardHeygenSpend(opts: GuardOptions): Promise<string> {
  const settings = await opts.store.getSettings();
  if (settings.rendersPaused) {
    throw new SpendGuardError("HeyGen work is paused (renders_paused is on). Nothing was sent to HeyGen.");
  }
  // CLAUDE.md "Pause switches": brands.paused stops this client's HeyGen work too.
  if (!opts.brandId && opts.kind === "render") {
    throw new SpendGuardError("A render needs its client, so the pause switch can be checked. Nothing was sent to HeyGen.");
  }
  if (opts.brandId && (await opts.store.isBrandPaused(opts.brandId))) {
    throw new SpendGuardError("This client is paused. Nothing was sent to HeyGen.");
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
    await onCapReached(opts, cap);
    throw new SpendGuardError(
      `Today's HeyGen limit for ${KIND_WORDS[opts.kind]} is reached (${cap} a day). Nothing was sent to HeyGen. Try again tomorrow, or raise heygen_daily_caps in Settings.`,
    );
  }
  return id;
}

/** A short error detail for a server log: secrets redacted, URLs removed. */
function safeDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redact(text).replace(/\bhttps?:\/\/\S+/gi, "[url]").slice(0, 200);
}

/** "2026-11-22": the Asia/Karachi calendar day of `now`. */
export function karachiDay(now: Date): string {
  return new Date(karachiDayStart(now).getTime() + KARACHI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * SF4 (CLAUDE.md "Daily spend caps email the admin and pause renders"):
 * renders_paused → true, and one mocked alert per admin, once per kind per
 * Karachi day (dedupe in the database). Admins only, never the client. If
 * this bookkeeping fails, the call is still refused (the caller throws next).
 */
async function onCapReached(opts: GuardOptions, cap: number): Promise<void> {
  const day = karachiDay(opts.now ?? new Date());
  const words = KIND_WORDS[opts.kind];
  // p4-fix e: never swallowed. One clear line (redacted: no URL, no key); the caller still refuses this call.
  await opts.store.pauseRenders().catch((error: unknown) =>
    console.error(
      `[spend] PAUSE FAILED: the daily HeyGen cap for ${opts.kind} was hit but renders_paused could not be set. This call was refused; check app_settings now.`,
      { kind: opts.kind, day, error: safeDetail(error) },
    ),
  );
  await opts.store
    .queueCapAlert({
      dedupeKey: `spend_cap:${opts.kind}:${day}`,
      recipients: adminRecipients(opts.adminEmails ?? parseAdminEmails(process.env.ADMIN_EMAILS)),
      subject: `HeyGen daily limit reached: ${words} (${cap} a day). HeyGen work is paused.`,
      body: [
        `Today (${day}, Karachi time) the app reached its HeyGen limit for ${words}: ${cap} a day.`,
        "Nothing more was sent to HeyGen. All HeyGen work is now paused (renders_paused is on).",
        "To restart: check today's HeyGen spend, then use Admin → Settings → Resume renders (logged).",
        "Raise heygen_daily_caps only if Zee agreed to the extra spend.",
      ].join("\n"),
    })
    .catch((error) => console.error("[spend] could not queue the cap alert", error));
}

// ---------------------------------------------------------------------------
// Resume renders (p4-fix e): the only supported way to lift renders_paused.
// ---------------------------------------------------------------------------

export const resumeRendersSchema = z.object({ confirmCheckedSpend: z.literal(true) });

export const NEEDS_SPEND_CHECK = "Tick “I checked today's HeyGen spend” first. Nothing was changed.";
export const RENDERS_RESUMED = "Renders are running again (this is logged).";
export const NOT_PAUSED = "Renders are not paused. Nothing was changed.";

/** Lifts renders_paused after the admin confirmed they checked today's spend. Returns a plain sentence. */
export async function resumeRenders(
  input: z.infer<typeof resumeRendersSchema>,
  deps: { store: SpendStore; adminEmail: string },
): Promise<string> {
  if (!resumeRendersSchema.safeParse(input).success) throw new PlainError(NEEDS_SPEND_CHECK);
  const result = await deps.store.resumeRenders(deps.adminEmail);
  if (result === "not_paused") throw new PlainError(NOT_PAUSED);
  return RENDERS_RESUMED;
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
