import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BRAND_ID = "10000000-0000-0000-0000-000000000001";
const BRAND = {
  id: BRAND_ID,
  owner_id: "admin-1",
  name: "Coach Sana",
  niche: "coach",
  audience: "New team leads",
  offers: "Leadership sprint, 1:1 coaching",
  tone: "Calm",
  sound_answers: { greeting: "Hello", phrases: "Let's be honest", never_say: "Hustle" },
  samples: "One sample that is long enough.",
  banned_words: ["hustle"],
  language: "en",
  pillars: [],
  profile_md: null,
  words_per_second: 2.4,
  current_version: 1,
};

const requireAdmin = vi.fn();
const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: 2, error: null }));
const usageInsert = vi.fn(async (_row: unknown) => ({ error: null }));

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc,
    from: (table: string) => {
      if (table === "ai_usage") return { insert: usageInsert };
      return {
        select: () => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => ({ data: id === BRAND_ID ? BRAND : null, error: null }),
          }),
        }),
      };
    },
  }),
}));

const { generateBrandProfile, saveProfileEdit } = await import("@/app/admin/clients/[id]/actions");

const idle = { status: "idle" as const, message: "" };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  rpc.mockClear();
  usageInsert.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fetchSpy.mockRestore();
});

describe("Write profile", () => {
  it("checks admin first", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(generateBrandProfile(BRAND_ID, idle)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("writes a profile (mock Claude) and saves it as a generated version", async () => {
    const state = await generateBrandProfile(BRAND_ID, idle);
    expect(state).toMatchObject({ status: "ok", message: "Profile version 2 saved." });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("save_brand_version");
    expect(args).toMatchObject({ p_brand_id: BRAND_ID, p_source: "generated" });
    expect((args.p_pillars as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect(String(args.p_profile_md)).toContain("Coach Sana");
    expect(usageInsert).toHaveBeenCalledWith(expect.objectContaining({ task: "brand_profile", cost_usd: 0 }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says so plainly when the client doesn't exist", async () => {
    const state = await generateBrandProfile("not-a-uuid", idle);
    expect(state).toMatchObject({ status: "error", message: "Client not found." });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("errors shown to the admin", () => {
  const DB_DETAIL = 'duplicate key value violates unique constraint "brand_versions_brand_id_version_key"';

  it("Write profile shows one plain sentence and logs the details on the server", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: DB_DETAIL } } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await generateBrandProfile(BRAND_ID, idle);
    expect(state).toEqual({ status: "error", message: "Couldn't write the profile. Please try again in a minute." });
    expect(state.message).not.toContain("duplicate");
    expect(log).toHaveBeenCalledWith("[admin] write profile failed", expect.objectContaining({ brandId: BRAND_ID }));
    expect(JSON.stringify(log.mock.calls)).toContain("duplicate key");
    log.mockRestore();
  });

  it("Save edit shows one plain sentence, keeps the typed values and logs the details", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: DB_DETAIL } } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const data = new FormData();
    data.set("profile_md", "## Who they are\n" + "Coach Sana helps new team leads. ".repeat(10));
    for (let n = 1; n <= 4; n++) {
      data.set(`pillar_name_${n}`, `Pillar ${n}`);
      data.set(`pillar_description_${n}`, `What pillar ${n} is about.`);
    }
    const state = await saveProfileEdit(BRAND_ID, idle, data);
    expect(state).toMatchObject({ status: "error", message: "Couldn't save the profile. Please try again in a minute." });
    expect(state.values?.pillars).toHaveLength(4);
    expect(log).toHaveBeenCalledWith("[admin] save profile failed", expect.objectContaining({ brandId: BRAND_ID }));
    log.mockRestore();
  });
});

describe("Save profile edit", () => {
  function form(pillarCount: number) {
    const data = new FormData();
    data.set("profile_md", "## Who they are\n" + "Coach Sana helps new team leads. ".repeat(10));
    for (let n = 1; n <= pillarCount; n++) {
      data.set(`pillar_name_${n}`, `Pillar ${n}`);
      data.set(`pillar_description_${n}`, `What pillar ${n} is about.`);
    }
    return data;
  }

  it("checks admin first", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(saveProfileEdit(BRAND_ID, idle, form(4))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("saves the edit as a new version", async () => {
    const state = await saveProfileEdit(BRAND_ID, idle, form(5));
    expect(state).toMatchObject({ status: "ok", message: "Profile version 2 saved." });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_brand_id: BRAND_ID, p_source: "edited" });
    expect((rpc.mock.calls[0][1].p_pillars as unknown[]).length).toBe(5);
  });

  it("asks for 4 to 6 pillars and keeps what was typed", async () => {
    const state = await saveProfileEdit(BRAND_ID, idle, form(3));
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/4 to 6 pillars/);
    expect(state.values?.pillars).toHaveLength(3);
    expect(rpc).not.toHaveBeenCalled();
  });
});
