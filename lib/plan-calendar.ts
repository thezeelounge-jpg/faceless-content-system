// Lays planned posts out as a Monday-first month grid, by local date in the
// brand's primary country. Pure, used by the admin brand page.
import { addDays } from "@/lib/planner";
import { localDateString, weekdayOf } from "@/lib/posting-times";

export type CalendarDay<P> = { date: string; posts: P[] };

export function calendarWeeks<P extends { scheduled_for: string }>(posts: P[], timezone: string): CalendarDay<P>[][] {
  if (posts.length === 0) return [];
  const byDate = new Map<string, P[]>();
  for (const post of posts) {
    const date = localDateString(new Date(post.scheduled_for), timezone);
    byDate.set(date, [...(byDate.get(date) ?? []), post]);
  }
  const dates = [...byDate.keys()].sort();
  const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));
  const weeks: CalendarDay<P>[][] = [];
  for (let start = mondayOf(dates[0]); start <= dates[dates.length - 1]; start = addDays(start, 7)) {
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const date = addDays(start, i);
        return { date, posts: byDate.get(date) ?? [] };
      }),
    );
  }
  return weeks;
}
