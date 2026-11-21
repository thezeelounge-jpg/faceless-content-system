// Every plan limit lives here and only here, so changing pricing is a one-file edit.
//
// !!! TEMPORARY values for building and testing (docs/PRODUCT.md "Plans").
// !!! Replace after the pricing discussion. Prices are not decided yet.

export const PLAN_IDS = ["creator", "pro", "agency"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type PlanLimits = {
  label: string;
  videos_per_month: number;
  max_seconds_per_video: number;
  /** Brands (each with its own twin) one account may run. */
  max_brands: number;
  free_redos_per_video: number;
  price_usd: number | null;
  price_pkr: number | null;
};

export const PLANS: Record<PlanId, PlanLimits> = {
  creator: {
    label: "Creator",
    videos_per_month: 8,
    max_seconds_per_video: 45,
    max_brands: 1,
    free_redos_per_video: 1,
    price_usd: null,
    price_pkr: null,
  },
  pro: {
    label: "Pro",
    videos_per_month: 16,
    max_seconds_per_video: 60,
    max_brands: 1,
    free_redos_per_video: 1,
    price_usd: null,
    price_pkr: null,
  },
  agency: {
    label: "Agency",
    videos_per_month: 40,
    max_seconds_per_video: 60,
    max_brands: 5,
    free_redos_per_video: 1,
    price_usd: null,
    price_pkr: null,
  },
};

/** Used when an account has no plan yet (managed brands, trials). */
export const DEFAULT_PLAN: PlanId = "creator";

/** The limits for a plan name from the database; Creator when missing or unknown. */
export function planLimits(plan: string | null | undefined): PlanLimits {
  return (PLAN_IDS as readonly string[]).includes(plan ?? "") ? PLANS[plan as PlanId] : PLANS[DEFAULT_PLAN];
}
