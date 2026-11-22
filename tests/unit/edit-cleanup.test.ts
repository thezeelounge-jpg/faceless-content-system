import { describe, expect, it, vi } from "vitest";
import { cleanupStrayRunFiles, type CleanupStore, type CleanupVideo, type RunFile, type RunFileStorage } from "@/lib/edit-cleanup";
import { finalPathFor } from "@/lib/edit-flow";
import { EDIT } from "@/lib/qa/config";

// p5-a: stray run-scoped edit files (QA NICE, p4-b3): a crash between upload and
// finishEdit / removeOurFile can leave final/<brand>/<video>/runs/<run>.mp4 that no row
// points at. The cleanup removes only those, only when old, never the file a row points
// at and never a run that still holds the edit claim. Fake store + fake storage.

const BRAND = "10000000-0000-4000-8000-000000000001";
const V1 = "90000000-0000-4000-8000-000000000001";
const V2 = "90000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-11-22T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const OLD = ago(EDIT.stray_run_min_age_s + 60);
const YOUNG = ago(EDIT.stray_run_min_age_s - 60);
const folder = (video: string) => `final/${BRAND}/${video}/runs`;

function fakes(rows: CleanupVideo[], files: Record<string, RunFile[]>) {
  const removed: string[] = [];
  const listed: string[] = [];
  const store: CleanupStore = {
    listEditedVideos: vi.fn(async (limit: number) => rows.slice(0, limit).map((r) => ({ ...r }))),
    getVideo: vi.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    }),
  };
  const storage: RunFileStorage = {
    list: vi.fn(async (f: string) => {
      listed.push(f);
      return files[f] ?? [];
    }),
    remove: vi.fn(async (p: string) => {
      removed.push(p);
    }),
  };
  return { store, storage, removed, listed };
}

describe("cleanupStrayRunFiles", () => {
  it("removes an old stray run file the row does not point at; keeps the row's file, young files and the claimed run", async () => {
    const rows: CleanupVideo[] = [
      { id: V1, brand_id: BRAND, status: "final_qa", final_path: finalPathFor(BRAND, V1, "run_b"), edit_run_id: "run_b" },
      { id: V2, brand_id: BRAND, status: "editing", final_path: null, edit_run_id: "run_live" },
    ];
    const f = fakes(rows, {
      [folder(V1)]: [
        { name: "run_a.mp4", updated_at: OLD }, // crashed run: stray, old → removed
        { name: "run_b.mp4", updated_at: OLD }, // the row's final_path → kept
        { name: "run_c.mp4", updated_at: YOUNG }, // too young → kept
        { name: "run_d.mp4", updated_at: null }, // unknown age → kept
        { name: ".emptyFolderPlaceholder", updated_at: OLD }, // not a run file → kept
      ],
      [folder(V2)]: [
        { name: "run_live.mp4", updated_at: OLD }, // the run holding the claim → kept
        { name: "run_old.mp4", updated_at: OLD }, // stray → removed
      ],
    });
    const result = await cleanupStrayRunFiles({ store: f.store, storage: f.storage, now: () => NOW });
    expect(f.removed.sort()).toEqual([`${folder(V1)}/run_a.mp4`, `${folder(V2)}/run_old.mp4`]);
    expect(result).toEqual({ videos: 2, removed: f.removed, kept: 5, failed: 0 });
    expect(f.store.listEditedVideos).toHaveBeenCalledWith(EDIT.stray_run_videos_per_pass);
  });

  it("re-reads the row before removing: a file the row now points at is never removed", async () => {
    const rows: CleanupVideo[] = [{ id: V1, brand_id: BRAND, status: "final_qa", final_path: finalPathFor(BRAND, V1, "run_b"), edit_run_id: "run_b" }];
    const f = fakes(rows, { [folder(V1)]: [{ name: "run_a.mp4", updated_at: OLD }] });
    // Between the listing and the removal the row is pointed at run_a (e.g. by hand in a fix).
    f.storage.list = vi.fn(async () => {
      rows[0].final_path = finalPathFor(BRAND, V1, "run_a");
      return [{ name: "run_a.mp4", updated_at: OLD }];
    });
    const result = await cleanupStrayRunFiles({ store: f.store, storage: f.storage, now: () => NOW });
    expect(f.removed).toEqual([]);
    expect(result.kept).toBe(1);
  });

  it("a failed removal is counted and logged, and the sweep goes on", async () => {
    const rows: CleanupVideo[] = [
      { id: V1, brand_id: BRAND, status: "team_review", final_path: null, edit_run_id: "run_x" },
      { id: V2, brand_id: BRAND, status: "team_review", final_path: null, edit_run_id: "run_y" },
    ];
    const f = fakes(rows, {
      [folder(V1)]: [{ name: "run_x.mp4", updated_at: OLD }],
      [folder(V2)]: [{ name: "run_y.mp4", updated_at: OLD }],
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.storage.remove = vi.fn(async (p: string) => {
      if (p.includes(V1)) throw new Error("storage 500");
      f.removed.push(p);
    });
    const result = await cleanupStrayRunFiles({ store: f.store, storage: f.storage, now: () => NOW });
    expect(result).toMatchObject({ videos: 2, removed: [`${folder(V2)}/run_y.mp4`], failed: 1 });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("the wait is a safety margin far beyond a run's life", () => {
    expect(EDIT.stray_run_min_age_s).toBeGreaterThanOrEqual(2 * EDIT.task_max_duration_s + EDIT.claim_stale_s);
  });
});
