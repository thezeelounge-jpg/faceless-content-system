import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, isAdminPath, isProtectedPath, safeNextPath } from "@/lib/safe-redirect";

describe("safeNextPath", () => {
  it("keeps paths inside the app", () => {
    expect(safeNextPath("/admin/clients")).toBe("/admin/clients");
    expect(safeNextPath("/dashboard?tab=1")).toBe("/dashboard?tab=1");
  });

  it("blocks anything that could leave the app", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "evil", "/x?u=https://evil"]) {
      expect(safeNextPath(bad)).toBe(DEFAULT_AFTER_LOGIN);
    }
  });

  it("avoids login loops and non-strings", () => {
    expect(safeNextPath("/login")).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeNextPath("/auth/callback")).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeNextPath(null)).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeNextPath(undefined)).toBe(DEFAULT_AFTER_LOGIN);
  });
});

describe("protected paths", () => {
  it("knows which pages need a login", () => {
    expect(isProtectedPath("/dashboard")).toBe(true);
    expect(isProtectedPath("/admin/settings")).toBe(true);
    expect(isProtectedPath("/administrator")).toBe(false);
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/")).toBe(false);
  });

  it("knows which pages are admin-only", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/qa")).toBe(true);
    expect(isAdminPath("/dashboard")).toBe(false);
  });
});
