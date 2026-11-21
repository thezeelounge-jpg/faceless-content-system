import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlainError } from "@/lib/plain-error";

const BRAND_ID = "10000000-0000-0000-0000-000000000001";
const ENTRY_ID = "30000000-0000-0000-0000-000000000001";

const requireAdmin = vi.fn();
const getBrand = vi.fn();
const addPronunciation = vi.fn();
const approvePronunciation = vi.fn();
const updatePronunciation = vi.fn();

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/brands", () => ({ getBrand: (id: string) => getBrand(id) }));
vi.mock("@/lib/pronunciations", () => ({
  addPronunciation: (...args: unknown[]) => addPronunciation(...args),
  approvePronunciation: (...args: unknown[]) => approvePronunciation(...args),
  updatePronunciation: (...args: unknown[]) => updatePronunciation(...args),
}));

const actions = await import("@/app/admin/clients/[id]/names/actions");

const idle = { status: "idle" as const, message: "" };
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  getBrand.mockReset().mockResolvedValue({ id: BRAND_ID, name: "Dr Ayesha Clinic" });
  addPronunciation.mockReset().mockResolvedValue(undefined);
  approvePronunciation.mockReset().mockResolvedValue(true);
  updatePronunciation.mockReset().mockResolvedValue(true);
});

describe("admin check comes before anything else", () => {
  it.each([
    ["add", () => actions.addName(BRAND_ID, idle, form({ written: "Ayesha", say_as: "aa-ye-sha" }))],
    ["approve", () => actions.approveName(BRAND_ID, ENTRY_ID, idle)],
    ["edit", () => actions.editName(BRAND_ID, ENTRY_ID, idle, form({ written: "Ayesha", say_as: "aa-ye-sha" }))],
  ])("%s", async (_name, run) => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getBrand).not.toHaveBeenCalled();
    expect(addPronunciation).not.toHaveBeenCalled();
    expect(approvePronunciation).not.toHaveBeenCalled();
    expect(updatePronunciation).not.toHaveBeenCalled();
  });
});

describe("Add", () => {
  it("saves a trimmed, approved manual entry", async () => {
    const state = await actions.addName(BRAND_ID, idle, form({ written: "  Ayesha ", say_as: " aa-ye-sha " }));
    expect(state).toEqual({ status: "ok", message: "Saved: “Ayesha” is said “aa-ye-sha”." });
    expect(addPronunciation).toHaveBeenCalledWith(BRAND_ID, { written: "Ayesha", say_as: "aa-ye-sha" });
  });

  it.each([
    [{ written: "", say_as: "x" }, "Type the word as it is written."],
    [{ written: "Ayesha", say_as: "  " }, "Type how to say it."],
    [{ written: "Ayesha", say_as: "aa 2 sha" }, "Write “say as” in letters only (no digits or new lines)."],
    [{ written: "x".repeat(81), say_as: "x" }, "Keep the written word under 80 characters."],
  ])("rejects %o with a plain sentence and saves nothing", async (values, message) => {
    expect(await actions.addName(BRAND_ID, idle, form(values))).toEqual({ status: "error", message });
    expect(addPronunciation).not.toHaveBeenCalled();
  });

  it("shows our own plain sentence for a word that is already in the list", async () => {
    addPronunciation.mockRejectedValue(new PlainError("“Ayesha” is already in the list. Edit it below instead."));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await actions.addName(BRAND_ID, idle, form({ written: "Ayesha", say_as: "aa-ye-sha" }))).toEqual({
      status: "error",
      message: "“Ayesha” is already in the list. Edit it below instead.",
    });
  });

  it("hides database errors behind one plain sentence", async () => {
    addPronunciation.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await actions.addName(BRAND_ID, idle, form({ written: "Ayesha", say_as: "aa-ye-sha" }));
    expect(state).toEqual({ status: "error", message: "Couldn't save. Please try again in a minute." });
    expect(log).toHaveBeenCalled();
  });

  it("says so plainly for an unknown client", async () => {
    getBrand.mockResolvedValue(null);
    expect(await actions.addName(BRAND_ID, idle, form({ written: "Ayesha", say_as: "aa-ye-sha" }))).toEqual({
      status: "error",
      message: "Client not found.",
    });
    expect(addPronunciation).not.toHaveBeenCalled();
  });
});

describe("Approve", () => {
  it("approves the entry on this brand only", async () => {
    expect(await actions.approveName(BRAND_ID, ENTRY_ID, idle)).toEqual({ status: "ok", message: "Approved." });
    expect(approvePronunciation).toHaveBeenCalledWith(BRAND_ID, ENTRY_ID);
  });

  it("refuses a bad id without touching the database", async () => {
    expect(await actions.approveName(BRAND_ID, "not-an-id", idle)).toEqual({ status: "error", message: "Name not found." });
    expect(approvePronunciation).not.toHaveBeenCalled();
  });

  it("says so when nothing matched", async () => {
    approvePronunciation.mockResolvedValue(false);
    expect(await actions.approveName(BRAND_ID, ENTRY_ID, idle)).toEqual({ status: "error", message: "Name not found." });
  });
});

describe("Edit", () => {
  it("saves the new spelling and say-as on this brand only", async () => {
    const state = await actions.editName(BRAND_ID, ENTRY_ID, idle, form({ written: "Ayesha", say_as: "aa-yay-sha" }));
    expect(state).toEqual({ status: "ok", message: "Saved: “Ayesha” is said “aa-yay-sha”." });
    expect(updatePronunciation).toHaveBeenCalledWith(BRAND_ID, ENTRY_ID, { written: "Ayesha", say_as: "aa-yay-sha" });
  });

  it("validates like Add", async () => {
    expect(await actions.editName(BRAND_ID, ENTRY_ID, idle, form({ written: "Ayesha", say_as: "" }))).toEqual({
      status: "error",
      message: "Type how to say it.",
    });
    expect(updatePronunciation).not.toHaveBeenCalled();
  });

  it("says so when nothing matched", async () => {
    updatePronunciation.mockResolvedValue(false);
    expect(await actions.editName(BRAND_ID, ENTRY_ID, idle, form({ written: "Ayesha", say_as: "x" }))).toEqual({
      status: "error",
      message: "Name not found.",
    });
  });
});
