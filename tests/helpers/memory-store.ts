// An in-memory stand-in for the database rows the QA gates touch, used by
// unit tests, the sample snapshot test and `npm run eval:scripts`.
// Ids are predictable ("script-1", "script-2", ...) so snapshots stay stable.
import type { PronunciationEntry } from "@/lib/pronunciation/dictionary";
import type { QaReportRow, ScriptQaStore, StoredScript } from "@/lib/qa/script-pipeline";

export type MemoryStore = ScriptQaStore & {
  scripts: StoredScript[];
  reports: QaReportRow[];
  posts: Map<string, { status: string; status_reason: string | null }>;
  pronunciations: (PronunciationEntry & { brand_id: string; source: "manual" | "qa" })[];
};

export function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    scripts: [],
    reports: [],
    posts: new Map(),
    pronunciations: [],
    async insertQaReport(row) {
      store.reports.push(structuredClone(row));
    },
    async insertScriptVersion(row) {
      const id = `script-${store.scripts.length + 1}`;
      store.scripts.push({ ...structuredClone(row), id });
      return id;
    },
    async updateScript(id, patch) {
      const script = store.scripts.find((s) => s.id === id);
      if (!script) throw new Error(`no script ${id}`);
      Object.assign(script, patch);
    },
    async updatePost(id, patch) {
      store.posts.set(id, { ...patch });
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
