import { z } from "zod";
import { PlainError } from "@/lib/plain-error";

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

export type ClearedClaim = "render" | "likeness_test" | "twin";

export type StuckClaim = {
  target: "video" | "twin";
  id: string;
  kind: ClearedClaim;
  brandId: string;
  label: string;
  startedAt: string;
};

export interface ClaimStore {
  /** Claims with no HeyGen id: videos (posts and likeness tests) and twins. */
  listStuck(): Promise<StuckClaim[]>;
  /** clear_stuck_claim: clears + audits atomically; "none" when there is no stuck claim (nothing written). */
  clear(target: "video" | "twin", id: string, adminEmail: string): Promise<ClearedClaim | "none">;
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
export async function clearStuckClaim(input: ClearClaimInput, deps: { claims: ClaimStore; adminEmail: string }): Promise<string> {
  if (input.confirmCheckedHeygen !== true) throw new PlainError(NEEDS_HEYGEN_CHECK);
  const parsed = clearClaimSchema.safeParse(input);
  if (!parsed.success) throw new PlainError("That claim was not found. Nothing was changed.");
  const cleared = await deps.claims.clear(parsed.data.target, parsed.data.id, deps.adminEmail);
  if (cleared === "none") throw new PlainError(NO_STUCK_CLAIM);
  return DONE[cleared];
}
