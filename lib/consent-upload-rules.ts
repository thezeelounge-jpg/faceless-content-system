// Upload rules for consent clips. No "server-only" here on purpose: the
// browser (components/admin/consent-upload.tsx) runs the very same check
// before uploading, and the server runs it again in prepareUpload and on the
// stored file in confirmUpload (lib/consent-flow.ts). No secrets in this file.

export const CONSENT_UPLOAD = {
  /**
   * Decision 4 (Rowan): 50 MB. The Supabase Free plan caps each file at 50 MB
   * (the consent-clips bucket file_size_limit matches). HeyGen itself accepts
   * up to 200 MB with direct upload (docs "Video to Avatar").
   */
  max_bytes: 50 * 1024 * 1024,
  min_bytes: 100 * 1024,
  /**
   * HeyGen accepts mp4 or webm (docs "Video to Avatar"). Decision 5: .mov is
   * allowed too; the clip check converts it to mp4 before anything else.
   */
  types: { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" } as Record<string, string>,
  playback_seconds: 300,
  /**
   * SF1: confirmUpload re-checks the 30-minute words window, plus this grace
   * for an upload that was already on its way when the words ran out.
   * Needed because Supabase's signed upload token always lasts 2 hours:
   * createSignedUploadUrl(path, { upsert }) takes no expiry option
   * (@supabase/storage-js index.d.mts: "They are valid for 2 hours.").
   */
  confirm_grace_s: 120,
};

export const UPLOAD_TIPS = {
  type: "Upload an MP4, WebM or MOV video. On iPhone: Settings → Camera → Formats → Most Compatible.",
  /** Decision 5: a .mov that ffmpeg can't convert. */
  bad_mov: "We couldn't read this .mov video. On iPhone: Settings → Camera → Formats → Most Compatible, then record again.",
  too_small: "The clip is too small to be a real recording. Record about 2 minutes.",
  too_big:
    "The clip is too big (over 50 MB). To make it smaller: record at 1080p and 30 fps (not 4K or 60 fps), keep it to about 2 minutes, or on iPhone choose Settings → Camera → Formats → Most Compatible.",
} as const;

/** Type and size check for a clip (browser and server). Null when fine. */
export function validateUpload(file: { name: string; type: string; size: number }): string | null {
  if (!(file.type in CONSENT_UPLOAD.types)) return UPLOAD_TIPS.type;
  if (!Number.isFinite(file.size) || file.size < CONSENT_UPLOAD.min_bytes) return UPLOAD_TIPS.too_small;
  if (file.size > CONSENT_UPLOAD.max_bytes) return UPLOAD_TIPS.too_big;
  return null;
}
