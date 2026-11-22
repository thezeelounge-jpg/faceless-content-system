"use server";

import { tasks } from "@trigger.dev/sdk";
import type { helloWorld } from "@/trigger/hello-world";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { readEnv } from "@/lib/config";
import { NEEDS_SPEND_CHECK, resumeRenders, resumeRendersSchema } from "@/lib/heygen-spend";
import { createSpendStore } from "@/lib/heygen-spend-store";
import { PlainError, type ActionState } from "@/lib/plain-error";

export type TestJobState = { status: "idle" | "ok" | "error"; message: string };

/**
 * "Resume renders" (p4-fix e): the only supported way to lift renders_paused.
 * Admin FIRST, then the explicit "I checked today's HeyGen spend" box
 * (confirm_checked_spend = "yes"), then zod. The rpc sets the flag false and
 * writes the audit row in one transaction (lib/heygen-spend.ts resumeRenders).
 */
export async function resumeRendersAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  if (formData.get("confirm_checked_spend") !== "yes") return { status: "error", message: NEEDS_SPEND_CHECK };
  const parsed = resumeRendersSchema.safeParse({ confirmCheckedSpend: true });
  if (!parsed.success) return { status: "error", message: NEEDS_SPEND_CHECK };
  try {
    const message = await resumeRenders(parsed.data, { store: createSpendStore(), adminEmail: admin.email });
    revalidatePath("/admin", "layout");
    return { status: "ok", message };
  } catch (error) {
    if (!(error instanceof PlainError)) logAdminError("[admin] resume renders failed", {}, error);
    return { status: "error", message: plainAdminMessage(error, "Something went wrong. Please try again in a minute.") };
  }
}

/** Starts the Phase 1 "hello-world" background job on Trigger.dev. */
export async function runTestJob(_prev: TestJobState): Promise<TestJobState> {
  await requireAdmin();

  if (!readEnv("TRIGGER_SECRET_KEY")) {
    return {
      status: "error",
      message: "Add TRIGGER_SECRET_KEY to .env.local, restart the app, then try again.",
    };
  }

  try {
    const handle = await tasks.trigger<typeof helloWorld>("hello-world", { startedFrom: "admin settings" });
    return {
      status: "ok",
      message: `Test job started (${handle.id}). Open your Trigger.dev dashboard to watch it run.`,
    };
  } catch (error) {
    console.error("[admin] test job failed:", error instanceof Error ? error.message : error);
    return {
      status: "error",
      message: "Couldn't start the job. Check TRIGGER_SECRET_KEY and that `npm run trigger:dev` is running.",
    };
  }
}
