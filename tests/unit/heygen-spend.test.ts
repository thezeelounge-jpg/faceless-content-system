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

  it("the app_settings caps override the defaults (real calls; mock ones never count, decision (a))", async () => {
    const spend = memorySpendStore({ caps: { create_twin: 1 } });
    await guardHeygenSpend({ kind: "create_twin", mock: false, store: spend.store, now: NOW, adminEmails: [] });
    await expect(guardHeygenSpend({ kind: "create_twin", mock: false, store: spend.store, now: NOW, adminEmails: [] })).rejects.toThrow(
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

// SF4 (p3-fix2): hitting the daily cap also pauses all HeyGen work and queues
// a mocked alert email to the ADMINS only, once per kind per Karachi day.
describe("SF4: daily cap hit → admins alerted once, renders paused", () => {
  const ADMINS = ["owner@example.com", "rowan@example.com"];
  const hit = (spend: ReturnType<typeof memorySpendStore>, now = NOW, kind: "render" | "create_twin" = "render") =>
    guardHeygenSpend({ kind, mock: false, store: spend.store, now, brandId: BRAND_ID, adminEmails: ADMINS }).catch((e) => e);

  it("first hit: one mocked alert per admin, renders_paused set, same refusal as before", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    const error = await hit(spend);
    expect(error).toBeInstanceOf(SpendGuardError);
    expect(error.message).toBe(
      "Today's HeyGen limit for videos is reached (3 a day). Nothing was sent to HeyGen. Try again tomorrow, or raise heygen_daily_caps in Settings.",
    );
    expect(spend.settings.rendersPaused).toBe(true);
    expect(spend.alerts.map((a) => [a.to_email, a.kind, a.status, a.dedupe_key])).toEqual([
      ["owner@example.com", "spend_cap_alert", "mocked", "spend_cap:render:2026-11-22:owner@example.com"],
      ["rowan@example.com", "spend_cap_alert", "mocked", "spend_cap:render:2026-11-22:rowan@example.com"],
    ]);
    expect(spend.alerts[0].subject).toBe("HeyGen daily limit reached: videos (3 a day). HeyGen work is paused.");
    expect(spend.alerts[0].body).toContain("renders_paused");
  });

  it("p4-fix e: if setting renders_paused fails, one clear server log line (no URL, no secret); the call is still refused", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    spend.store.pauseRenders = async () => {
      throw new Error("[spend] pause renders: fetch failed https://abc.supabase.co/rest/v1/app_settings apikey=sb_secret_abcdef123456");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await hit(spend);
    expect(error).toBeInstanceOf(SpendGuardError);
    const lines = errors.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    const pauseLines = lines.filter((l) => l.includes("renders_paused"));
    expect(pauseLines).toHaveLength(1);
    expect(pauseLines[0]).toContain(
      "[spend] PAUSE FAILED: the daily HeyGen cap for render was hit but renders_paused could not be set. This call was refused; check app_settings now.",
    );
    expect(pauseLines[0]).not.toMatch(/supabase\.co|sb_secret|https?:\/\//);
  });

  it("p4-fix e: the alert tells admins to use Settings → Resume renders (not a manual Supabase edit)", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    await hit(spend);
    expect(spend.alerts[0].body).toContain("Admin → Settings → Resume renders");
    expect(spend.alerts[0].body).not.toContain("set renders_paused to false");
  });

  it("admins only: the client is never emailed (only ADMIN_EMAILS addresses)", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    await hit(spend);
    expect(spend.alerts.every((a) => ADMINS.includes(a.to_email))).toBe(true);
  });

  it("second hit the same Karachi day (after an admin un-pauses): refused again, NO second alert", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    await hit(spend);
    spend.settings.rendersPaused = false; // an admin turns it back off, but the cap is still reached
    const again = await hit(spend, new Date("2026-11-22T15:00:00.000Z")); // 20:00 Karachi, same day
    expect(again.message).toContain("Today's HeyGen limit for videos is reached");
    expect(spend.alerts).toHaveLength(2);
    expect(spend.settings.rendersPaused).toBe(true);
  });

  it("while paused, a further call is refused by the pause and queues nothing", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    await hit(spend);
    const again = await hit(spend);
    expect(again.message).toContain("renders_paused is on");
    expect(spend.alerts).toHaveLength(2);
  });

  it("a new alert on the next Karachi day, and a separate one per kind", async () => {
    const spend = memorySpendStore({ caps: { create_twin: 0 } });
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    await hit(spend);
    spend.settings.rendersPaused = false;
    await hit(spend, NOW, "create_twin");
    spend.settings.rendersPaused = false;
    spend.seed("render", "2026-11-22T20:00:00.000Z", 3); // 01:00 on 23 Nov in Karachi
    await hit(spend, new Date("2026-11-22T21:00:00.000Z"));
    expect(spend.alerts.map((a) => a.dedupe_key.split(":").slice(0, 3).join(":"))).toEqual([
      "spend_cap:render:2026-11-22",
      "spend_cap:render:2026-11-22",
      "spend_cap:create_twin:2026-11-22",
      "spend_cap:create_twin:2026-11-22",
      "spend_cap:render:2026-11-23",
      "spend_cap:render:2026-11-23",
    ]);
  });

  it("with no ADMIN_EMAILS it still pauses and refuses (no alert rows to write)", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    const error = await guardHeygenSpend({ kind: "render", mock: false, store: spend.store, now: NOW, brandId: BRAND_ID, adminEmails: [] }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(SpendGuardError);
    expect(spend.settings.rendersPaused).toBe(true);
    expect(spend.alerts).toEqual([]);
  });

  it("if pausing or the alert fails, the call is STILL refused with the cap message", async () => {
    const spend = memorySpendStore();
    spend.seed("render", "2026-11-22T05:00:00.000Z", 3);
    spend.store.pauseRenders = async () => {
      throw new Error("db down");
    };
    spend.store.queueCapAlert = async () => {
      throw new Error("db down");
    };
    const error = await hit(spend);
    expect(error).toBeInstanceOf(SpendGuardError);
    expect(error.message).toContain("Today's HeyGen limit for videos is reached");
  });
});

// Decision (a) (Rowan): mock rows (note 'mock', cost 0) are still recorded
// but do NOT count toward the daily cap. Real rows still do.
describe("decision (a): mock calls never use up the daily cap", () => {
  it("5 mock renders over a cap of 3 all go through and are all recorded", async () => {
    const spend = memorySpendStore();
    for (let i = 0; i < 5; i++) {
      await guardHeygenSpend({ kind: "render", mock: true, store: spend.store, now: NOW, brandId: BRAND_ID, adminEmails: [] });
    }
    expect(spend.rows.map((r) => [r.note, r.mock, r.cost_usd])).toEqual(Array(5).fill(["mock", true, 0]));
    expect(spend.settings.rendersPaused).toBeFalsy();
  });

  it("a failed mock call keeps its mock mark (the note is overwritten, the mark is not)", async () => {
    const spend = memorySpendStore();
    await withHeygenSpend({ kind: "render", mock: true, store: spend.store, now: NOW, brandId: BRAND_ID }, async () => {
      throw new HeygenError("failed", "HeyGen had a problem (500). Try again later.");
    }).catch(() => null);
    expect(spend.rows[0]).toMatchObject({ status: "failed", mock: true });
  });

  it("real calls are still capped, even after many mock rows today", async () => {
    const spend = memorySpendStore();
    for (let i = 0; i < 4; i++) {
      await guardHeygenSpend({ kind: "render", mock: true, store: spend.store, now: NOW, brandId: BRAND_ID });
    }
    for (let i = 0; i < 3; i++) {
      await guardHeygenSpend({ kind: "render", mock: false, store: spend.store, now: NOW, brandId: BRAND_ID });
    }
    await expect(
      guardHeygenSpend({ kind: "render", mock: false, store: spend.store, now: NOW, brandId: BRAND_ID, adminEmails: [] }),
    ).rejects.toThrow("Today's HeyGen limit for videos is reached (3 a day).");
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
