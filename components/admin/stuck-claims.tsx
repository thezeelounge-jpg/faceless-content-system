import Link from "next/link";
import { ClearClaimForm } from "@/components/admin/clear-claim-form";
import { requireAdmin } from "@/lib/auth";
import { karachiDateTime, karachiTime, withClearTiming } from "@/lib/claims";
import { createClaimStore } from "@/lib/claims-store";

/**
 * Admin → Settings: every HeyGen claim with no HeyGen id (lost POST answers).
 * Each one may or may not exist on HeyGen: check the HeyGen dashboard first.
 * p4-fix c1: the Clear button appears only after the 30-minute wait (or once
 * the row failed); before that the row says when it can be cleared.
 */
export async function StuckClaims() {
  await requireAdmin();
  const stuck = withClearTiming(await createClaimStore().listStuck(), new Date());
  if (stuck.length === 0) return <p className="text-muted-foreground text-sm">No stuck claims.</p>;
  return (
    <ul className="space-y-4 text-sm">
      {stuck.map((claim) => (
        <li key={`${claim.target}:${claim.id}`} className="space-y-2 rounded border p-2">
          <p>
            {claim.label} · started {new Date(claim.startedAt).toLocaleString("en-GB", { timeZone: "Asia/Karachi" })} (Karachi) ·{" "}
            <Link href={`/admin/clients/${claim.brandId}`} className="underline">
              client
            </Link>
          </p>
          {claim.canClear ? (
            <ClearClaimForm target={claim.target} id={claim.id} />
          ) : (
            <p className="text-muted-foreground">
              HeyGen may still be making this. It can be cleared after{" "}
              {claim.target === "twin" ? karachiDateTime(new Date(claim.clearableAt)) : karachiTime(new Date(claim.clearableAt))} (Karachi
              time).
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
