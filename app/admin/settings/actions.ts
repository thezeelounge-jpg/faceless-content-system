"use server";

import { tasks } from "@trigger.dev/sdk";
import type { helloWorld } from "@/trigger/hello-world";
import { requireAdmin } from "@/lib/auth";
import { readEnv } from "@/lib/config";

export type TestJobState = { status: "idle" | "ok" | "error"; message: string };

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
