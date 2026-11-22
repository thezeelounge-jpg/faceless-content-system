import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminPage } from "@/components/admin/admin-page";
import { LateHeygenIdLine } from "@/components/admin/late-heygen-id";
import { Card, CardContent } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";
import { getAdminVideo } from "@/lib/video-store";

// Admin → Videos → one video (read only). p4-b1 (Rowan 5b): shows a HeyGen id
// recorded from a late webhook, when there is one. More detail comes in Phase 5.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function VideoPage({ params }: PageProps<"/admin/videos/[id]">) {
  return (
    <AdminPage title="Video">
      <p className="text-sm">
        <Link href="/admin/videos" className="text-muted-foreground hover:underline">
          ← All videos
        </Link>
      </p>
      <VideoDetail params={params} />
    </AdminPage>
  );
}

async function VideoDetail({ params }: Pick<PageProps<"/admin/videos/[id]">, "params">) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const video = await getAdminVideo(id);
  if (!video) notFound();
  return (
    <Card>
      <CardContent className="space-y-2">
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Type</dt>
          <dd>{video.kind === "likeness_test" ? "Likeness test" : "Post video"}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{video.status}</dd>
          <dt className="text-muted-foreground">Client</dt>
          <dd>
            <Link href={`/admin/clients/${video.brand_id}`} className="underline">
              Open client
            </Link>
          </dd>
          <dt className="text-muted-foreground">HeyGen video</dt>
          <dd className="break-all">{video.heygen_video_id ?? "—"}</dd>
          <dt className="text-muted-foreground">Made</dt>
          <dd>{new Date(video.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
        </dl>
        {video.error && <p className="text-sm break-words">{video.error}</p>}
        <LateHeygenIdLine lateHeygenVideoId={video.late_heygen_video_id} />
      </CardContent>
    </Card>
  );
}
