import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/posts.ts with the database swapped for a spy: ids from the browser
// that aren't UUIDs must never reach Supabase.
const createAdminClient = vi.fn(() => {
  throw new Error("the database should not be called");
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminClient() }));

const { getPost, getScriptForChecks, isUuid, savePostProblem } = await import("@/lib/posts");

beforeEach(() => {
  createAdminClient.mockClear();
});

describe("ids from the browser", () => {
  it("isUuid accepts real UUIDs only", () => {
    expect(isUuid("20000000-0000-0000-0000-000000000001")).toBe(true);
    expect(isUuid("2000000000000000000000000000000000-1")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
  });

  it("getPost: a bad id is 'not found' (null) without calling the database", async () => {
    // Write script turns null into "Post not found."
    await expect(getPost("not-a-uuid")).resolves.toBeNull();
    await expect(getPost("1; drop table posts")).resolves.toBeNull();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("getScriptForChecks and savePostProblem skip bad ids too", async () => {
    await expect(getScriptForChecks("script-9")).resolves.toBeNull();
    await expect(savePostProblem("nope", "x")).resolves.toBeUndefined();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
