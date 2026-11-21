import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdmin = vi.fn();
const insert = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT ${url}`);
});

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: (row: unknown) => {
        insert(table, row);
        return {
          select: () => ({ single: async () => ({ data: { id: "brand-123" }, error: null }) }),
        };
      },
    }),
  }),
}));

const { createManagedBrand } = await import("@/app/admin/clients/new/actions");

function validForm() {
  const data = new FormData();
  const fields: [string, string][] = [
    ["name", "Test Brand"],
    ["niche", "coach"],
    ["audience", "New managers"],
    ["offers", "1:1 coaching"],
    ["tone", "Calm"],
    ["sound_greeting", "Hello friends"],
    ["sound_phrases", "Let's be honest"],
    ["sound_never_say", "Hustle"],
    ["sample_1", "Leadership is mostly listening, and nobody teaches it."],
    ["sample_2", "Your team copies what you do, not what you say. Always."],
    ["sample_3", "A good one-on-one has one question at its heart: what's in your way?"],
    ["language", "en"],
    ["posting_days", "2"],
    ["posting_days", "4"],
    ["posts_per_week", "2"],
  ];
  for (const [key, value] of fields) data.append(key, value);
  return data;
}

const idle = { status: "idle" as const, message: "" };

beforeEach(() => {
  requireAdmin.mockReset();
  insert.mockReset();
  redirect.mockClear();
});

describe("New client action", () => {
  it("checks admin before anything else", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(createManagedBrand(idle, validForm())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns plain field errors and saves nothing when the form is wrong", async () => {
    requireAdmin.mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
    const data = validForm();
    data.set("posts_per_week", "20");
    const state = await createManagedBrand(idle, data);
    expect(state.status).toBe("error");
    expect(state.fieldErrors?.posts_per_week?.[0]).toMatch(/1 to 14/);
    // What was typed comes back, so the form can be refilled.
    expect(state.values?.name).toBe("Test Brand");
    expect(state.attempt).toBe(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("saves a managed brand owned by the admin and opens its page", async () => {
    requireAdmin.mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
    await expect(createManagedBrand(idle, validForm())).rejects.toThrow("REDIRECT /admin/clients/brand-123");
    expect(insert).toHaveBeenCalledWith(
      "brands",
      expect.objectContaining({ is_managed: true, owner_id: "admin-1", name: "Test Brand", audience_countries: ["PK"] }),
    );
  });
});
