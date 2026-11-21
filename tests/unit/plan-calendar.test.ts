import { describe, expect, it } from "vitest";
import { calendarWeeks } from "@/lib/plan-calendar";

const post = (id: string, scheduled_for: string) => ({ id, scheduled_for });

describe("month grid", () => {
  it("lays posts out in Monday-first weeks by local date", () => {
    const weeks = calendarWeeks(
      [
        post("a", "2026-12-07T15:00:00Z"), // Mon 7 Dec, 20:00 Karachi
        post("b", "2026-12-09T19:30:00Z"), // Thu 10 Dec 00:30 Karachi (next local day)
        post("c", "2026-12-20T15:00:00Z"), // Sun 20 Dec
      ],
      "Asia/Karachi",
    );
    expect(weeks).toHaveLength(2);
    expect(weeks[0].map((d) => d.date)).toEqual([
      "2026-12-07",
      "2026-12-08",
      "2026-12-09",
      "2026-12-10",
      "2026-12-11",
      "2026-12-12",
      "2026-12-13",
    ]);
    expect(weeks[0][0].posts.map((p) => p.id)).toEqual(["a"]);
    expect(weeks[0][3].posts.map((p) => p.id)).toEqual(["b"]);
    expect(weeks[1][6]).toMatchObject({ date: "2026-12-20" });
    expect(weeks[1][6].posts.map((p) => p.id)).toEqual(["c"]);
  });

  it("is empty when there are no posts", () => {
    expect(calendarWeeks([], "Asia/Karachi")).toEqual([]);
  });
});
