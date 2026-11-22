import { z } from "zod";
import { PlainError } from "@/lib/plain-error";
import { RENDER } from "@/lib/qa/config";

// Decision (b) (Rowan, p3-fix2): "Clear stuck claim", admin only.
//
// Before a paid HeyGen POST we set a claim, so a retry never pays twice:
//   - renders and likeness tests: videos.render_started_at (lib/render.ts)
//   - twins: avatars.create_started_at (lib/twin.ts)
// If the POST answer is lost, the claim stays with no HeyGen id and the row
// is stuck on purpose (HeyGen may have made it). After the admin has checked
// the HeyGen dashboard and seen that NOTHING was made, this clears the claim
// so the work can be started again. A likeness-test row that holds a claim
// (SF6) also blocks re-testing its engine, so the same button frees it.
//
// Rules: requireAdmin in the Server Action, zod input, an explicit
// confirmCheckedHeygen === true, and the database function
// clear_stuck_claim clears ONLY a claim without a HeyGen id and writes the
// audit row (provider_usage kind 'claim_cleared', cost 0, never counted
// toward a cap) in the same transaction.
//
// p4-fix (Sunny's blocker): (c1) a claim can be cleared only after
// CLAIM_CLEAR_WAIT_S (30 min) or once the row failed, checked here AND in
// the database function; the pages show the button only then. (c2) a cleared
// video is retired (never claimed again) and a late HeyGen success for it is
// adopted or recorded (lib/heygen-webhook.ts, adopt_late_render). (d) a
// cleared post render puts the post back to 'approved' in the same step.

export type ClearedClaim = "render" | "likeness_test" | "twin";

export type StuckClaim = {
  target: "video" | "twin";
  id: string;
  kind: ClearedClaim;
  brandId: string;
  label: string;
  startedAt: string;
  /** videos.status or avatars.status ('failed' may be cleared at once). */
  status: string;
};

/** A stuck claim plus when it may be cleared (p4-fix c1). */
export type StuckClaimView = StuckClaim & { clearableAt: string; canClear: boolean };

export interface ClaimStore {
  /** Claims with no HeyGen id: videos (posts and likeness tests) and twins. */
  listStuck(): Promise<StuckClaim[]>;
  /** One stuck claim (claim set, no HeyGen id), or null. */
  getStuck(target: "video" | "twin", id: string): Promise<StuckClaim | null>;
  /**
   * clear_stuck_claim: clears + audits atomically (and, for a post render, puts the post back to
   * 'approved'). "none" = no stuck claim; "too_soon" = inside the wait. Both write nothing.
   */
  clear(target: "video" | "twin", id: string, adminEmail: string): Promise<ClearedClaim | "none" | "too_soon">;
}

/**
 * p4-fix c1: how long a claim must wait before it can be cleared (HeyGen may
 * still be making it). Same as the render wait; the SQL function
 * clear_stuck_claim holds the same number (tests/db/rls.test.ts checks).
 * Twins use it too: a lost twin-create answer has no webhook and no poll.
 */
export const CLAIM_CLEAR_WAIT_S = RENDER.poll_max_s;

/** When this claim may be cleared. */
export function clearableAt(startedAt: string): Date {
  return new Date(Date.parse(startedAt) + CLAIM_CLEAR_WAIT_S * 1000);
}

/** True once the wait is over, or at once when the row already failed (the poll gave up). */
export function canClearClaim(claim: Pick<StuckClaim, "startedAt" | "status">, now: Date): boolean {
  if (claim.status === "failed") return true;
  return now.getTime() >= clearableAt(claim.startedAt).getTime();
}

/** Adds when each claim may be cleared; the admin pages show the button only when canClear. */
export function withClearTiming(claims: StuckClaim[], now: Date): StuckClaimView[] {
  return claims.map((c) => ({ ...c, clearableAt: clearableAt(c.startedAt).toISOString(), canClear: canClearClaim(c, now) }));
}

/** "14:35" in Karachi time. */
export function karachiTime(at: Date): string {
  return at.toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function tooSoonMessage(at: Date): string {
  return `HeyGen may still be making this. It can be cleared after ${karachiTime(at)} (Karachi time). Nothing was changed.`;
}

export const clearClaimSchema = z.object({
  target: z.enum(["video", "twin"]),
  id: z.uuid(),
  confirmCheckedHeygen: z.literal(true),
});

export type ClearClaimInput = z.infer<typeof clearClaimSchema>;

export const NEEDS_HEYGEN_CHECK = "Tick “I checked the HeyGen dashboard” first. Nothing was changed.";
export const NO_STUCK_CLAIM = "There is no stuck claim to clear here. Nothing was changed.";

const DONE: Record<ClearedClaim, string> = {
  render: "Claim cleared. The video can be made again (this is logged).",
  likeness_test: "Claim cleared. That engine can be tested again (this is logged).",
  twin: "Claim cleared. The twin can be created again (this is logged).",
};

/** Clears one stuck claim after the admin confirmed the HeyGen check. Returns a plain sentence. */
export async function clearStuckClaim(
  input: ClearClaimInput,
  deps: { claims: ClaimStore; adminEmail: string; now?: () => Date },
): Promise<string> {
  if (input.confirmCheckedHeygen !== true) throw new PlainError(NEEDS_HEYGEN_CHECK);
  const parsed = clearClaimSchema.safeParse(input);
  if (!parsed.success) throw new PlainError("That claim was not found. Nothing was changed.");
  const { target, id } = parsed.data;
  // c1: HeyGen may still be making it. The database function refuses too ('too_soon').
  const claim = await deps.claims.getStuck(target, id);
  if (!claim) throw new PlainError(NO_STUCK_CLAIM);
  const now = (deps.now ?? (() => new Date()))();
  if (!canClearClaim(claim, now)) throw new PlainError(tooSoonMessage(clearableAt(claim.startedAt)));
  const cleared = await deps.claims.clear(target, id, deps.adminEmail);
  if (cleared === "none") throw new PlainError(NO_STUCK_CLAIM);
  if (cleared === "too_soon") throw new PlainError(tooSoonMessage(clearableAt(claim.startedAt)));
  return DONE[cleared];
}
