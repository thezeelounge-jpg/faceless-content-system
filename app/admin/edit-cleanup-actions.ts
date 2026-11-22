"use server";

import { revalidatePath } from "next/cache";
import { logAdminError } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { cleanupStrayRunFiles } from "@/lib/edit-cleanup";
import { createCleanupStore, createRunFileStorage } from "@/lib/edit-store";
import type { ActionState } from "@/lib/plain-error";

// p5-a: Settings → "Clean up old edit files". Admin FIRST, then the confirm box
// (confirm_cleanup = "yes"), then the sweep (lib/edit-cleanup.ts: only old run
// files no video points at and no run is still editing).

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function cleanupEditFilesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  if (formData.get("confirm_cleanup") !== "yes") return { status: "error", message: "Tick the box to confirm." };
  try {
    const result = await cleanupStrayRunFiles({ store: createCleanupStore(), storage: createRunFileStorage() });
    revalidatePath("/admin/settings");
    const message = `Checked ${plural(result.videos, "video")}. Removed ${plural(result.removed.length, "old edit file")}.`;
    if (result.failed > 0) return { status: "error", message: `${message} ${result.failed} could not be removed; try again later.` };
    return { status: "ok", message };
  } catch (error) {
    logAdminError("[admin] clean up old edit files failed", {}, error);
    return { status: "error", message: "Something went wrong. Please try again in a minute." };
  }
}
