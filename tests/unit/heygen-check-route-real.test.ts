import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SF5 safety net: even if mock mode broke (isMockHeygen forced to false) and a
// key were present, the check route could not reach HeyGen from a test. The
// global thrower (tests/setup/no-network.ts) stops the request, and the route
// gives its plain "could not reach" error.

const getCurrentUser = vi.fn();
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => getCurrentUser() }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isMockHeygen: () => false,
}));

const { GET } = await import("@/app/api/admin/heygen-check/route");

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.HEYGEN_API_KEY = "dummy-key-for-test";
  getCurrentUser.mockResolvedValue({ id: "u1", email: "admin@x.com", isAdmin: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("HeyGen check route with mock mode forced off", () => {
  it("throws inside the test (network disabled) instead of reaching HeyGen", async () => {
    const spy = vi.spyOn(globalThis, "fetch"); // passthrough to the thrower, never the real fetch
    const response = await GET();
    expect(await response.json()).toEqual({ ok: false, mock: false, message: "Could not reach HeyGen. Try again later." });
    expect(response.status).toBe(502);
    expect(spy).toHaveBeenCalledWith("https://api.heygen.com/v3/users/me", expect.anything());
    // The thrower (not a network error) is what stopped it.
    await expect(spy.mock.results[0].value).rejects.toThrow("network disabled in tests: https://api.heygen.com/v3/users/me");
  });
});
