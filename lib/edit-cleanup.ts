import { logAdminError } from "@/lib/admin-errors";
import { EDIT } from "@/lib/qa/config";

// p5-a (QA NICE, p4-b3): "Clean up old edit files".
//
// Each edit run uploads to its own final/<brand>/<video>/runs/<run>.mp4 and the
// row points at it only after finishEdit (lib/edit-flow.ts). A crash between
// the upload and finishEdit / removeOurFile can leave a run file that no row
// points at. This sweep removes ONLY such a file, and only when ALL hold:
//   - its name is a run file (<run id>.mp4, the same characters as finalPathFor);
//   - the video row does not point at it (videos.final_path), re-read just
//     before the removal;
//   - the run does not hold the edit claim (status 'editing' with that run id);
//   - it is older than EDIT.stray_run_min_age_s (unknown age = kept).
// Admin-pressed (app/admin/edit-cleanup-actions.ts); no scheduled task, so
// nothing is deleted automatically. Store and storage are injected (tests: fakes).

export type RunFile = { name: string; updated_at: string | null };
export type CleanupVideo = { id: string; brand_id: string; status: string; final_path: string | null; edit_run_id: string | null };

export interface CleanupStore {
  /** Post videos that ever had an edit run (edit_run_id set), newest edits first. */
  listEditedVideos(limit: number): Promise<CleanupVideo[]>;
  getVideo(id: string): Promise<CleanupVideo | null>;
}

/** The PRIVATE videos bucket: one folder listing (not recursive) and one removal. */
export interface RunFileStorage {
  list(folder: string): Promise<RunFile[]>;
  remove(path: string): Promise<void>;
}

export type CleanupResult = { videos: number; removed: string[]; kept: number; failed: number };

const RUN_FILE = /^[A-Za-z0-9_-]{1,128}\.mp4$/;

function holdsClaim(row: CleanupVideo, run: string): boolean {
  return row.status === "editing" && row.edit_run_id === run;
}

export async function cleanupStrayRunFiles(deps: {
  store: CleanupStore;
  storage: RunFileStorage;
  now?: () => Date;
}): Promise<CleanupResult> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const result: CleanupResult = { videos: 0, removed: [], kept: 0, failed: 0 };
  for (const video of await deps.store.listEditedVideos(EDIT.stray_run_videos_per_pass)) {
    result.videos++;
    const folder = `final/${video.brand_id}/${video.id}/runs`;
    const candidates: { path: string; run: string }[] = [];
    for (const file of await deps.storage.list(folder)) {
      const age = file.updated_at ? (now - Date.parse(file.updated_at)) / 1000 : NaN;
      const run = file.name.replace(/\.mp4$/, "");
      const path = `${folder}/${file.name}`;
      if (!RUN_FILE.test(file.name) || !(age > EDIT.stray_run_min_age_s) || path === video.final_path || holdsClaim(video, run)) {
        result.kept++;
        continue;
      }
      candidates.push({ path, run });
    }
    if (candidates.length === 0) continue;
    // Re-read the row right before removing: never a file it points at now, never a claimed run.
    const fresh = await deps.store.getVideo(video.id);
    for (const { path, run } of candidates) {
      if (!fresh || path === fresh.final_path || holdsClaim(fresh, run)) {
        result.kept++;
        continue;
      }
      try {
        await deps.storage.remove(path);
        result.removed.push(path);
      } catch (error) {
        result.failed++;
        logAdminError("[edit-cleanup] remove failed", { videoId: video.id }, error);
      }
    }
  }
  console.info(`[edit-cleanup] videos=${result.videos} removed=${result.removed.length} kept=${result.kept} failed=${result.failed}`);
  return result;
}
