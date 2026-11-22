import { AdminPage } from "@/components/admin/admin-page";
import { QueueItemView } from "@/components/admin/qa-queue-item";
import { adminSection } from "@/lib/admin-sections";
import { requireAdmin } from "@/lib/auth";
import { listQueue } from "@/lib/qa/queue-store";
import { reviewVideoAction } from "./actions";

const section = adminSection("/admin/qa");

// p5-b3: Gate 6. Every post video in team_review (sent by Gates 3-5 after their one fix, a crash,
// or the human-review rules of Gate 5), oldest first.
export default function QaQueuePage() {
  return (
    <AdminPage title={section.label} description={section.about}>
      <Queue />
    </AdminPage>
  );
}

async function Queue() {
  await requireAdmin();
  const items = await listQueue();
  if (items.length === 0) return <p className="text-muted-foreground text-sm">Nothing waiting. Every checked video has gone on.</p>;
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        {items.length} video{items.length === 1 ? "" : "s"} waiting, oldest first.
      </p>
      {items.map((item) => (
        <QueueItemView key={item.id} item={item} action={reviewVideoAction} />
      ))}
    </div>
  );
}
