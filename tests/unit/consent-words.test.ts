import { describe, expect, it } from "vitest";
import {
  CONSENT_WORD_LIST,
  WORDS_VALID_MINUTES,
  generateConsentWords,
  uploadBlockedReason,
  wordsExpireAt,
  wordsExpired,
} from "@/lib/consent-words";

const NOW = new Date("2026-11-22T10:00:00.000Z");

describe("consent words", () => {
  it("picks 3 different words from the fixed list", () => {
    for (let i = 0; i < 50; i++) {
      const words = generateConsentWords();
      expect(words).toHaveLength(3);
      expect(new Set(words).size).toBe(3);
      for (const word of words) expect(CONSENT_WORD_LIST).toContain(word);
    }
  });

  it("uses the random source it is given (same numbers → same words)", () => {
    const fixed = (max: number) => max - 1; // always the last remaining word
    expect(generateConsentWords(fixed)).toEqual(generateConsentWords(fixed));
    const n = CONSENT_WORD_LIST.length;
    expect(generateConsentWords(fixed)).toEqual([
      CONSENT_WORD_LIST[n - 1],
      CONSENT_WORD_LIST[n - 2],
      CONSENT_WORD_LIST[n - 3],
    ]);
  });

  it("the list has plain, distinct, lower-case words that are easy to say", () => {
    expect(CONSENT_WORD_LIST.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CONSENT_WORD_LIST).size).toBe(CONSENT_WORD_LIST.length);
    for (const word of CONSENT_WORD_LIST) expect(word).toMatch(/^[a-z]{3,8}$/);
  });
});

describe("words expire after 30 minutes", () => {
  it("expiry is 30 minutes after now", () => {
    expect(WORDS_VALID_MINUTES).toBe(30);
    expect(wordsExpireAt(NOW).toISOString()).toBe("2026-11-22T10:30:00.000Z");
  });

  it("words are fresh before the expiry and expired at or after it", () => {
    const expireAt = wordsExpireAt(NOW);
    expect(wordsExpired(expireAt, new Date("2026-11-22T10:29:59.000Z"))).toBe(false);
    expect(wordsExpired(expireAt, new Date("2026-11-22T10:30:00.000Z"))).toBe(true);
    expect(wordsExpired("2026-11-22T10:30:00.000Z", new Date("2026-11-22T11:00:00.000Z"))).toBe(true);
  });

  it("an upload with expired words must get new words first", () => {
    const consent = { words_expire_at: "2026-11-22T10:30:00.000Z", admin_status: "pending" as const };
    expect(uploadBlockedReason(consent, new Date("2026-11-22T10:10:00.000Z"))).toBeNull();
    expect(uploadBlockedReason(consent, new Date("2026-11-22T10:31:00.000Z"))).toBe(
      "The 3 words have expired. Press “New words”, then record again saying the new words.",
    );
  });

  it("an approved or rejected consent takes no new upload", () => {
    const fresh = "2026-11-22T10:30:00.000Z";
    expect(uploadBlockedReason({ words_expire_at: fresh, admin_status: "approved" }, NOW)).toBe(
      "This consent is already approved. Start a new consent to upload another clip.",
    );
    expect(uploadBlockedReason({ words_expire_at: fresh, admin_status: "rejected" }, NOW)).toBe(
      "This consent was rejected. Start a new consent to upload another clip.",
    );
  });
});
