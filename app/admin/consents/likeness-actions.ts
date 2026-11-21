"use server";

import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { isMockHeygen, readEnv } from "@/lib/config";
import { createConsentStore } from "@/lib/consent-store";
import { heygen } from "@/lib/heygen";
import { createSpendStore } from "@/lib/heygen-spend-store";
import { chooseLikenessEngine, markNeedsReshoot, runLikenessTest } from "@/lib/likeness";
import type { ActionState } from "@/lib/plain-error";
import { PlainError } from "@/lib/plain-error";
import { pollRenderOnce } from "@/lib/render";
import { createVideoFiles, createVideoStore } from "@/lib/video-store";
import type { likenessTestTask } from "@/trigger/likeness-test";

// Admin → Consents and twins → twin → "Likeness test". Every action checks
// admin FIRST, then its input with zod. Plain sentences only.
// Money rule: with MOCK_HEYGEN=false a render needs the "I agree to spend"
// box (confirm_spend = "yes"), and only runs in the background task, never
// from a page. In mock mode (no Trigger key) it runs here and spends nothing.

const FAILED = "Something went wrong. Please try again in a minute.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_TWIN: ActionState = { status: "error", message: "Twin not found." };

const startSchema = z.object({ confirm_spend: z.literal("yes").optional() });
const engineSchema = z.object({
  engine: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/i),
});

function text(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function failure(label: string, context: Record<string, unknown>, error: unknown): ActionState {
  if (!(error instanceof PlainError)) logAdminError(label, context, error);
  return { status: "error", message: plainAdminMessage(error, FAILED) };
}

const refresh = () => revalidatePath("/admin/consents", "layout");

export async function startLikenessTestAction(avatarId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  if (!UUID.test(avatarId)) return NO_TWIN;
  const parsed = startSchema.safeParse({ confirm_spend: text(formData, "confirm_spend") });
  if (!parsed.success) return { status: "error", message: "Tick “I agree to spend” to confirm." };
  const confirmSpend = parsed.data.confirm_spend === "yes";
  try {
    const store = createConsentStore();
    const videos = createVideoStore();
    const client = heygen({ forPage: true });
    if (readEnv("TRIGGER_SECRET_KEY")) {
      // Same check the task makes, so the admin sees the refusal at once.
      if (!client.mock && !confirmSpend) {
        return { status: "error", message: "A real HeyGen render costs money. Tick “I agree to spend” first. Nothing was sent to HeyGen." };
      }
      const idempotencyKey = await idempotencyKeys.create(`likeness-${avatarId}`, { scope: "global" });
      await tasks.trigger<typeof likenessTestTask>("likeness-test", { avatarId, confirmSpend }, { idempotencyKey, idempotencyKeyTTL: "10m" });
      refresh();
      return { status: "ok", message: "Likeness test started in the background. Refresh in a few minutes." };
    }
    if (!isMockHeygen() || !client.mock) {
      return { status: "error", message: "Real renders run in the background: add TRIGGER_SECRET_KEY first. Nothing was sent to HeyGen." };
    }
    const { videos: rows } = await runLikenessTest(avatarId, { store, videos, heygen: client, spend: createSpendStore(), confirmSpend });
    const files = createVideoFiles();
    for (const row of rows) await pollRenderOnce(row.id, { videos, heygen: client, files });
    refresh();
    return { status: "ok", message: `Mock likeness test done: ${rows.length} videos (no HeyGen call, nothing spent).` };
  } catch (error) {
    refresh();
    return failure("[admin] likeness test failed", { avatarId }, error);
  }
}

/** Asks HeyGen once (free GET) about each test video still rendering. Backup for webhooks. */
export async function checkLikenessAction(avatarId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  if (!UUID.test(avatarId)) return NO_TWIN;
  try {
    const videos = createVideoStore();
    const deps = { videos, heygen: heygen({ forPage: true }), files: createVideoFiles() };
    const rows = (await videos.listLikenessVideos(avatarId)).filter((v) => v.status === "rendering");
    for (const row of rows) await pollRenderOnce(row.id, deps);
    const after = await videos.listLikenessVideos(avatarId);
    const ready = after.filter((v) => rows.some((r) => r.id === v.id) && v.status === "rendered").length;
    refresh();
    return { status: "ok", message: `Checked ${rows.length} test videos: ${ready} ready.` };
  } catch (error) {
    return failure("[admin] likeness check failed", { avatarId }, error);
  }
}

export async function chooseEngineAction(avatarId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  if (!UUID.test(avatarId)) return NO_TWIN;
  const parsed = engineSchema.safeParse({ engine: text(formData, "engine") });
  if (!parsed.success) return { status: "error", message: "Pick an engine from the list." };
  try {
    await chooseLikenessEngine(avatarId, parsed.data.engine, { store: createConsentStore(), videos: createVideoStore() });
    refresh();
    return { status: "ok", message: `Saved: this client's videos will use ${parsed.data.engine}.` };
  } catch (error) {
    return failure("[admin] choose engine failed", { avatarId }, error);
  }
}

export async function needsReshootAction(avatarId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  if (!UUID.test(avatarId)) return NO_TWIN;
  try {
    await markNeedsReshoot(avatarId, { store: createConsentStore() });
    refresh();
    return { status: "ok", message: "Marked as needing a reshoot. Recording tips were saved for the admins (mock email)." };
  } catch (error) {
    return failure("[admin] needs reshoot failed", { avatarId }, error);
  }
}
