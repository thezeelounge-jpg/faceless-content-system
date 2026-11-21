import { describe, expect, it } from "vitest";
import { isAdminEmail, parseAdminEmails } from "@/lib/admin";

describe("admin emails", () => {
  it("parses a comma-separated list, ignoring spaces, case and blanks", () => {
    expect(parseAdminEmails(" Owner@Example.com, ,second@example.com ")).toEqual([
      "owner@example.com",
      "second@example.com",
    ]);
  });

  it("treats a missing list as no admins", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(isAdminEmail("owner@example.com", undefined)).toBe(false);
    expect(isAdminEmail("owner@example.com", "")).toBe(false);
  });

  it("matches emails without caring about case", () => {
    expect(isAdminEmail("OWNER@example.com", "owner@example.com")).toBe(true);
    expect(isAdminEmail("someone@example.com", "owner@example.com")).toBe(false);
  });

  it("never treats an empty email as admin", () => {
    expect(isAdminEmail("", "owner@example.com")).toBe(false);
    expect(isAdminEmail(null, "owner@example.com")).toBe(false);
  });
});
