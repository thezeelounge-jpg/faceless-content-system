import type { RenderablePost, VideoFiles, VideoRow, VideoStore } from "@/lib/video-store-types";
import { BRAND_ID, memoryConsentStore } from "@/tests/helpers/consent-memory";

// In-memory stand-ins for videos, posts/scripts, brands (engine, paused,
// words_per_second), webhook_events and the private videos bucket. Avatars
// and consents come from the consent memory store, so likeness tests and
// renders see the same twin. claimRenderSlot mirrors the claim_render_slot
// database function; saveWebhookEvent mirrors the unique event_key.

export const POST_ID = "20000000-0000-4000-8000-000000000001";
export const SCRIPT_ID = "30000000-0000-4000-8000-000000000001";

type Brand = { id: string; name: string; engine: string | null; paused: boolean; words_per_second: number };
type Post = { id: string; brand_id: string; status: string; status_reason: string | null; title: string };
type Script = { id: string; post_id: string; version: number; spoken_text: string | null; display_text: string | null; qa_status: string };

export function memoryVideoStore(consentMem = memoryConsentStore()) {
  const videos: VideoRow[] = [];
  const brands: Brand[] = [{ id: BRAND_ID, name: "Dr Ayesha Clinic", engine: null, paused: false, words_per_second: 2.4 }];
  const posts: Post[] = [];
  const scripts: Script[] = [];
  const events: { event_key: string; source: "heygen"; payload: unknown; processed_at: string | null }[] = [];
  /** videos.claim_cleared_at (p4-fix c2): a cleared row is retired, never claimed again. */
  const clearedAt = new Map<string, string>();
  /** videos.late_heygen_video_id: a late HeyGen id recorded when a newer render was kept. */
  const lateHeygenIds = new Map<string, string>();
  let n = 0;
  const newId = () => `90000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const brand = (id: string) => brands.find((b) => b.id === id);

  const store: VideoStore = {
    async getVideo(id) {
      const row = videos.find((v) => v.id === id);
      return row ? structuredClone(row) : null;
    },
    async getVideoByHeygenId(heygenVideoId) {
      const row = videos.find((v) => v.heygen_video_id === heygenVideoId);
      return row ? structuredClone(row) : null;
    },
    async insertVideo(row) {
      const saved: VideoRow = {
        id: newId(),
        attempt: 1,
        heygen_video_id: null,
        status: "queued",
        raw_path: null,
        duration_s: null,
        render_started_at: null,
        rendered_at: null,
        counts_toward_plan: false,
        error: null,
        created_at: new Date(Date.now() + n).toISOString(),
        ...row,
      };
      videos.push(saved);
      return structuredClone(saved);
    },
    async updateVideo(id, patch) {
      const row = videos.find((v) => v.id === id);
      if (!row) return null;
      Object.assign(row, structuredClone(patch));
      return structuredClone(row);
    },
    async claimRenderSlot(id, max) {
      const row = videos.find((v) => v.id === id);
      if (!row) return "missing";
      if (row.heygen_video_id || row.render_started_at || clearedAt.has(id) || !["queued", "failed"].includes(row.status)) return "taken";
      if (videos.filter((v) => v.status === "rendering").length >= max) return "busy";
      Object.assign(row, { status: "rendering", render_started_at: new Date().toISOString(), error: null });
      return "claimed";
    },
    async finishRender(id, patch) {
      const row = videos.find((v) => v.id === id);
      if (!row || row.status !== "rendering") return null;
      Object.assign(row, structuredClone(patch));
      return structuredClone(row);
    },
    async findActiveVideoForScript(scriptId) {
      const rows = videos.filter((v) => v.script_id === scriptId && !["failed", "skipped"].includes(v.status));
      return rows.length ? structuredClone(rows[rows.length - 1]) : null;
    },
    // Mirrors create_post_render (migration 20261122180000): one JS turn = the per-post lock;
    // an active video of ANY script of the post blocks a new one (p4-b3, Q8).
    async createPostVideo(input) {
      const post = posts.find((p) => p.id === input.postId && p.brand_id === input.brandId);
      const latest = scripts.filter((s) => s.post_id === input.postId).sort((a, b) => b.version - a.version)[0];
      // p5-a (migration 20261122200000): the newest script must also have passed QA.
      if (post?.status !== "approved" || latest?.id !== input.scriptId || latest.qa_status !== "passed") {
        return { outcome: "not_approved", videoId: null };
      }
      const postScripts = new Set(scripts.filter((s) => s.post_id === input.postId).map((s) => s.id));
      const active = videos.filter(
        (v) => v.kind === "post" && v.script_id !== null && postScripts.has(v.script_id) && !["failed", "skipped"].includes(v.status),
      );
      const last = active[active.length - 1];
      if (last) return { outcome: last.script_id === input.scriptId ? "existing" : "other_script", videoId: last.id };
      const row = await store.insertVideo({
        brand_id: input.brandId,
        script_id: input.scriptId,
        avatar_id: input.avatarId,
        kind: "post",
        engine: input.engine,
        spoken_words: input.spokenWords,
      });
      return { outcome: "created", videoId: row.id };
    },
    // Mirrors adopt_late_render (migration 20261122150000, which replaced 20261122130000).
    async adoptLateRender(id, heygenVideoId) {
      const row = videos.find((v) => v.id === id);
      if (!row || row.status !== "failed" || row.heygen_video_id || (!row.render_started_at && !clearedAt.has(id))) return "not_late";
      const active = (v: VideoRow) => v.id !== row.id && !["failed", "skipped"].includes(v.status);
      const postOf = (v: VideoRow) => scripts.find((s) => s.id === v.script_id)?.post_id;
      const postId = row.kind === "post" ? postOf(row) : undefined;
      const version = scripts.find((s) => s.id === row.script_id)?.version ?? 0;
      const newer =
        row.kind === "post"
          ? videos.some((v) => active(v) && v.script_id !== null && postOf(v) === postId) ||
            scripts.some((s) => s.post_id === postId && s.version > version)
          : videos.some((v) => active(v) && v.kind === "likeness_test" && v.avatar_id === row.avatar_id && v.engine === row.engine);
      if (newer) {
        lateHeygenIds.set(id, heygenVideoId);
        row.error =
          "HeyGen finished this video late, after a newer render or script was started. The newer one was kept; the late HeyGen id is saved.";
        return "moved_on";
      }
      Object.assign(row, {
        heygen_video_id: heygenVideoId,
        status: "rendering",
        error: "HeyGen finished this video late (after its claim was cleared or the wait ran out). Downloading it now.",
      });
      const post = posts.find((p) => p.id === postId);
      if (post && ["approved", "team_review"].includes(post.status)) Object.assign(post, { status: "rendering", status_reason: null });
      return "adopted";
    },
    async listLikenessVideos(avatarId) {
      return structuredClone(videos.filter((v) => v.avatar_id === avatarId && v.kind === "likeness_test"));
    },
    async getRenderablePost(postId): Promise<RenderablePost | null> {
      const post = posts.find((p) => p.id === postId);
      if (!post) return null;
      const script = scripts.filter((s) => s.post_id === postId).sort((a, b) => b.version - a.version)[0];
      return {
        post: { id: post.id, brand_id: post.brand_id, status: post.status, title: post.title },
        script: script ? { id: script.id, spoken_text: script.spoken_text, qa_status: script.qa_status } : null,
      };
    },
    async getScriptText(scriptId) {
      const script = scripts.find((s) => s.id === scriptId);
      return script ? { spokenText: script.spoken_text, postId: script.post_id } : null;
    },
    async setPostStatus(postId, status, reason) {
      const post = posts.find((p) => p.id === postId);
      if (post) Object.assign(post, { status, status_reason: reason });
    },
    async getBrand(brandId) {
      const b = brand(brandId);
      return b ? { id: b.id, name: b.name, engine: b.engine, paused: b.paused } : null;
    },
    async setBrandEngine(brandId, engine) {
      const b = brand(brandId);
      if (b) b.engine = engine;
    },
    async recentRenderSamples(brandId, limit) {
      return videos
        .filter((v) => v.brand_id === brandId && v.kind === "post" && v.rendered_at && v.spoken_words !== null && v.duration_s !== null)
        .sort((a, b) => (b.rendered_at! > a.rendered_at! ? 1 : -1))
        .slice(0, limit)
        .map((v) => ({ words: v.spoken_words!, durationS: Number(v.duration_s) }));
    },
    async setWordsPerSecond(brandId, wordsPerSecond) {
      const b = brand(brandId);
      if (b) b.words_per_second = wordsPerSecond;
    },
    async getAvatar(id) {
      return consentMem.store.getAvatar(id);
    },
    async getReadyAvatar(brandId) {
      const rows = consentMem.avatars.filter((a) => a.brand_id === brandId && a.status === "ready");
      return rows.length ? structuredClone(rows[rows.length - 1]) : null;
    },
    async getHeygenConsentStatus(consentId) {
      return (await consentMem.store.getConsent(consentId))?.heygen_consent_status ?? null;
    },
    async saveWebhookEvent(eventKey, payload) {
      const existing = events.find((e) => e.event_key === eventKey);
      if (existing) return existing.processed_at ? "processed" : "unprocessed";
      events.push({ event_key: eventKey, source: "heygen", payload: structuredClone(payload), processed_at: null });
      return "new";
    },
    async markWebhookProcessed(eventKey) {
      const row = events.find((e) => e.event_key === eventKey);
      if (row) row.processed_at = new Date().toISOString();
    },
  };

  /** A ready twin for BRAND_ID with HeyGen consent accepted, and the brand's engine set. */
  async function seedReadyTwin(opts: { engine?: string; engines?: string[]; status?: AvatarStatusLike; heygenConsent?: string } = {}) {
    const consent = await consentMem.store.insertConsent({
      brand_id: BRAND_ID,
      person_legal_name: "Ayesha Khan",
      checkbox_at: new Date().toISOString(),
      words: ["apple", "river", "tiger"],
      words_expire_at: new Date(Date.now() + 1_800_000).toISOString(),
      ip: null,
      user_agent: null,
    });
    await consentMem.store.updateConsent(consent.id, {
      admin_status: "approved",
      heygen_consent_status: opts.heygenConsent ?? "accepted",
    });
    const avatar = await consentMem.store.insertAvatar({ brand_id: BRAND_ID, consent_id: consent.id, status: opts.status ?? "ready" });
    const engine = opts.engine ?? "avatar_v";
    await consentMem.store.updateAvatar(avatar.id, {
      heygen_group_id: "group_mock_0001",
      heygen_look_id: "look_mock_0001",
      voice_id: "voice_mock_0001",
      supported_engines: opts.engines ?? ["avatar_iv", "avatar_v"],
      chosen_engine: opts.status && opts.status !== "ready" ? null : engine,
    });
    if (!opts.status || opts.status === "ready") brand(BRAND_ID)!.engine = engine;
    return { consent, avatar: (await consentMem.store.getAvatar(avatar.id))! };
  }

  /** An approved post with a script that passed QA. */
  function seedApprovedPost(opts: { postStatus?: string; qaStatus?: string; spoken?: string | null; id?: string; scriptId?: string } = {}) {
    const postId = opts.id ?? POST_ID;
    const scriptId = opts.scriptId ?? SCRIPT_ID;
    posts.push({ id: postId, brand_id: BRAND_ID, status: opts.postStatus ?? "approved", status_reason: null, title: "Three myths about teeth" });
    scripts.push({
      id: scriptId,
      post_id: postId,
      version: 1,
      spoken_text: opts.spoken === undefined ? "Doctor Aaysha says brush twice a day. Floss once. See you next week." : opts.spoken,
      display_text: "Dr Ayesha says: brush 2x a day!",
      qa_status: opts.qaStatus ?? "passed",
    });
    return { postId, scriptId };
  }

  return { store, videos, brands, posts, scripts, events, consentMem, seedReadyTwin, seedApprovedPost, brand, clearedAt, lateHeygenIds };
}

type AvatarStatusLike = "training" | "consent_pending" | "likeness_test" | "ready" | "reshoot_needed" | "failed";

/** The private videos bucket. */
export function memoryVideoFiles() {
  const files: Record<string, { bytes: Uint8Array; contentType: string }> = {};
  const signed: { path: string; seconds: number }[] = [];
  const uploads: string[] = [];
  const storage: VideoFiles = {
    async upload(path, bytes, contentType) {
      uploads.push(path);
      files[path] = { bytes, contentType };
    },
    async signedUrl(path, seconds) {
      signed.push({ path, seconds });
      return `https://storage.example.invalid/signed/${path}?expires=${seconds}`;
    },
  };
  return { storage, files, signed, uploads };
}
