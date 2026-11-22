import Link from "next/link";
import { AdminPage } from "@/components/admin/admin-page";
import { Card, CardContent } from "@/components/ui/card";
import { adminSection } from "@/lib/admin-sections";
import { requireAdmin } from "@/lib/auth";
import { listAdminVideos } from "@/lib/video-store";

const section = adminSection("/admin/videos");

export default function VideosPage() {
  return (
    <AdminPage title={section.label} description={section.about}>
      <VideoList />
    </AdminPage>
  );
}

// p4-b1: the newest 50 videos, each linking to its read-only page. The full list (filters, history) comes in Phase 5.
async function VideoList() {
  await requireAdmin();
  const videos = await listAdminVideos(50);
  if (videos.length === 0) {
    return <p className="text-muted-foreground text-sm">No videos yet.</p>;
  }
  return (
    <Card>
      <CardContent>
        <ul className="divide-border divide-y text-sm">
          {videos.map((video) => (
            <li key={video.id} className="flex justify-between gap-2 py-1.5">
              <Link href={`/admin/videos/${video.id}`} className="underline">
                {video.kind === "likeness_test" ? "Likeness test" : "Post video"} · {video.status}
                {video.late_heygen_video_id ? " · late HeyGen id saved" : ""}
              </Link>
              <span className="text-muted-foreground">{new Date(video.created_at).toISOString().slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
