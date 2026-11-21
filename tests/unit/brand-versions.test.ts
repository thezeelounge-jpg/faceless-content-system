import { describe, expect, it, vi } from "vitest";
import { MAX_PILLARS, profileFromFormData, saveBrandVersion } from "@/lib/brand-versions";

const PROFILE = "## Who they are\n" + "A clinic for busy parents. ".repeat(10);
const PILLARS = [
  { name: "Fever myths", description: "What parents get wrong about fevers." },
  { name: "Clinic life", description: "Behind the scenes at the clinic." },
  { name: "Prevention", description: "Small habits that keep kids well." },
  { name: "Questions", description: "Answers to questions parents ask." },
];

function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async (_name: string, _args: unknown) => result);
  return { rpc };
}

describe("reading the profile edit form", () => {
  it("keeps filled pillar rows and skips empty ones", () => {
    const data = new FormData();
    data.set("profile_md", `  ${PROFILE}  `);
    PILLARS.forEach((p, i) => {
      data.set(`pillar_name_${i + 1}`, p.name);
      data.set(`pillar_description_${i + 1}`, p.description);
    });
    data.set("pillar_name_5", "");
    data.set("pillar_description_5", " ");
    const out = profileFromFormData(data);
    expect(out.profile_md).toBe(PROFILE.trim());
    expect(out.pillars).toEqual(PILLARS);
    expect(MAX_PILLARS).toBe(6);
  });
});

describe("saving a version", () => {
  it("checks the profile, calls save_brand_version and returns the new number", async () => {
    const db = fakeDb({ data: 2, error: null });
    const version = await saveBrandVersion(db, "brand-1", { profile_md: PROFILE, pillars: PILLARS }, "edited");
    expect(version).toBe(2);
    expect(db.rpc).toHaveBeenCalledWith("save_brand_version", {
      p_brand_id: "brand-1",
      p_profile_md: PROFILE.trim(),
      p_pillars: PILLARS,
      p_source: "edited",
    });
  });

  it("refuses 3 pillars before touching the database", async () => {
    const db = fakeDb({ data: 1, error: null });
    await expect(
      saveBrandVersion(db, "brand-1", { profile_md: PROFILE, pillars: PILLARS.slice(0, 3) }, "edited"),
    ).rejects.toThrow();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("turns a database error into a plain error", async () => {
    const db = fakeDb({ data: null, error: { message: "Brand x not found." } });
    await expect(
      saveBrandVersion(db, "brand-1", { profile_md: PROFILE, pillars: PILLARS }, "generated"),
    ).rejects.toThrow(/Couldn't save the profile: Brand x not found/);
  });
});
