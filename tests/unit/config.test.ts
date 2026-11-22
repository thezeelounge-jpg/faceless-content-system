import { afterEach, describe, expect, it, vi } from "vitest";
import {
  envStatus,
  getSiteUrl,
  getSupabasePublicConfig,
  isMockClaude,
  isMockHeygen,
  isMockPexels,
  isMockStt,
} from "@/lib/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("money-safety mock switches", () => {
  it("stay ON unless set to exactly 'false'", () => {
    for (const value of [undefined, "", "true", "yes", "FALSE ", "0"]) {
      vi.stubEnv("MOCK_HEYGEN", value as string);
      vi.stubEnv("MOCK_STT", value as string);
      vi.stubEnv("MOCK_CLAUDE", value as string);
      const expected = value?.trim() !== "false";
      expect(isMockHeygen()).toBe(expected);
      expect(isMockStt()).toBe(expected);
      expect(isMockClaude()).toBe(expected);
    }
  });

  it("turn OFF only with 'false'", () => {
    vi.stubEnv("MOCK_HEYGEN", "false");
    vi.stubEnv("MOCK_STT", "false");
    vi.stubEnv("MOCK_CLAUDE", "false");
    expect(isMockHeygen()).toBe(false);
    expect(isMockStt()).toBe(false);
    expect(isMockClaude()).toBe(false);
  });

  it("p4-b2: MOCK_PEXELS (B-roll search) follows the same rule: mock unless exactly 'false'", () => {
    for (const value of [undefined, "", "true", "yes", "FALSE ", "0", "False"]) {
      vi.stubEnv("MOCK_PEXELS", value as string);
      expect(isMockPexels()).toBe(value?.trim() !== "false");
    }
    vi.stubEnv("MOCK_PEXELS", undefined as unknown as string);
    expect(isMockPexels()).toBe(true);
    vi.stubEnv("MOCK_PEXELS", " false ");
    expect(isMockPexels()).toBe(false);
  });

  it("keeps Claude in mock mode when MOCK_CLAUDE is missing", () => {
    vi.stubEnv("MOCK_CLAUDE", undefined as unknown as string);
    expect(isMockClaude()).toBe(true);
  });
});

describe("site address", () => {
  it("uses NEXT_PUBLIC_SITE_URL without a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com/");
    expect(getSiteUrl()).toBe("https://app.example.com");
  });

  it("falls back to the Vercel preview address, then localhost", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_URL", "creator-tool-abc.vercel.app");
    expect(getSiteUrl()).toBe("https://creator-tool-abc.vercel.app");
    vi.stubEnv("VERCEL_URL", "");
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });
});

describe("supabase settings", () => {
  it("returns null until both public values are set", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect(getSupabasePublicConfig()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    expect(getSupabasePublicConfig()).toEqual({ url: "https://x.supabase.co", publishableKey: "sb_publishable_test" });
  });

  it("reports which keys are set without exposing values", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_should_never_appear");
    const status = envStatus();
    expect(status.find((item) => item.name === "SUPABASE_SECRET_KEY")?.isSet).toBe(true);
    expect(JSON.stringify(status)).not.toContain("sb_secret_should_never_appear");
  });
});
