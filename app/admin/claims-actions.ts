"use server";

import { revalidatePath } from "next/cache";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { clearClaimSchema, clearStuckClaim, NEEDS_HEYGEN_CHECK } from "@/lib/claims";
import { createClaimStore } from "@/lib/claims-store";
import type { ActionState } from "@/lib/plain-error";
import { PlainError } from "@/lib/plain-error";

// "Clear stuck claim" (decision (b)). Admin FIRST, then zod, then the
// explicit "I checked the HeyGen dashboard" box (confirm_checked_heygen = "yes").
// The database function clears and audits in one step (lib/claims.ts).

const FAILED = "Something went wrong. Please try again in a minute.";

function text(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

export async function clearStuckClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  if (text(formData, "confirm_checked_heygen") !== "yes") return { status: "error", message: NEEDS_HEYGEN_CHECK };
  const parsed = clearClaimSchema.safeParse({
    target: text(formData, "target"),
    id: text(formData, "id"),
    confirmCheckedHeygen: true,
  });
  if (!parsed.success) return { status: "error", message: "That claim was not found. Nothing was changed." };
  try {
    const message = await clearStuckClaim(parsed.data, { claims: createClaimStore(), adminEmail: admin.email });
    revalidatePath("/admin", "layout");
    return { status: "ok", message };
  } catch (error) {
    if (!(error instanceof PlainError)) logAdminError("[admin] clear stuck claim failed", { target: parsed.data.target, id: parsed.data.id }, error);
    return { status: "error", message: plainAdminMessage(error, FAILED) };
  }
}
