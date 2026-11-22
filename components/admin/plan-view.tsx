import type { ReactNode } from "react";
import { ReviewHistory } from "@/components/admin/review-history";
import { calendarWeeks } from "@/lib/plan-calendar";
import { lastReject } from "@/lib/qa/human-review";
import { localTimeString } from "@/lib/posting-times";
import type { PostWithScript } from "@/lib/posts";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const longDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );

/** The planned posts as a month grid (local dates in the primary country). */
export function PlanGrid({ posts, timezone }: { posts: PostWithScript[]; timezone: string }) {
  const weeks = calendarWeeks(posts, timezone);
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[36rem] grid-cols-7 gap-px rounded-lg border text-xs">
        {DAY_NAMES.map((name) => (
          <div key={name} className="bg-muted/60 p-1 text-center font-medium">
            {name}
          </div>
        ))}
        {weeks.flat().map((day) => (
          <div key={day.date} className="min-h-16 p-1">
            <div className="text-muted-foreground">{Number(day.date.slice(8))}</div>
            {day.posts.map((post) => (
              <div key={post.id} className="bg-muted mt-0.5 truncate rounded px-1" title={post.title}>
                {localTimeString(new Date(post.scheduled_for), timezone)} {post.title}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The planned posts as a list; `actions` renders the buttons for one post. */
export function PlanList({
  posts,
  timezone,
  actions,
}: {
  posts: PostWithScript[];
  timezone: string;
  actions?: (post: PostWithScript) => ReactNode;
}) {
  return (
    <ul className="divide-border divide-y text-sm">
      {posts.map((post) => {
        const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(post.scheduled_for));
        const script = [...post.scripts].sort((a, b) => b.version - a.version)[0];
        return (
          <li key={post.id} className="space-y-1 py-2">
            <div className="text-muted-foreground text-xs">
              {longDate(date)} · {localTimeString(new Date(post.scheduled_for), timezone)} · {post.format} · {post.pillar ?? "—"} ·{" "}
              {post.status}
            </div>
            {post.status_reason && <div className="text-destructive text-xs">{post.status_reason}</div>}
            {/* p5-b4: Gate 6 decisions with the internal note (admin page only; customers never see them). */}
            {post.human_reviews && post.human_reviews.length > 0 && (
              <div className="space-y-1 rounded-md border p-2 text-xs">
                <div className="font-medium">
                  QA queue decisions (team only)
                  {post.status === "approved" && lastReject(post.human_reviews) ? ": rejected, press Make video to try again." : ""}
                </div>
                <ReviewHistory reviews={post.human_reviews} />
              </div>
            )}
            <div className="font-medium">{post.title}</div>
            {post.hook && <div className="text-muted-foreground">“{post.hook}”</div>}
            {script && (
              <details className="text-xs">
                <summary className="cursor-pointer">
                  Script v{script.version} · about {Math.round(Number(script.est_seconds ?? 0))} s · QA {script.qa_status}
                </summary>
                <p className="mt-1 break-words whitespace-pre-wrap">{script.display_text}</p>
                {script.spoken_text && (
                  <p className="text-muted-foreground mt-1 break-words whitespace-pre-wrap">
                    <span className="font-medium">Spoken:</span> {script.spoken_text}
                  </p>
                )}
                <p className="text-muted-foreground mt-1">{script.hashtags.join(" ")}</p>
              </details>
            )}
            {actions?.(post)}
          </li>
        );
      })}
    </ul>
  );
}
