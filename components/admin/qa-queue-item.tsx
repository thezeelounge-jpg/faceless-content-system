import Link from "next/link";
import { QaReviewForm } from "@/components/admin/qa-review-form";
import { ReviewHistory } from "@/components/admin/review-history";
import { Card, CardContent } from "@/components/ui/card";
import type { ActionState } from "@/lib/plain-error";
import { gateLabel } from "@/lib/qa/gates";
import type { QueueItem, QueueReport } from "@/lib/qa/queue-store";

// p5-b3: one video in Admin → QA queue (Gate 6). Admin pages only; the data is loaded after
// requireAdmin() and the player link is a short signed URL made on the server.

export function QueueItemView({
  item,
  action,
}: {
  item: QueueItem;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <header className="space-y-1">
          <h2 className="font-medium">
            {item.post?.title ?? "Post video"} <span className="text-muted-foreground text-sm">· {item.brand?.name ?? "Unknown client"}</span>
          </h2>
          <p className="text-sm">
            <span className="font-medium">Why it is here:</span> {item.post?.status_reason ?? "No reason saved."}
          </p>
          {item.error && <p className="text-sm break-words">{item.error}</p>}
          {item.post?.human_reviews && item.post.human_reviews.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-medium">Earlier decisions on this post (team only)</p>
              <ReviewHistory reviews={item.post.human_reviews} />
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            Attempt {item.attempt} · {item.ai_label ? "AI label on" : "AI label off"}
            {item.watermark ? " · trial (watermark)" : ""} ·{" "}
            <Link href={`/admin/videos/${item.id}`} className="underline">
              video page
            </Link>
          </p>
        </header>

        {item.playUrl ? (
          <div className="space-y-1">
            <video src={item.playUrl} controls playsInline preload="metadata" className="mx-auto max-h-[70vh] w-full max-w-xs rounded-md bg-black" />
            {item.playsRaw && <p className="text-muted-foreground text-xs">This is the raw render: the video has no finished edit yet.</p>}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No player link (no file yet, or the link could not be made). Reload the page to try again.</p>
        )}

        <section className="space-y-1">
          <h3 className="text-sm font-medium">Gate reports</h3>
          {item.reports.length === 0 ? (
            <p className="text-muted-foreground text-sm">No gate reports saved.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {item.reports.map((report) => (
                <ReportLine key={report.id} report={report} />
              ))}
            </ul>
          )}
        </section>

        <QaReviewForm videoId={item.id} canApprove={Boolean(item.final_path)} action={action} />
      </CardContent>
    </Card>
  );
}

function ReportLine({ report }: { report: QueueReport }) {
  return (
    <li className="space-y-0.5 py-1.5">
      <p>
        <span className="font-medium">{gateLabel(report.gate)}</span> · {report.passed ? "Passed" : "Failed"}
        {report.score !== null ? ` · score ${report.score}` : ""}
        <span className="text-muted-foreground"> · {new Date(report.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
      </p>
      {report.auto_fix && <p className="text-muted-foreground text-xs">After the automatic fix: {report.auto_fix}</p>}
      {report.issues.length > 0 && (
        <ul className="ml-4 list-disc text-xs">
          {report.issues.map((issue, i) => (
            <li key={i}>
              <code>{issue.code ?? "issue"}</code>
              {issue.severity === "soft" ? " (soft)" : ""}: {issue.detail ?? ""}
              {typeof issue.at_seconds === "number" ? ` (at ${issue.at_seconds} s)` : ""}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
