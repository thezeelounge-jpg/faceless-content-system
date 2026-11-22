import "server-only";
import path from "node:path";
import { parseAdminEmails } from "@/lib/admin";
import { redact } from "@/lib/admin-errors";
import { clientEmailFor, consentLinkRecipients } from "@/lib/email-recipients";
import type { AvatarRow, AvatarStatus, ClipStorage, ConsentStore } from "@/lib/consent-store-types";
import { HeygenError, type CreatedTwin, type HeygenClient, type HeygenErrorCode } from "@/lib/heygen";
import { SpendGuardError, withHeygenSpend, type SpendStore } from "@/lib/heygen-spend";
import { PlainError } from "@/lib/plain-error";
import { TWIN_POLL } from "@/lib/qa/config";

// Creating the digital twin after the admin approves the consent clip, and
// waiting until it is ready. Plain functions, so they are tested with mock
// HeyGen and an in-memory store; trigger/create-twin.ts and
// trigger/poll-twin.ts only call these.
//
// avatars.status, step by step:
//   training         row created on approval (lib/consent-flow.ts)
//   consent_pending  twin created on HeyGen, waiting for the person's webcam consent
//   training         consent accepted, HeyGen still training the look
//   likeness_test    look ready: look id, voice id and engines saved (Phase 3 part B picks the engine)
//   reshoot_needed   HeyGen could not train from this clip
//   failed           HeyGen consent rejected, or the group failed

/** The poll's waits now live in lib/qa/config.ts (p4-b1: the twin claim wait is derived from them). */
export { TWIN_POLL };

const STILL_WAITING =
  "Still waiting for HeyGen after many checks. Check the consent email was completed, then press “Check twin again”.";

/** SF2: shown when a twin may exist on HeyGen but its id was never saved. */
export const LOST_TWIN =
  "A twin may already exist on HeyGen for this clip, but we did not save its id. Check the HeyGen dashboard before creating another one.";

/**
 * HeyGen answers that prove no twin was made, so the claim can be freed.
 * Not here: "failed" (timeout or 5xx: it might have worked) and "bad_output"
 * (HeyGen said OK, so the twin probably exists).
 */
const HEYGEN_DID_NOT_CREATE: HeygenErrorCode[] = ["not_set_up", "unauthorized", "not_found", "bad_request", "busy"];

type TwinDeps = { store: ConsentStore; heygen: HeygenClient };

/** The sentence saved on avatars.error: our own plain words only, redacted. Never raw bodies. */
function plain(error: unknown): string {
  return error instanceof PlainError ? redact(error.message) : "Something went wrong talking to HeyGen. See server logs.";
}

function consentEmail(brandName: string, url: string): { subject: string; body: string } {
  return {
    subject: "Please confirm your consent on HeyGen (within 24 hours)",
    body: [
      `Hi ${brandName},`,
      "",
      "Your clip is approved. HeyGen, the company that makes your digital twin, needs you to confirm your consent on webcam.",
      "",
      `Open this link and follow the steps: ${url}`,
      "",
      "The link works for 24 hours. After that, ask us for a new one.",
    ].join("\n"),
  };
}

/**
 * Creates the twin on HeyGen for an APPROVED consent, starts HeyGen's consent
 * flow and "emails" the link (mock outbox). Safe to run again: it skips the
 * steps that are already done.
 */
export async function createTwin(
  consentId: string,
  deps: TwinDeps & { storage: ClipStorage; spend: SpendStore; adminEmails?: string[] },
): Promise<AvatarRow> {
  const consent = await deps.store.getConsent(consentId);
  if (!consent) throw new PlainError("Consent not found.");
  // CLAUDE.md: no twin before admin approval of the consent clip.
  if (consent.admin_status !== "approved" || !consent.clip_path) {
    throw new PlainError("No twin before the consent clip is approved.");
  }
  const brand = await deps.store.getBrandContact(consent.brand_id);
  if (!brand) throw new PlainError("Client not found.");
  let avatar = await deps.store.insertAvatar({ brand_id: consent.brand_id, consent_id: consent.id, status: "training" });

  try {
    // SF2: re-read the row. A twin id already saved → skip creation. A claim
    // without an id → an earlier try may have made the twin on HeyGen and then
    // crashed: refuse (never make a second paid twin) and ask the admin.
    avatar = (await deps.store.getAvatar(avatar.id)) ?? avatar;
    if (!avatar.heygen_group_id) {
      if (avatar.create_started_at) throw new PlainError(LOST_TWIN);
      const bytes = await deps.storage.download(consent.clip_path);
      const ext = path.extname(consent.clip_path).toLowerCase();
      const assetId = await deps.heygen.uploadAsset({
        bytes,
        filename: `consent${ext}`,
        contentType: ext === ".webm" ? "video/webm" : "video/mp4",
      });
      // Claim right before the paid POST (atomic in the database).
      if (!(await deps.store.claimTwinCreate(avatar.id, new Date().toISOString()))) throw new PlainError(LOST_TWIN);
      let twin: CreatedTwin;
      try {
        // Spend guard: pause switch + daily cap + a provider_usage row, before the POST.
        twin = await withHeygenSpend(
          { kind: "create_twin", avatarId: avatar.id, brandId: consent.brand_id, mock: deps.heygen.mock, store: deps.spend },
          () => deps.heygen.createDigitalTwin({ name: `${brand.name} twin`, file: { type: "asset_id", asset_id: assetId } }),
        );
      } catch (error) {
        // Nothing was made (guard refused, or HeyGen clearly said no): free the claim so a retry may try again.
        const refused = error instanceof HeygenError && HEYGEN_DID_NOT_CREATE.includes(error.code);
        if (refused || error instanceof SpendGuardError) {
          await deps.store.updateAvatar(avatar.id, { create_started_at: null });
        }
        throw error;
      }
      avatar =
        (await deps.store.updateAvatar(avatar.id, {
          heygen_group_id: twin.groupId,
          heygen_look_id: twin.lookId,
          voice_id: twin.voiceId,
          error: null,
        })) ?? avatar;
    }

    if (!consent.heygen_consent_url) {
      const started = await deps.heygen.startConsent(avatar.heygen_group_id!);
      await deps.store.updateConsent(consent.id, {
        heygen_consent_status: started.consentStatus,
        heygen_consent_url: started.consentUrl,
      });
      consent.heygen_consent_url = started.consentUrl;
    }

    // Decision 6: the client's own email + a copy for each admin (mock outbox only).
    if (consent.heygen_consent_url && !(await deps.store.hasOutbox(consent.id, "consent_link"))) {
      const admins = deps.adminEmails ?? parseAdminEmails(process.env.ADMIN_EMAILS);
      const email = consentEmail(brand.name, consent.heygen_consent_url);
      for (const { to, copy } of consentLinkRecipients(clientEmailFor(brand, admins), admins)) {
        await deps.store.insertOutbox({
          brand_id: brand.id,
          consent_id: consent.id,
          to_email: to,
          kind: "consent_link",
          subject: copy ? `[Copy] ${email.subject}` : email.subject,
          body: email.body,
        });
      }
    }

    return (await deps.store.updateAvatar(avatar.id, { status: "consent_pending", error: null })) ?? avatar;
  } catch (error) {
    await deps.store.updateAvatar(avatar.id, { error: plain(error) });
    throw error;
  }
}

export type PollResult = { done: boolean; status: AvatarStatus };

/**
 * One check of the twin on HeyGen. Saves what it learns. If HeyGen (or the
 * store) throws, a plain redacted sentence is saved to avatars.error (SF3),
 * then the error is rethrown so the task can retry.
 */
export async function pollTwinOnce(avatarId: string, deps: TwinDeps): Promise<PollResult> {
  const avatar = await deps.store.getAvatar(avatarId);
  if (!avatar) throw new PlainError("Twin not found.");
  if (!avatar.heygen_group_id) throw new PlainError("This twin has not been created on HeyGen yet.");
  try {
    return await checkTwin(avatar, avatar.heygen_group_id, deps);
  } catch (error) {
    await deps.store.updateAvatar(avatar.id, { error: plain(error) }).catch(() => null);
    throw error;
  }
}

async function checkTwin(avatar: AvatarRow, groupId: string, deps: TwinDeps): Promise<PollResult> {
  const group = await deps.heygen.getAvatarGroup(groupId);
  if (avatar.consent_id && group.consentStatus) {
    await deps.store.updateConsent(avatar.consent_id, { heygen_consent_status: group.consentStatus });
  }
  const finish = async (status: AvatarStatus, error: string | null, done: boolean): Promise<PollResult> => {
    await deps.store.updateAvatar(avatar.id, { status, error });
    return { done, status };
  };

  if (group.status === "failed" || group.consentStatus === "rejected") {
    return finish("failed", "The person did not accept HeyGen's consent check. Start a new consent.", true);
  }
  const looks = await deps.heygen.listLooks(groupId);
  const look = looks.find((l) => l.status === "completed") ?? looks[0];
  if (look?.status === "failed") {
    return finish("reshoot_needed", "HeyGen could not train the twin from this clip. Ask for a reshoot.", true);
  }
  if (group.consentStatus !== "accepted") return finish("consent_pending", null, false);
  if (!look || look.status !== "completed") return finish("training", null, false);

  await deps.store.updateAvatar(avatar.id, {
    heygen_look_id: look.lookId,
    voice_id: group.voiceId ?? look.voiceId,
    supported_engines: look.supportedEngines,
  });
  return finish("likeness_test", null, true);
}

/** Checks until the twin is ready or failed, waiting longer each time (bounded). */
export async function pollTwinUntilReady(
  avatarId: string,
  deps: TwinDeps & { wait: (seconds: number) => Promise<void>; maxAttempts?: number },
): Promise<PollResult> {
  const maxAttempts = deps.maxAttempts ?? TWIN_POLL.max_attempts;
  for (let attempt = 1; ; attempt++) {
    const result = await pollTwinOnce(avatarId, deps);
    if (result.done) return result;
    if (attempt >= maxAttempts) {
      await deps.store.updateAvatar(avatarId, { error: STILL_WAITING });
      return result;
    }
    await deps.wait(Math.min(TWIN_POLL.first_wait_s * 2 ** (attempt - 1), TWIN_POLL.max_wait_s));
  }
}
