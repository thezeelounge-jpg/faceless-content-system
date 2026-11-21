import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { readEnv } from "@/lib/config";
import { heygen } from "@/lib/heygen";
import { handleHeygenWebhook } from "@/lib/heygen-webhook";
import { createVideoFiles, createVideoStore } from "@/lib/video-store";
import type { pollRenderTask } from "@/trigger/poll-render";

// HeyGen → us: avatar_video.success / avatar_video.fail. Public on purpose
// (HeyGen has no login): the permission check is the signature on the RAW
// body (lib/heygen-webhook.ts), done before anything is stored or read.
// Server only: uses the Supabase secret key after the signature passes.
// With TRIGGER_SECRET_KEY the download runs in the poll-render task (HeyGen
// wants an answer within 10 s); without it (local), right here.

export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  // Raw body first: the signature is over these exact bytes.
  const rawBody = await request.text();
  const finishInBackground = readEnv("TRIGGER_SECRET_KEY")
    ? async (videoId: string, eventKey: string) => {
        const idempotencyKey = await idempotencyKeys.create(`webhook-${eventKey}`, { scope: "global" });
        await tasks.trigger<typeof pollRenderTask>("poll-render", { videoId }, { idempotencyKey });
      }
    : undefined;
  const result = await handleHeygenWebhook(
    { rawBody, signature: request.headers.get("signature"), secret: readEnv("HEYGEN_WEBHOOK_SECRET") },
    { videos: createVideoStore(), files: createVideoFiles(), heygen: heygen({ forPage: true }), finishInBackground },
  );
  return Response.json(result.body, { status: result.status, headers: NO_STORE });
}
