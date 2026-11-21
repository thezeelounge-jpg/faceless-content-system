import "server-only";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClaudeDeps } from "@/lib/claude";
import type { ClipChecksResult } from "@/lib/clip-checks/evaluate";
import { runClipChecks } from "@/lib/clip-checks/run";
import { generateConsentWords, uploadBlockedReason, wordsExpireAt, type RandomInt } from "@/lib/consent-words";
import type { AvatarRow, ClipStorage, ConsentRow, ConsentStore } from "@/lib/consent-store-types";
import { CONSENT_UPLOAD, validateUpload } from "@/lib/consent-upload-rules";
import { PlainError } from "@/lib/plain-error";

// The consent clip, step by step (admin now, customers in Phase 6):
// start (legal name + checkbox + 3 words) → upload to the private bucket →
// automatic clip checks → admin approves or rejects.
// Rule (CLAUDE.md): no twin before admin approval of the consent clip. The
// avatar row is only created here, by approveConsent.

// Upload rules (types, 50 MB cap, grace) live in lib/consent-upload-rules.ts,
// shared with the browser.
export { CONSENT_UPLOAD, validateUpload } from "@/lib/consent-upload-rules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoreDeps = { store: ConsentStore; now?: Date };

async function load(store: ConsentStore, id: string): Promise<ConsentRow> {
  const consent = UUID.test(id) ? await store.getConsent(id) : null;
  if (!consent) throw new PlainError("Consent not found.");
  return consent;
}

export async function startConsent(
  input: { brandId: string; legalName: string; agreed: boolean; ip: string | null; userAgent: string | null },
  deps: StoreDeps & { random?: RandomInt },
): Promise<ConsentRow> {
  const now = deps.now ?? new Date();
  const legalName = input.legalName.trim().replace(/\s+/g, " ");
  if (!input.agreed) throw new PlainError("Tick the box to confirm the person agrees to a digital twin.");
  if (legalName.length < 3 || legalName.length > 120) throw new PlainError("Type the person's full legal name.");
  const brand = UUID.test(input.brandId) ? await deps.store.getBrandContact(input.brandId) : null;
  if (!brand) throw new PlainError("Client not found.");
  return deps.store.insertConsent({
    brand_id: brand.id,
    person_legal_name: legalName,
    checkbox_at: now.toISOString(),
    words: generateConsentWords(deps.random),
    words_expire_at: wordsExpireAt(now).toISOString(),
    ip: input.ip?.slice(0, 100) ?? null,
    user_agent: input.userAgent?.slice(0, 500) ?? null,
  });
}

/** New words and a new 30 minutes. A clip with the old words no longer counts. */
export async function newWords(consentId: string, deps: StoreDeps & { random?: RandomInt }): Promise<ConsentRow> {
  const now = deps.now ?? new Date();
  await load(deps.store, consentId);
  const saved = await deps.store.updateConsent(
    consentId,
    {
      words: generateConsentWords(deps.random),
      words_expire_at: wordsExpireAt(now).toISOString(),
      clip_path: null,
      clip_checks: null,
    },
    true,
  );
  if (!saved) throw new PlainError("This consent is already decided. Start a new consent instead.");
  return saved;
}

/** A one-time signed upload into the private bucket, at a path we choose. */
export async function prepareUpload(
  consentId: string,
  file: { name: string; type: string; size: number },
  deps: StoreDeps & { storage: ClipStorage },
): Promise<{ path: string; token: string }> {
  const consent = await load(deps.store, consentId);
  const blocked = uploadBlockedReason(consent, deps.now);
  if (blocked) throw new PlainError(blocked);
  const invalid = validateUpload(file);
  if (invalid) throw new PlainError(invalid);
  const objectPath = `${consent.brand_id}/${consent.id}/${randomUUID()}.${CONSENT_UPLOAD.types[file.type]}`;
  return deps.storage.createUploadUrl(objectPath);
}

/** After the browser upload: checks the stored file itself, then saves clip_path. */
export async function confirmUpload(
  consentId: string,
  objectPath: string,
  deps: StoreDeps & { storage: ClipStorage },
): Promise<ConsentRow> {
  const consent = await load(deps.store, consentId);
  const prefix = `${consent.brand_id}/${consent.id}/`;
  const name = objectPath.slice(prefix.length);
  if (!objectPath.startsWith(prefix) || !/^[0-9a-f-]{36}\.(mp4|webm)$/i.test(name)) {
    throw new PlainError("That upload does not belong to this consent.");
  }
  const decided = decidedError(consent);
  if (decided) throw decided;
  // SF1: the upload token outlives the words (2 hours vs 30 minutes), so the
  // window is checked again here, with a short grace for an in-flight upload.
  const now = deps.now ?? new Date();
  const graceNow = new Date(now.getTime() - CONSENT_UPLOAD.confirm_grace_s * 1000);
  const blocked = uploadBlockedReason(consent, graceNow);
  if (blocked) throw new PlainError(blocked);
  const info = await deps.storage.info(objectPath);
  if (!info) throw new PlainError("We couldn't find the uploaded clip. Please upload it again.");
  const invalid = validateUpload({ name, type: info.contentType, size: info.size });
  if (invalid) throw new PlainError(invalid);
  const saved = await deps.store.updateConsent(consentId, { clip_path: objectPath, clip_checks: null }, true);
  if (!saved) throw new PlainError("This consent is already decided. Start a new consent instead.");
  return saved;
}

export async function clipPlaybackUrl(consent: Pick<ConsentRow, "clip_path">, storage: ClipStorage): Promise<string | null> {
  return consent.clip_path ? storage.signedUrl(consent.clip_path, CONSENT_UPLOAD.playback_seconds) : null;
}

function reshootEmail(brandName: string, tips: string[]): { subject: string; body: string } {
  return {
    subject: "Please record your clip again",
    body: [
      `Hi ${brandName},`,
      "",
      "Thanks for your clip. Our checks found a few things to fix before we can make your twin:",
      "",
      ...tips.map((tip) => `- ${tip}`),
      "",
      "The full recording guide is in the app. Remember to say the 3 new words at the start.",
    ].join("\n"),
  };
}

/**
 * Runs the automatic checks on the uploaded clip and saves them to
 * consents.clip_checks. A failed clip "emails" reshoot tips (mock outbox only).
 */
export async function checkConsentClip(
  consentId: string,
  deps: StoreDeps & {
    storage: ClipStorage;
    claude?: Partial<ClaudeDeps>;
    /** Mock/test only: the fixture name that picks the mock face answer. */
    fixtureName?: string;
  },
): Promise<ClipChecksResult> {
  const consent = await load(deps.store, consentId);
  const clipPath = consent.clip_path;
  if (!clipPath) throw new PlainError("Upload the clip first.");
  const brand = await deps.store.getBrandContact(consent.brand_id);
  if (!brand) throw new PlainError("Client not found.");

  const ext = path.extname(clipPath) || ".mp4";
  const file = path.join(os.tmpdir(), `consent-${randomUUID()}${ext}`);
  let result: ClipChecksResult;
  try {
    await writeFile(file, await deps.storage.download(clipPath));
    const measured = await runClipChecks(file, {
      brand: {
        id: brand.id, name: brand.name, niche: null, audience: null, offers: null, tone: null, sound_answers: {},
        samples: null, banned_words: [], language: "en", profile_md: null, pillars: [], words_per_second: 2.4,
      },
      clipName: deps.fixtureName ?? clipPath,
      claude: deps.claude,
      now: deps.now,
    });
    result = { ...measured, clip_path: clipPath };
  } finally {
    await rm(file, { force: true });
  }

  // SF4: save only onto the clip we measured (a re-upload meanwhile wins).
  if (!(await deps.store.saveClipChecks(consentId, clipPath, result))) {
    throw new PlainError("A new clip was uploaded while this one was being checked. Check the new clip.");
  }
  if (!result.passed && brand.ownerEmail) {
    await deps.store.insertOutbox({
      brand_id: brand.id,
      consent_id: consent.id,
      to_email: brand.ownerEmail,
      kind: "reshoot_tips",
      ...reshootEmail(brand.name, result.tips),
    });
  }
  return result;
}

function decidedError(consent: ConsentRow): PlainError | null {
  if (consent.admin_status === "approved") return new PlainError("This consent is already approved.");
  if (consent.admin_status === "rejected") return new PlainError("This consent was rejected.");
  return null;
}

const cleanNote = (note: string) => note.trim().slice(0, 500) || null;

/** Approve the clip: the only place an avatar row (the twin) can begin. */
export async function approveConsent(
  consentId: string,
  note: string,
  deps: StoreDeps,
): Promise<{ consent: ConsentRow; avatar: AvatarRow }> {
  const consent = await load(deps.store, consentId);
  const decided = decidedError(consent);
  if (decided) throw decided;
  if (!consent.clip_path) throw new PlainError("Upload the clip first.");
  // SF4: the pass must be for THIS clip.
  if (!consent.clip_checks?.passed || consent.clip_checks.clip_path !== consent.clip_path) throw new PlainError("The clip checks must pass before approval. Ask for a reshoot.");
  const approved = await deps.store.updateConsent(consentId, { admin_status: "approved", admin_note: cleanNote(note) }, true);
  if (!approved) throw new PlainError("This consent is already decided.");
  const avatar = await deps.store.insertAvatar({ brand_id: consent.brand_id, consent_id: consent.id, status: "training" });
  return { consent: approved, avatar };
}

export async function rejectConsent(consentId: string, note: string, deps: StoreDeps): Promise<ConsentRow> {
  const consent = await load(deps.store, consentId);
  const decided = decidedError(consent);
  if (decided) throw decided;
  if (!cleanNote(note)) throw new PlainError("Write a short note saying why.");
  const rejected = await deps.store.updateConsent(consentId, { admin_status: "rejected", admin_note: cleanNote(note) }, true);
  if (!rejected) throw new PlainError("This consent is already decided.");
  return rejected;
}
