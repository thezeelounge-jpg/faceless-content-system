"use server";

import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { isMockHeygen, readEnv } from "@/lib/config";
import {
  approveConsent,
  confirmUpload,
  newWords,
  prepareUpload,
  rejectConsent,
  runClipCheckJob,
  startConsent,
} from "@/lib/consent-flow";
import { createClipStorage, createConsentStore } from "@/lib/consent-store";
import { heygen } from "@/lib/heygen";
import { createSpendStore } from "@/lib/heygen-spend-store";
import type { ActionState } from "@/lib/plain-error";
import { PlainError } from "@/lib/plain-error";
import { createTwin, pollTwinOnce, pollTwinUntilReady } from "@/lib/twin";
import type { checkClipTask } from "@/trigger/check-clip";
import type { createTwinTask } from "@/trigger/create-twin";

// Admin → Consents and twins. Every action checks admin FIRST, then checks
// its input with zod. Plain sentences only; details go to the server log.

const FAILED = "Something went wrong. Please try again in a minute.";
const page = (consentId: string) => `/admin/consents/${consentId}`;

const noteSchema = z.object({ note: z.string().max(500, "Keep the note under 500 characters.").default("") });
const startSchema = z.object({
  legal_name: z.string().default(""),
  agree: z.literal("on").optional(),
  client_email: z.string().max(254).default(""),
});
const fileSchema = z.object({
  name: z.string().min(1).max(300),
  type: z.string().max(100),
  size: z.number().int().nonnegative(),
});

function text(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

async function requestInfo() {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, userAgent: h.get("user-agent") };
}

function failure(label: string, context: Record<string, unknown>, error: unknown): ActionState {
  if (!(error instanceof PlainError)) logAdminError(label, context, error);
  return { status: "error", message: plainAdminMessage(error, FAILED) };
}

/** Admin → client → Consent: legal name + checkbox. Opens the consent page. */
export async function startConsentAction(brandId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = startSchema.safeParse({
    legal_name: text(formData, "legal_name"),
    agree: text(formData, "agree"),
    client_email: text(formData, "client_email"),
  });
  if (!parsed.success) return { status: "error", message: "Tick the box to confirm the person agrees to a digital twin." };
  let consentId: string;
  try {
    const { ip, userAgent } = await requestInfo();
    const consent = await startConsent(
      {
        brandId,
        legalName: parsed.data.legal_name,
        agreed: parsed.data.agree === "on",
        ip,
        userAgent,
        clientEmail: parsed.data.client_email,
      },
      { store: createConsentStore() },
    );
    consentId = consent.id;
  } catch (error) {
    return failure("[admin] start consent failed", { brandId }, error);
  }
  redirect(page(consentId));
}

export async function newWordsAction(consentId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    await newWords(consentId, { store: createConsentStore() });
    revalidatePath(page(consentId));
    return { status: "ok", message: "New words ready. They work for 30 minutes." };
  } catch (error) {
    return failure("[admin] new words failed", { consentId }, error);
  }
}

export type UploadTicket = { ok: true; path: string; token: string } | { ok: false; message: string };

/** Step 1 of an upload: checks the file details and gives a one-time signed upload. */
export async function prepareUploadAction(
  consentId: string,
  file: { name: string; type: string; size: number },
): Promise<UploadTicket> {
  await requireAdmin();
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) return { ok: false, message: "That file can't be uploaded." };
  try {
    const ticket = await prepareUpload(consentId, parsed.data, { store: createConsentStore(), storage: createClipStorage() });
    return { ok: true, ...ticket };
  } catch (error) {
    return { ok: false, message: failure("[admin] prepare upload failed", { consentId }, error).message };
  }
}

/**
 * Decision 2: the clip checks run in the check-clip Trigger task.
 * - with TRIGGER_SECRET_KEY: start the task (key = consent id + clip path,
 *   10-minute TTL so a double click starts one run, but "Run checks" later works);
 * - without it (local dev): run the SAME lib function here and say so.
 */
async function runChecks(consentId: string): Promise<ActionState> {
  const store = createConsentStore();
  const consent = await store.getConsent(consentId);
  if (!consent) return { status: "error", message: "Consent not found." };
  const clipPath = consent.clip_path;
  if (!clipPath) return { status: "error", message: "Upload the clip first." };
  await store.updateConsent(consentId, { clip_check_status: "pending", clip_check_error: null }, true);

  if (readEnv("TRIGGER_SECRET_KEY")) {
    const idempotencyKey = await idempotencyKeys.create([consentId, clipPath], { scope: "global" });
    await tasks.trigger<typeof checkClipTask>("check-clip", { consentId, clipPath }, { idempotencyKey, idempotencyKeyTTL: "10m" });
    return { status: "ok", message: "Clip saved. The checks are running in the background. Refresh in a minute." };
  }
  const outcome = await runClipCheckJob(consentId, clipPath, { store, storage: createClipStorage() });
  const here = "Checks ran on this server (no background jobs set up)";
  if (outcome.status === "done") {
    return outcome.passed
      ? { status: "ok", message: `Clip saved. ${here}: all passed.` }
      : { status: "error", message: `Clip saved. ${here}: some failed. See the tips below.` };
  }
  const saved = await store.getConsent(consentId);
  return { status: "error", message: saved?.clip_check_error ?? "The clip changed meanwhile. Refresh the page." };
}

/** Step 2 of an upload: checks the stored file, saves it and runs the clip checks. */
export async function confirmUploadAction(consentId: string, objectPath: string): Promise<ActionState> {
  await requireAdmin();
  if (typeof objectPath !== "string" || objectPath.length > 300) return { status: "error", message: "That upload can't be used." };
  try {
    await confirmUpload(consentId, objectPath, { store: createConsentStore(), storage: createClipStorage() });
    const state = await runChecks(consentId);
    revalidatePath(page(consentId));
    return state;
  } catch (error) {
    return failure("[admin] confirm upload failed", { consentId }, error);
  }
}

export async function recheckClipAction(consentId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    const state = await runChecks(consentId);
    revalidatePath(page(consentId));
    return state;
  } catch (error) {
    return failure("[admin] clip checks failed", { consentId }, error);
  }
}

/**
 * Starts twin creation for an APPROVED consent:
 * - with TRIGGER_SECRET_KEY: the create-twin task (idempotency key = consent id);
 * - without it, in mock mode only: right here, with mock HeyGen (free);
 * - never a real HeyGen call from a page.
 */
async function startTwin(consentId: string): Promise<ActionState> {
  const store = createConsentStore();
  const consent = await store.getConsent(consentId);
  if (!consent || consent.admin_status !== "approved") {
    return { status: "error", message: "No twin before the consent clip is approved." };
  }
  if (readEnv("TRIGGER_SECRET_KEY")) {
    const idempotencyKey = await idempotencyKeys.create(consentId, { scope: "global" });
    await tasks.trigger<typeof createTwinTask>("create-twin", { consentId }, { idempotencyKey });
    return { status: "ok", message: "Approved. Creating the twin in the background." };
  }
  if (!isMockHeygen()) {
    return {
      status: "error",
      message: "Approved, but the twin was not started: add TRIGGER_SECRET_KEY, then press “Create twin”.",
    };
  }
  const client = heygen({ forPage: true });
  const avatar = await createTwin(consentId, { store, storage: createClipStorage(), heygen: client, spend: createSpendStore() });
  await pollTwinUntilReady(avatar.id, { store, heygen: client, wait: async () => {}, maxAttempts: 1 });
  return { status: "ok", message: "Approved. Mock twin created (no HeyGen call, nothing spent)." };
}

export async function approveConsentAction(consentId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = noteSchema.safeParse({ note: text(formData, "note") ?? "" });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0].message };
  try {
    await approveConsent(consentId, parsed.data.note, { store: createConsentStore() });
    const state = await startTwin(consentId);
    revalidatePath(page(consentId));
    return state;
  } catch (error) {
    revalidatePath(page(consentId));
    return failure("[admin] approve consent failed", { consentId }, error);
  }
}

export async function rejectConsentAction(consentId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = noteSchema.safeParse({ note: text(formData, "note") ?? "" });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0].message };
  try {
    await rejectConsent(consentId, parsed.data.note, { store: createConsentStore() });
    revalidatePath(page(consentId));
    return { status: "ok", message: "Rejected." };
  } catch (error) {
    return failure("[admin] reject consent failed", { consentId }, error);
  }
}

/** "Create twin" again, e.g. after the Trigger key was added. Safe to repeat. */
export async function startTwinAction(consentId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    const state = await startTwin(consentId);
    revalidatePath(page(consentId));
    return state;
  } catch (error) {
    return failure("[admin] start twin failed", { consentId }, error);
  }
}

/** One manual check of the twin on HeyGen (backup to the polling task). */
export async function checkTwinAction(avatarId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    const store = createConsentStore();
    const result = await pollTwinOnce(avatarId, { store, heygen: heygen({ forPage: true }) });
    const avatar = await store.getAvatar(avatarId);
    if (avatar?.consent_id) revalidatePath(page(avatar.consent_id));
    return { status: result.done ? "ok" : "idle", message: `Twin status: ${result.status.replaceAll("_", " ")}.` };
  } catch (error) {
    return failure("[admin] check twin failed", { avatarId }, error);
  }
}
