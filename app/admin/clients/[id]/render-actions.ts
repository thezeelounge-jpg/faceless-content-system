"use server";

import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { isMockHeygen, readEnv } from "@/lib/config";
import { heygen } from "@/lib/heygen";
import { createSpendStore } from "@/lib/heygen-spend-store";
import type { ActionState } from "@/lib/plain-error";
import { PlainError } from "@/lib/plain-error";
import { NEEDS_SPEND_CONFIRM, RENDER_UNKNOWN, createPostRender, pollRenderOnce, renderVideo } from "@/lib/render";
import { createVideoFiles, createVideoStore } from "@/lib/video-store";
import type { renderVideoTask } from "@/trigger/render-video";

// Admin → client → plan → "Make video" on an approved post (Phase 3 item 7).
// Admin FIRST, then zod. Real renders (MOCK_HEYGEN=false) need the "I agree
// to spend" box and run only in the render-video task (key = our video id),
// never from a page. Mock mode without a Trigger key renders here for free.

const FAILED = "Something went wrong. Please try again in a minute.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const confirmSchema = z.object({ confirm_spend: z.literal("yes").optional() });

export async function makeVideoAction(postId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  if (!UUID.test(postId)) return { status: "error", message: "Post not found." };
  const raw = formData.get("confirm_spend");
  const parsed = confirmSchema.safeParse({ confirm_spend: typeof raw === "string" ? raw : undefined });
  if (!parsed.success) return { status: "error", message: "Tick “I agree to spend” to confirm." };
  const confirmSpend = parsed.data.confirm_spend === "yes";
  try {
    const videos = createVideoStore();
    const client = heygen({ forPage: true });
    if (!client.mock && !confirmSpend) return { status: "error", message: NEEDS_SPEND_CONFIRM };
    if (!readEnv("TRIGGER_SECRET_KEY") && (!isMockHeygen() || !client.mock)) {
      return { status: "error", message: "Real renders run in the background: add TRIGGER_SECRET_KEY first. Nothing was sent to HeyGen." };
    }
    const video = await createPostRender(postId, { videos });
    const page = `/admin/clients/${video.brand_id}`;
    if (readEnv("TRIGGER_SECRET_KEY")) {
      const idempotencyKey = await idempotencyKeys.create(`render-${video.id}`, { scope: "global" });
      await tasks.trigger<typeof renderVideoTask>("render-video", { videoId: video.id, confirmSpend }, { idempotencyKey });
      revalidatePath(page);
      return { status: "ok", message: "Video started in the background. Refresh in a few minutes." };
    }
    const started = await renderVideo(video.id, { videos, heygen: client, spend: createSpendStore(), confirmSpend });
    if (started.status === "waiting") {
      return { status: "error", message: "All 10 render slots are busy. The video is queued: press again in a few minutes." };
    }
    if (started.status === "unknown") {
      revalidatePath(page);
      return { status: "error", message: RENDER_UNKNOWN };
    }
    await pollRenderOnce(video.id, { videos, heygen: client, files: createVideoFiles() });
    revalidatePath(page);
    return { status: "ok", message: "Mock video made (no HeyGen call, nothing spent). The raw file is saved." };
  } catch (error) {
    if (!(error instanceof PlainError)) logAdminError("[admin] make video failed", { postId }, error);
    return { status: "error", message: plainAdminMessage(error, FAILED) };
  }
}
