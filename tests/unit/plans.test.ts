import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN, PLAN_IDS, PLANS, planLimits } from "@/lib/plans";

describe("plans (temporary values from docs/PRODUCT.md)", () => {
  it("has exactly Creator, Pro and Agency", () => {
    expect(PLAN_IDS).toEqual(["creator", "pro", "agency"]);
    expect(Object.keys(PLANS)).toEqual(["creator", "pro", "agency"]);
  });

  it("Creator: 8 videos up to 45 s, 1 brand, 1 free redo", () => {
    expect(PLANS.creator).toMatchObject({
      label: "Creator",
      videos_per_month: 8,
      max_seconds_per_video: 45,
      max_brands: 1,
      free_redos_per_video: 1,
    });
  });

  it("Pro: 16 videos up to 60 s, 1 brand, 1 free redo", () => {
    expect(PLANS.pro).toMatchObject({
      label: "Pro",
      videos_per_month: 16,
      max_seconds_per_video: 60,
      max_brands: 1,
      free_redos_per_video: 1,
    });
  });

  it("Agency: 40 videos up to 60 s, up to 5 brands, 1 free redo", () => {
    expect(PLANS.agency).toMatchObject({
      label: "Agency",
      videos_per_month: 40,
      max_seconds_per_video: 60,
      max_brands: 5,
      free_redos_per_video: 1,
    });
  });

  it("prices are not decided yet", () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.price_usd).toBeNull();
      expect(plan.price_pkr).toBeNull();
    }
  });

  it("falls back to Creator when there is no plan or an unknown one", () => {
    expect(DEFAULT_PLAN).toBe("creator");
    expect(planLimits(null)).toBe(PLANS.creator);
    expect(planLimits(undefined)).toBe(PLANS.creator);
    expect(planLimits("platinum")).toBe(PLANS.creator);
    expect(planLimits("pro")).toBe(PLANS.pro);
  });
});
