import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardHeygenSpend } from "@/lib/heygen-spend";
import { BRAND_ID } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";

// p4-fix e (QA SHOULD FIX 4): Admin → Settings → "Resume renders" is the ONLY
// supported way to lift renders_paused. Admin first, then the explicit
// "I checked today's HeyGen spend" box, then zod; the rpc resume_renders sets
// the flag false and writes the audit row (provider_usage kind
// 'renders_resumed', cost 0, never counted) in one transaction.

const requireAdmin = vi.fn();
let spend: ReturnType<typeof memorySpendStore>;

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/heygen-spend-store", () => ({ createSpendStore: () => spend.store }));

const { resumeRendersAction } = await import("@/app/admin/settings/actions");

const ADMIN = "admin@example.com";
const idle = { status: "idle" as const, message: "" };
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const audits = () => spend.rows.filter((r) => r.kind === "renders_resumed");

beforeEach(() => {
  spend = memorySpendStore({ rendersPaused: true });
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: ADMIN, isAdmin: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("resumeRendersAction (Admin → Settings → Resume renders)", () => {
  it("a non-admin is stopped before anything runs; still paused, no audit", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(resumeRendersAction(idle, form({ confirm_checked_spend: "yes" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(spend.settings.rendersPaused).toBe(true);
    expect(audits()).toEqual([]);
  });

  it("no confirm box (or any value other than 'yes') → plain refusal; still paused, no audit", async () => {
    const attempts: Record<string, string>[] = [{}, { confirm_checked_spend: "on" }, { confirm_checked_spend: "" }];
    for (const values of attempts) {
      expect(await resumeRendersAction(idle, form(values))).toEqual({
        status: "error",
        message: "Tick “I checked today's HeyGen spend” first. Nothing was changed.",
      });
    }
    expect(spend.settings.rendersPaused).toBe(true);
    expect(audits()).toEqual([]);
  });

  it("confirmed: renders_paused → false and exactly ONE audit row with the admin's email", async () => {
    expect(await resumeRendersAction(idle, form({ confirm_checked_spend: "yes" }))).toEqual({
      status: "ok",
      message: "Renders are running again (this is logged).",
    });
    expect(spend.settings.rendersPaused).toBe(false);
    expect(audits()).toEqual([
      expect.objectContaining({
        kind: "renders_resumed",
        status: "succeeded",
        cost_usd: 0,
        mock: false,
        note: `renders resumed by ${ADMIN} after checking today's HeyGen spend`,
      }),
    ]);
  });

  it("not paused: plain 'not paused', nothing written", async () => {
    spend.settings.rendersPaused = false;
    expect(await resumeRendersAction(idle, form({ confirm_checked_spend: "yes" }))).toEqual({
      status: "error",
      message: "Renders are not paused. Nothing was changed.",
    });
    expect(audits()).toEqual([]);
  });

  it("a store failure gives a plain message (no technical detail)", async () => {
    spend.store.resumeRenders = async () => {
      throw new Error("[spend] resume renders: connection refused");
    };
    expect(await resumeRendersAction(idle, form({ confirm_checked_spend: "yes" }))).toEqual({
      status: "error",
      message: "Something went wrong. Please try again in a minute.",
    });
  });

  it("the audit row never counts toward the daily cap", async () => {
    await resumeRendersAction(idle, form({ confirm_checked_spend: "yes" }));
    expect(audits()).toHaveLength(1);
    spend.settings.caps = { render: 1 };
    const id = await guardHeygenSpend({ kind: "render", mock: false, store: spend.store, brandId: BRAND_ID, adminEmails: [] });
    expect(id).toBeTruthy();
  });
});
