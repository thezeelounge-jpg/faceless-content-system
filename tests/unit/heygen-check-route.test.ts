import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/admin/heygen-check: admin-only check of HeyGen's GET /v3/users/me.
// In mock mode it answers from the fixture and never touches the network.

const getCurrentUser = vi.fn();
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => getCurrentUser() }));

const { GET } = await import("@/app/api/admin/heygen-check/route");

const savedEnv = { ...process.env };
beforeEach(() => {
  getCurrentUser.mockReset();
  delete process.env.MOCK_HEYGEN;
  process.env.HEYGEN_API_KEY = "dummy-key-for-test";
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("HeyGen check route", () => {
  it("admin in mock mode gets the mock user and no fetch happens", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", email: "admin@x.com", isAdmin: true });
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      mock: true,
      message: "Mock mode: no HeyGen call was made.",
      user: { billingType: "wallet", username: "mock-heygen-user" },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("customers and logged-out visitors get 404 and HeyGen is never asked", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
    for (const user of [null, { id: "u2", email: "c@x.com", isAdmin: false }]) {
      getCurrentUser.mockResolvedValue(user);
      const response = await GET();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, message: "Not found." });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("real mode without a key gives a plain error (and no request)", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", email: "admin@x.com", isAdmin: true });
    process.env.MOCK_HEYGEN = "false";
    delete process.env.HEYGEN_API_KEY;
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      mock: false,
      message: "HeyGen is not set up. Add HEYGEN_API_KEY, or keep MOCK_HEYGEN=true.",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
