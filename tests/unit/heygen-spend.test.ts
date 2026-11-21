import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEYGEN_DAILY_CAP_DEFAULTS } from "@/lib/config";
import { createHeygenClient, HeygenError, type HeygenClient } from "@/lib/heygen";
import { SpendGuardError, guardHeygenSpend, karachiDayStart, withHeygenSpend } from "@/lib/heygen-spend";
import { createTwin } from "@/lib/twin";
import { BRAND_ID, memoryClipStorage, memoryConsentStore } from "@/tests/helpers/consent-memory";
import { memorySpendStore } from "@/tests/helpers/spend-memory";

// The HeyGen spend guard: every HeyGen call that can cost money (create twin
// now, render in step 2) is checked BEFORE the POST: refused when
// renders_paused is on or today's (Asia/Karachi) cap is reached; otherwise a
// provider_usage row is reserved, then marked succeeded or failed.

const NOW = new Date("2026-11-22T10:00:00.000Z"); // 15:00 in Karachi
const MB = 1024 * 1024;

afterEach(() => vi.restoreAllMocks());

describe("caps and the Karachi day", () => {
  it("safe defaults when app_settings has no heygen_daily_caps: render 3, create_twin 2", () => {
    expect(HEYGEN_DAILY_CAP_DEFAULTS).toEqual({ render: 3, create_twin: 2 });
  });

  it("the day starts at midnight in Asia/Karachi (UTC+5)", () => {
    expect(karachiDayStart(NOW).toISOString()).toBe("2026-11-21T19:00:00.000Z");
    expect(karachiDayStart(new Date("2026-11-21T18:59:59.000Z")).toISOString()).toBe("2026-11-20T19:00:00.000Z");
  });

  it("under the cap: reserves a row (mock: cost 0, note 'mock')", async () => {
    const spend = memorySpendStore();
    const id = await guardHeygenSpend({ kind: "render", mock: true, store: spend.store, now: NOW, videoId: "v1", brandId: BRAND_ID });
    expect(spend.rows).toEqual([
      expect.objectContaining({ id, kind: "render", status: "reserved", cost_usd: 0, note: "mock", video_id: "v1" }),
    ]);
  });

  it("cap reached (default 3 renders today): refused with a plain error and no row", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    spend.seed("render", "2026-11-21T18:30:00.000Z", 5); // yesterday in Karachi: does not count
    const error = await guardHeygenSpend({ kind: "render", mock: true, store: spend.store, now: NOW, brandId: BRAND_ID }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(SpendGuardError);
    expect(error.message).toBe(
      "Today's HeyGen limit for videos is reached (3 a day). Nothing was sent to HeyGen. Try again tomorrow, or raise heygen_daily_caps in Settings.",
    );
    expect(spend.rows.filter((r) => r.note !== "seed")).toEqual([]);
  });

  it("the app_settings caps override the defaults", async () => {
    const spend = memorySpendStore({ caps: { create_twin: 1 } });
    await guardHeygenSpend({ kind: "create_twin", mock: true, store: spend.store, now: NOW });
    await expect(guardHeygenSpend({ kind: "create_twin", mock: true, store: spend.store, now: NOW })).rejects.toThrow(
      "Today's HeyGen limit for new twins is reached (1 a day).",
    );
  });

  it("renders_paused: refused before anything, no row", async () => {
    const spend = memorySpendStore({ rendersPaused: true });
    await expect(guardHeygenSpend({ kind: "create_twin", mock: true, store: spend.store, now: NOW })).rejects.toThrow(
      "HeyGen work is paused (renders_paused is on). Nothing was sent to HeyGen.",
    );
    expect(spend.rows).toEqual([]);
  });

  it("withHeygenSpend marks the row succeeded, or failed when the call throws", async () => {
    const spend = memorySpendStore();
    const opts = { kind: "render" as const, mock: false, store: spend.store, now: NOW, brandId: BRAND_ID };
    expect(await withHeygenSpend(opts, async () => "ok")).toBe("ok");
    await expect(
      withHeygenSpend(opts, async () => {
        throw new HeygenError("failed", "HeyGen had a problem (500). Try again later.");
      }),
    ).rejects.toThrow("HeyGen had a problem");
    expect(spend.rows.map((r) => [r.status, r.note])).toEqual([
      ["succeeded", null],
      ["failed", "HeyGen had a problem (500). Try again later."],
    ]);
  });

  it("a refused guard never runs the call", async () => {
    const spend = memorySpendStore({ rendersPaused: true });
    const call = vi.fn(async () => "x");
    await expect(withHeygenSpend({ kind: "render", mock: true, store: spend.store, brandId: BRAND_ID }, call)).rejects.toThrow(
      SpendGuardError,
    );
    expect(call).not.toHaveBeenCalled();
  });
});

// CLAUDE.md "Pause switches": renders_paused (global) AND brands.paused.
describe("pause rule: renders_paused and brands.paused", () => {
  const OTHER_BRAND = "10000000-0000-0000-0000-000000000002";

  it("brands.paused: a render for that brand is refused before anything, no row; another brand still renders", async () => {
    const spend = memorySpendStore({ pausedBrands: [BRAND_ID] });
    const call = vi.fn(async () => "x");
    await expect(
      withHeygenSpend({ kind: "render", mock: true, store: spend.store, brandId: BRAND_ID, now: NOW }, call),
    ).rejects.toThrow("This client is paused. Nothing was sent to HeyGen.");
    expect(call).not.toHaveBeenCalled();
    expect(spend.rows).toEqual([]);
    expect(await withHeygenSpend({ kind: "render", mock: true, store: spend.store, brandId: OTHER_BRAND, now: NOW }, call)).toBe("x");
    expect(spend.rows).toHaveLength(1);
  });

  it("brands.paused also stops a new twin for that brand", async () => {
    const spend = memorySpendStore({ pausedBrands: [BRAND_ID] });
    await expect(
      guardHeygenSpend({ kind: "create_twin", mock: true, store: spend.store, brandId: BRAND_ID, now: NOW }),
    ).rejects.toThrow(SpendGuardError);
    expect(spend.rows).toEqual([]);
  });

  it("renders_paused wins even when the brand is not paused", async () => {
    const spend = memorySpendStore({ rendersPaused: true });
    await expect(
      guardHeygenSpend({ kind: "render", mock: true, store: spend.store, brandId: OTHER_BRAND, now: NOW }),
    ).rejects.toThrow("renders_paused is on");
  });

  it("a render without a brand id is refused (its pause switch could not be checked)", async () => {
    const spend = memorySpendStore();
    await expect(guardHeygenSpend({ kind: "render", mock: true, store: spend.store, now: NOW })).rejects.toThrow(
      "A render needs its client, so the pause switch can be checked. Nothing was sent to HeyGen.",
    );
    expect(spend.rows).toEqual([]);
  });
});

describe("create twin goes through the guard", () => {
  let mem: ReturnType<typeof memoryConsentStore>;
  let clips: ReturnType<typeof memoryClipStorage>;
  beforeEach(() => {
    mem = memoryConsentStore();
    clips = memoryClipStorage();
  });

  async function approved() {
    const consent = await mem.store.insertConsent({
      brand_id: BRAND_ID,
      person_legal_name: "Ayesha Khan",
      checkbox_at: new Date().toISOString(),
      words: ["apple", "river", "tiger"],
      words_expire_at: new Date(Date.now() + 1_800_000).toISOString(),
      ip: null,
      user_agent: null,
    });
    const clipPath = `${BRAND_ID}/${consent.id}/55555555-5555-4555-8555-555555555555.mp4`;
    clips.files[clipPath] = { size: 1 * MB, contentType: "video/mp4", fixture: "consent-good.mp4" };
    await mem.store.updateConsent(consent.id, { clip_path: clipPath, admin_status: "approved" });
    return consent;
  }

  function client(over: Partial<HeygenClient> = {}) {
    const base = createHeygenClient({ mock: true, apiKey: "dummy" });
    const create = vi.fn(over.createDigitalTwin ?? base.createDigitalTwin);
    return { heygen: { ...base, ...over, createDigitalTwin: create } as HeygenClient, create };
  }

  it("writes one provider_usage row (create_twin, succeeded, avatar id, mock cost 0)", async () => {
    const consent = await approved();
    const spend = memorySpendStore();
    const { heygen } = client();
    const avatar = await createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen, spend: spend.store });
    expect(spend.rows).toEqual([
      expect.objectContaining({ kind: "create_twin", status: "succeeded", avatar_id: avatar.id, cost_usd: 0, note: "mock" }),
    ]);
  });

  it("cap reached: no HeyGen create call, plain error saved, and the SF2 claim is freed", async () => {
    const consent = await approved();
    const spend = memorySpendStore();
    spend.seed("create_twin", new Date().toISOString(), 2);
    const { heygen, create } = client();
    await expect(
      createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen, spend: spend.store }),
    ).rejects.toThrow("Today's HeyGen limit for new twins is reached (2 a day).");
    expect(create).not.toHaveBeenCalled();
    expect(mem.avatars[0]).toMatchObject({ create_started_at: null, heygen_group_id: null });
    expect(mem.avatars[0].error).toContain("Today's HeyGen limit for new twins is reached");
  });

  it("renders_paused: no HeyGen create call", async () => {
    const consent = await approved();
    const spend = memorySpendStore({ rendersPaused: true });
    const { heygen, create } = client();
    await expect(
      createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen, spend: spend.store }),
    ).rejects.toThrow("HeyGen work is paused");
    expect(create).not.toHaveBeenCalled();
  });

  it("a failing create marks the row failed", async () => {
    const consent = await approved();
    const spend = memorySpendStore();
    const { heygen } = client({
      createDigitalTwin: async () => {
        throw new HeygenError("failed", "Could not reach HeyGen. Try again later.");
      },
    });
    await expect(
      createTwin(consent.id, { store: mem.store, storage: clips.storage, heygen, spend: spend.store }),
    ).rejects.toThrow("Could not reach HeyGen.");
    expect(spend.rows).toEqual([
      expect.objectContaining({ kind: "create_twin", status: "failed", note: "Could not reach HeyGen. Try again later." }),
    ]);
  });
});
