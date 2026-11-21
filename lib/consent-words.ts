import { randomInt } from "node:crypto";

// The 3 consent words: the person says them at the start of the clip, so the
// admin can tell the clip was recorded now, for us, by that person.
// Words come from a fixed list of short, plain words (easy in English, Urdu
// and Hindi accents), picked on the server, and expire after 30 minutes.

export const WORDS_VALID_MINUTES = 30;

export const CONSENT_WORD_LIST = [
  "apple", "river", "garden", "candle", "pillow", "rocket", "orange", "window",
  "button", "basket", "planet", "pencil", "silver", "tiger", "yellow", "monkey",
  "pocket", "summer", "winter", "camera", "doctor", "forest", "guitar", "island",
  "jacket", "kitten", "ladder", "marble", "number", "office", "parrot", "rabbit",
  "saddle", "tunnel", "violin", "wallet", "zebra", "bottle", "carpet", "dinner",
  "engine", "flower", "honey", "lemon", "mango", "ocean", "puzzle", "spoon",
] as const;

/** Returns a whole number from 0 to max - 1. Tests pass a fixed one. */
export type RandomInt = (max: number) => number;

/** Three different words from the list. */
export function generateConsentWords(random: RandomInt = randomInt): string[] {
  const pool: string[] = [...CONSENT_WORD_LIST];
  const words: string[] = [];
  for (let i = 0; i < 3; i++) {
    const index = random(pool.length);
    words.push(pool.splice(index, 1)[0]);
  }
  return words;
}

export function wordsExpireAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + WORDS_VALID_MINUTES * 60_000);
}

export function wordsExpired(expireAt: Date | string, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(expireAt).getTime();
}

export type UploadGateConsent = {
  words_expire_at: string;
  admin_status: "pending" | "approved" | "rejected";
};

/** Why an upload is not allowed right now, in plain words, or null when it is. */
export function uploadBlockedReason(consent: UploadGateConsent, now: Date = new Date()): string | null {
  if (consent.admin_status === "approved") {
    return "This consent is already approved. Start a new consent to upload another clip.";
  }
  if (consent.admin_status === "rejected") {
    return "This consent was rejected. Start a new consent to upload another clip.";
  }
  if (wordsExpired(consent.words_expire_at, now)) {
    return "The 3 words have expired. Press “New words”, then record again saying the new words.";
  }
  return null;
}
