// An in-memory stand-in for the database rows the QA gates touch, used by
// unit tests, the sample snapshot test and `npm run eval:scripts`.
// Ids are predictable ("script-1", "script-2", ...) so snapshots stay stable.
import type { PronunciationEntry } from "@/lib/pronunciation/dictionary";
import { PlainError } from "@/lib/plain-error";
import { OVERRIDE_HAS_VIDEO } from "@/lib/qa/script-override";
import { OPEN_POST_STATUSES, SCRIPT_REWRITE_CLOSED, type QaReportRow, type ScriptQaStore, type StoredScript } from "@/lib/qa/script-pipeline";

export type MemoryStore = ScriptQaStore & {
  scripts: StoredScript[];
  reports: QaReportRow[];
  posts: Map<string, { status: string; status_reason: string | null }>;
  pronunciations: (PronunciationEntry & { brand_id: string; source: "manual" | "qa" })[];
  /** p5-a: posts with an active post video (an override is refused for them). */
  postsWithActiveVideo: Set<string>;
  /** p5-a: the script_override audit rows (provider_usage in the database). */
  audits: { scriptId: string; postId: string; wasStatus: string; by: string; reason: string }[];
};

export function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    scripts: [],
    reports: [],
    posts: new Map(),
    pronunciations: [],
    postsWithActiveVideo: new Set(),
    audits: [],
    async insertQaReport(row) {
      store.reports.push(structuredClone(row));
    },
    // Mirrors rpc insert_script_version (migration 20261122210000). A post with no entry is still planned.
    async insertScriptVersion(row, override) {
      const status = store.posts.get(row.post_id)?.status ?? "planned";
      const open = (OPEN_POST_STATUSES as readonly string[]).includes(status);
      if (!open && !override) throw new PlainError(SCRIPT_REWRITE_CLOSED);
      if (!open && store.postsWithActiveVideo.has(row.post_id)) throw new PlainError(OVERRIDE_HAS_VIDEO);
      const id = `script-${store.scripts.length + 1}`;
      store.scripts.push({ ...structuredClone(row), id });
      if (!open && override) {
        store.posts.set(row.post_id, { status: "scripting", status_reason: null });
        store.audits.push({ scriptId: id, postId: row.post_id, wasStatus: status, by: override.by, reason: override.reason });
      }
      return id;
    },
    async updateScript(id, patch) {
      const script = store.scripts.find((s) => s.id === id);
      if (!script) throw new Error(`no script ${id}`);
      Object.assign(script, patch);
    },
    // Mirrors rpc finish_script_checks (migration 20261122230000). A post with no entry is still planned.
    async finishChecks(scriptId, patch) {
      const script = store.scripts.find((s) => s.id === scriptId);
      if (!script) return "not_found";
      if (store.scripts.some((s) => s.post_id === script.post_id && s.version > script.version)) return "stale";
      if (patch.qa_status !== null) script.qa_status = patch.qa_status;
      const status = store.posts.get(script.post_id)?.status ?? "planned";
      if (!(OPEN_POST_STATUSES as readonly string[]).includes(status)) return "moved_on";
      store.posts.set(script.post_id, { status: patch.status, status_reason: patch.status_reason });
      return "done";
    },
    // p5-b1: the facts insert_script_version decides on (a post with no entry is still planned).
    async getRewriteState(postId) {
      return { status: store.posts.get(postId)?.status ?? "planned", hasActiveVideo: store.postsWithActiveVideo.has(postId) };
    },
    async listPronunciations(brandId) {
      return store.pronunciations
        .filter((p) => p.brand_id === brandId)
        .map(({ written, say_as, status }) => ({ written, say_as, status }));
    },
    async insertSuggestedPronunciations(brandId, rows) {
      for (const row of rows) {
        const exists = store.pronunciations.some(
          (p) => p.brand_id === brandId && p.written.toLowerCase() === row.written.toLowerCase(),
        );
        if (!exists) store.pronunciations.push({ ...row, brand_id: brandId, status: "suggested", source: "qa" });
      }
    },
  };
  return store;
}

/** Saves a script as the given version (QA pending) and returns the stored row. */
export async function seedScript(
  store: MemoryStore,
  row: Omit<StoredScript, "id" | "qa_status" | "spoken_text"> & Partial<Pick<StoredScript, "qa_status">>,
): Promise<StoredScript> {
  const id = await store.insertScriptVersion({ qa_status: "pending", spoken_text: null, ...row });
  return store.scripts.find((s) => s.id === id)!;
}
