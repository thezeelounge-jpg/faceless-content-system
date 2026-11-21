import "server-only";
import { parseAdminEmails } from "@/lib/admin";
import type { AvatarRow, ConsentStore } from "@/lib/consent-store-types";
import { reshootRecipients } from "@/lib/email-recipients";
import type { HeygenClient } from "@/lib/heygen";
import type { SpendStore } from "@/lib/heygen-spend";
import { PlainError } from "@/lib/plain-error";
import { LIKENESS } from "@/lib/qa/config";
import { loadRecordingGuide } from "@/lib/recording-guide";
import { LIKENESS_LINE, NEEDS_SPEND_CONFIRM, renderVideo, type RenderStart } from "@/lib/render";
import { countWords } from "@/lib/scripts";
import type { VideoFiles, VideoRow, VideoStore } from "@/lib/video-store-types";

// The likeness test (Phase 3 item 6): render the same fixed ~15-second line
// once per realistic engine the twin's look supports, so the admin can watch
// them side by side and pick the most realistic one ("Use this engine"), or
// ask for a reshoot. Every render goes through lib/render.ts (money rules,
// spend guard with both pause switches, claim, 10-at-once cap). Likeness-test
// videos (kind 'likeness_test') never count toward a plan and are left out of
// words_per_second.
// Rules: only for a twin in status likeness_test whose HeyGen consent is
// accepted (CLAUDE.md). Real renders need MOCK_HEYGEN=false AND the admin's
// confirmSpend (checked here before any row is made, and again in renderVideo).

export type LikenessDeps = {
  store: ConsentStore;
  videos: VideoStore;
  heygen: HeygenClient;
  spend: SpendStore;
  confirmSpend?: boolean;
  callbackUrl?: string | null;
};

/** Signed playback links live 5 minutes (same as consent clips). */
export const LIKENESS_PLAYBACK_SECONDS = 300;

const NOT_DECIDING = "This twin is not waiting for a likeness decision.";

/** The realistic engines (lib/qa/config.ts LIKENESS) this look supports, in our order. */
export function likenessEngines(supported: string[]): string[] {
  return LIKENESS.realistic_engines.filter((engine) => supported.includes(engine));
}

async function testableAvatar(avatarId: string, deps: { store: ConsentStore }): Promise<AvatarRow> {
  const avatar = await deps.store.getAvatar(avatarId);
  if (!avatar) throw new PlainError("Twin not found.");
  if (avatar.status !== "likeness_test") throw new PlainError("The likeness test is for a twin that has finished training.");
  const consent = avatar.consent_id ? await deps.store.getConsent(avatar.consent_id) : null;
  if (consent?.heygen_consent_status !== "accepted") {
    throw new PlainError("HeyGen's own consent for this twin is not accepted yet. Nothing was sent to HeyGen.");
  }
  return avatar;
}

/**
 * Checks the rules and makes (or finds) one queued likeness-test video per
 * engine. Sends nothing to HeyGen. Used by the background task path, which
 * then starts one render-video run per video.
 */
export async function prepareLikenessTest(
  avatarId: string,
  deps: Pick<LikenessDeps, "store" | "videos" | "heygen" | "confirmSpend">,
): Promise<VideoRow[]> {
  if (!deps.heygen.mock && deps.confirmSpend !== true) throw new PlainError(NEEDS_SPEND_CONFIRM);
  const avatar = await testableAvatar(avatarId, deps);
  const engines = likenessEngines(avatar.supported_engines);
  if (engines.length === 0) {
    throw new PlainError(
      `This twin supports none of the realistic engines (${LIKENESS.realistic_engines.join(", ")}). Ask for a reshoot or check HeyGen.`,
    );
  }
  const existing = await deps.videos.listLikenessVideos(avatar.id);
  const rows: VideoRow[] = [];
  for (const engine of engines) {
    // SF6: never a second paid render for the same engine and twin. A row is reused unless it is
    // skipped, or failed WITHOUT ever reaching HeyGen (no claim, no HeyGen id). A failed row that
    // still holds a claim or an id is reused, so renderVideo answers "already_started" or refuses
    // with "check the HeyGen dashboard" instead of POSTing again.
    const reachedHeygen = (v: VideoRow) => v.render_started_at !== null || v.heygen_video_id !== null;
    const found = existing.find((v) => v.engine === engine && v.status !== "skipped" && (v.status !== "failed" || reachedHeygen(v)));
    rows.push(
      found ??
        (await deps.videos.insertVideo({
          brand_id: avatar.brand_id,
          script_id: null,
          avatar_id: avatar.id,
          kind: "likeness_test",
          engine,
          spoken_words: countWords(LIKENESS_LINE),
        })),
    );
  }
  return rows;
}

/** prepareLikenessTest, then renders each video right here (mock mode and tests). */
export async function runLikenessTest(avatarId: string, deps: LikenessDeps): Promise<{ videos: VideoRow[]; results: RenderStart[] }> {
  const videos = await prepareLikenessTest(avatarId, deps);
  const results: RenderStart[] = [];
  for (const video of videos) results.push(await renderVideo(video.id, deps));
  return { videos, results };
}

export type LikenessItem = { video: VideoRow; url: string | null };

/** The test videos with 5-minute signed links (only the finished ones have a file). */
export async function listLikenessTest(avatarId: string, deps: { videos: VideoStore; files: VideoFiles }): Promise<LikenessItem[]> {
  const videos = await deps.videos.listLikenessVideos(avatarId);
  return Promise.all(
    videos.map(async (video) => ({
      video,
      url: video.status === "rendered" && video.raw_path ? await deps.files.signedUrl(video.raw_path, LIKENESS_PLAYBACK_SECONDS) : null,
    })),
  );
}

/** "Use this engine": brands.engine (what renders use) + avatars.chosen_engine (history); twin → ready. */
export async function chooseLikenessEngine(
  avatarId: string,
  engine: string,
  deps: { store: ConsentStore; videos: VideoStore },
): Promise<void> {
  const avatar = await deps.store.getAvatar(avatarId);
  if (!avatar) throw new PlainError("Twin not found.");
  if (avatar.status !== "likeness_test") throw new PlainError(NOT_DECIDING);
  const videos = await deps.videos.listLikenessVideos(avatar.id);
  if (!videos.some((v) => v.engine === engine && v.status === "rendered")) {
    throw new PlainError("Watch the finished test video for that engine first.");
  }
  await deps.videos.setBrandEngine(avatar.brand_id, engine);
  await deps.store.updateAvatar(avatar.id, {
    chosen_engine: engine,
    status: "ready",
    error: null,
    likeness_test: { decision: "use_engine", engine, at: new Date().toISOString(), video_ids: videos.map((v) => v.id) },
  });
}

/** The RECORDING-GUIDE sections a reshoot is usually about, as plain tips. */
function reshootTips(): string[] {
  const wanted = ["Camera", "Light", "Background", "Sound", "How to talk"];
  return loadRecordingGuide()
    .filter((section) => wanted.includes(section.heading))
    .flatMap((section) => [`${section.heading}:`, ...section.lines.map((line) => `- ${line}`), ""]);
}

/** "Needs reshoot": twin → reshoot_needed; recording tips to the ADMINS only (mock outbox, never sent). */
export async function markNeedsReshoot(avatarId: string, deps: { store: ConsentStore; adminEmails?: string[] }): Promise<void> {
  const avatar = await deps.store.getAvatar(avatarId);
  if (!avatar) throw new PlainError("Twin not found.");
  if (avatar.status !== "likeness_test") throw new PlainError(NOT_DECIDING);
  await deps.store.updateAvatar(avatar.id, {
    status: "reshoot_needed",
    likeness_test: { decision: "reshoot", at: new Date().toISOString() },
  });
  const brand = await deps.store.getBrandContact(avatar.brand_id);
  const name = brand?.name ?? "this client";
  const body = [
    `The likeness test for ${name} did not look real enough. Please ask the client for a new clip. Suggested message for the client:`,
    "",
    "Thanks for your clip. Your digital twin doesn't look quite like you yet, so we need one more recording. A few tips:",
    "",
    ...reshootTips(),
    "Remember to say the 3 new words at the start.",
  ].join("\n");
  for (const to of reshootRecipients(deps.adminEmails ?? parseAdminEmails(process.env.ADMIN_EMAILS))) {
    await deps.store.insertOutbox({
      brand_id: avatar.brand_id,
      consent_id: avatar.consent_id,
      to_email: to,
      kind: "reshoot_tips",
      subject: `Reshoot needed for ${name} after the likeness test (forward these tips to the client)`,
      body,
    });
  }
}
