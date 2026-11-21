import Link from "next/link";
import { ClearClaimForm } from "@/components/admin/clear-claim-form";
import { requireAdmin } from "@/lib/auth";
import { createClaimStore } from "@/lib/claims-store";

/**
 * Admin → Settings: every HeyGen claim with no HeyGen id (lost POST answers).
 * Each one may or may not exist on HeyGen: check the HeyGen dashboard first.
 */
export async function StuckClaims() {
  await requireAdmin();
  const stuck = await createClaimStore().listStuck();
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
          <ClearClaimForm target={claim.target} id={claim.id} />
        </li>
      ))}
    </ul>
  );
}
