import { reviewHeadline, sortReviews, type HumanReviewRow } from "@/lib/qa/human-review";

// p5-b4: the earlier Gate 6 decisions of a post (server-only human_reviews table), newest first.
// ADMIN PAGES ONLY (client page, QA queue): the note is internal and never shown to customers.

const when = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function ReviewHistory({ reviews }: { reviews: HumanReviewRow[] }) {
  if (reviews.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {sortReviews(reviews).map((review) => (
        <li key={`${review.created_at}-${review.decision}`} className="break-words">
          <span className="font-medium">{reviewHeadline(review)}</span>
          {review.note ? <> · “{review.note}”</> : null}
          <span className="text-muted-foreground">
            {" "}
            · {review.admin}, {when(review.created_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
