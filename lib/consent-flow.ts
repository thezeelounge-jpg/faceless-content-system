import "server-only";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseAdminEmails } from "@/lib/admin";
import type { ClaudeDeps } from "@/lib/claude";
import { reshootRecipients } from "@/lib/email-recipients";
import type { ClipChecksResult } from "@/lib/clip-checks/evaluate";
import { runClipChecks } from "@/lib/clip-checks/run";
import { generateConsentWords, uploadBlockedReason, wordsExpireAt, type RandomInt } from "@/lib/consent-words";
import type { AvatarRow, ClipStorage, ConsentRow, ConsentStore } from "@/lib/consent-store-types";
import { convertToMp4 } from "@/lib/clip-checks/media";
import { CONSENT_UPLOAD, UPLOAD_TIPS, validateUpload } from "@/lib/consent-upload-rules";
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
/** Same shape as the brands.contact_email check in the migration. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type StoreDeps = { store: ConsentStore; now?: Date };

async function load(store: ConsentStore, id: string): Promise<ConsentRow> {
  const consent = UUID.test(id) ? await store.getConsent(id) : null;
  if (!consent) throw new PlainError("Consent not found.");
  return consent;
}

export async function startConsent(
  input: {
    brandId: string;
    legalName: string;
    agreed: boolean;
    ip: string | null;
    userAgent: string | null;
    /** Decision 6: the client's own email for HeyGen's consent link (optional; empty keeps the saved one). */
    clientEmail?: string;
  },
  deps: StoreDeps & { random?: RandomInt },
): Promise<ConsentRow> {
  const now = deps.now ?? new Date();
  const legalName = input.legalName.trim().replace(/\s+/g, " ");
  if (!input.agreed) throw new PlainError("Tick the box to confirm the person agrees to a digital twin.");
  if (legalName.length < 3 || legalName.length > 120) throw new PlainError("Type the person's full legal name.");
  const clientEmail = input.clientEmail?.trim().toLowerCase() ?? "";
  if (clientEmail && (!EMAIL.test(clientEmail) || clientEmail.length > 254)) {
    throw new PlainError("Type the client's email address, or leave it empty.");
  }
  const brand = UUID.test(input.brandId) ? await deps.store.getBrandContact(input.brandId) : null;
  if (!brand) throw new PlainError("Client not found.");
  if (clientEmail) await deps.store.setBrandContactEmail(brand.id, clientEmail);
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
  if (!objectPath.startsWith(prefix) || !/^[0-9a-f-]{36}\.(mp4|webm|mov)$/i.test(name)) {
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
    subject: `Reshoot needed for ${brandName} (forward these tips to the client)`,
    body: [
      `The consent clip for ${brandName} needs a reshoot. Suggested message for the client:`,
      "",
      "Thanks for your clip. Our checks found a few things to fix before we can make your twin:",
      "",
      ...tips.map((tip) => `- ${tip}`),
      "",
      "The full recording guide is in the app. Remember to say the 3 new words at the start.",
    ].join("\n"),
  };
}

const CLIP_CHANGED = "A new clip was uploaded while this one was being checked. Check the new clip.";

/** Stores the converted mp4 next to the .mov, makes it the clip, then deletes the .mov. Returns the new path. */
async function replaceWithMp4(
  consent: ConsentRow,
  movPath: string,
  mp4File: string,
  deps: { store: ConsentStore; storage: ClipStorage },
): Promise<string> {
  const mp4Path = `${consent.brand_id}/${consent.id}/${randomUUID()}.mp4`;
  await deps.storage.upload(mp4Path, new Uint8Array(await readFile(mp4File)), "video/mp4");
  if (!(await deps.store.swapClipPath(consent.id, movPath, mp4Path))) {
    await deps.storage.remove(mp4Path).catch(() => null);
    throw new PlainError(CLIP_CHANGED);
  }
  await deps.storage.remove(movPath).catch(() => null);
  return mp4Path;
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
    /** Who gets reshoot tips. Defaults to ADMIN_EMAILS. */
    adminEmails?: string[];
  },
): Promise<ClipChecksResult> {
  const consent = await load(deps.store, consentId);
  let clipPath = consent.clip_path;
  if (!clipPath) throw new PlainError("Upload the clip first.");
  const brand = await deps.store.getBrandContact(consent.brand_id);
  if (!brand) throw new PlainError("Client not found.");

  const ext = path.extname(clipPath).toLowerCase() || ".mp4";
  let file = path.join(os.tmpdir(), `consent-${randomUUID()}${ext}`);
  const temps = [file];
  let result: ClipChecksResult;
  try {
    await writeFile(file, await deps.storage.download(clipPath));
    if (ext === ".mov") {
      // Decision 5: HeyGen takes mp4/webm, so a .mov becomes an mp4 first; the
      // mp4 is what we check, store and (later) send to HeyGen.
      const mp4 = path.join(os.tmpdir(), `consent-${randomUUID()}.mp4`);
      temps.push(mp4);
      try {
        await convertToMp4(file, mp4);
      } catch {
        throw new PlainError(UPLOAD_TIPS.bad_mov);
      }
      clipPath = await replaceWithMp4(consent, clipPath, mp4, deps);
      file = mp4;
    }
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
    await Promise.all(temps.map((t) => rm(t, { force: true })));
  }

  // SF4: save only onto the clip we measured (a re-upload meanwhile wins).
  if (!(await deps.store.saveClipChecks(consentId, clipPath, result))) {
    throw new PlainError(CLIP_CHANGED);
  }
  // Decision 6: reshoot tips go to the admins only; they talk to the client.
  if (!result.passed) {
    for (const to of reshootRecipients(deps.adminEmails ?? parseAdminEmails(process.env.ADMIN_EMAILS))) {
      await deps.store.insertOutbox({
        brand_id: brand.id,
        consent_id: consent.id,
        to_email: to,
        kind: "reshoot_tips",
        ...reshootEmail(brand.name, result.tips),
      });
    }
  }
  return result;
}

const CHECK_STOPPED = "The clip check stopped unexpectedly. Press “Run checks” to try again.";

export type ClipCheckOutcome = { status: "done"; passed: boolean } | { status: "failed" } | { status: "skipped" };

/**
 * Decision 2: one clip-check run, as the check-clip Trigger task (or the page,
 * when no Trigger key exists) runs it. Saves clip_check_status on the consent:
 * running → done | failed. Our own plain failures (bad .mov, clip changed)
 * are saved and returned, not thrown, so the task does not retry pointlessly;
 * anything unexpected is saved as a plain sentence and thrown, so it retries.
 */
export async function runClipCheckJob(
  consentId: string,
  clipPath: string,
  deps: Parameters<typeof checkConsentClip>[1],
): Promise<ClipCheckOutcome> {
  const consent = await load(deps.store, consentId);
  // A newer clip (or a decision) since this run was queued: its own run counts.
  if (consent.clip_path !== clipPath || consent.admin_status !== "pending") return { status: "skipped" };
  await deps.store.updateConsent(consentId, { clip_check_status: "running", clip_check_error: null }, true);
  try {
    const result = await checkConsentClip(consentId, deps);
    await deps.store.updateConsent(consentId, { clip_check_status: "done", clip_check_error: null }, true);
    return { status: "done", passed: result.passed };
  } catch (error) {
    const plain = error instanceof PlainError;
    await deps.store
      .updateConsent(consentId, { clip_check_status: "failed", clip_check_error: plain ? error.message : CHECK_STOPPED }, true)
      .catch(() => null);
    if (plain) return { status: "failed" };
    throw error;
  }
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
