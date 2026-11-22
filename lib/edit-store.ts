import "server-only";
import type { CleanupStore, CleanupVideo, RunFileStorage } from "@/lib/edit-cleanup";
import type { EditFiles, EditStore, EditVideoRow } from "@/lib/edit-flow";
import { EDIT } from "@/lib/qa/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { VIDEO_BUCKET } from "@/lib/video-store";

// Supabase versions of EditStore and EditFiles for the edit task. They use
// the SECRET key, so they run only inside the background task (never in a
// page). Columns written here (status, transcript, final_path, error) stay
// server only: customers can read just the granted videos columns.
// Tests use fakes (tests/unit/edit-flow.test.ts).

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[edit] ${what}: ${error?.message ?? "no data"}`);
}

export function createEditStore(): EditStore {
  const db = createAdminClient();
  return {
    async getVideo(id) {
      const { data, error } = await db
        .from("videos")
        .select("id, brand_id, kind, status, raw_path, final_path, transcript, error, ai_label, watermark")
        .eq("id", id)
        .maybeSingle();
      if (error) fail("load video", error);
      return (data as EditVideoRow | null) ?? null;
    },
    async startEdit(id, run) {
      // p4-b1: rpc start_edit (one run at a time; same run or a stale claim may re-claim).
      const { data, error } = await db.rpc("start_edit", { p_video_id: id, p_run: run, p_stale_s: EDIT.claim_stale_s });
      if (error) fail("start edit", error);
      return data === true;
    },
    async saveTranscript(id, run, transcript) {
      // p5-a: only while still 'editing' AND claimed by this run (a superseded run writes nothing).
      const { data, error } = await db
        .from("videos")
        .update({ transcript })
        .eq("id", id)
        .eq("status", "editing")
        .eq("edit_run_id", run)
        .select("id")
        .maybeSingle();
      if (error) fail("save transcript", error);
      return data !== null;
    },
    async finishEdit(id, run, patch) {
      // Only while still 'editing' AND claimed by this run: never overwrite another run's result.
      const { data, error } = await db
        .from("videos")
        .update(patch)
        .eq("id", id)
        .eq("status", "editing")
        .eq("edit_run_id", run)
        .select("id")
        .maybeSingle();
      if (error) fail("finish edit", error);
      return data !== null;
    },
    async setPostStatusForVideo(id, status, reason) {
      const { data: video, error } = await db.from("videos").select("script_id").eq("id", id).maybeSingle();
      if (error) fail("load video script", error);
      if (!video?.script_id) return;
      const { data: script, error: scriptError } = await db.from("scripts").select("post_id").eq("id", video.script_id).maybeSingle();
      if (scriptError) fail("load script", scriptError);
      if (!script?.post_id) return;
      const { error: postError } = await db.from("posts").update({ status, status_reason: reason }).eq("id", script.post_id);
      if (postError) fail("update post status", postError);
    },
  };
}

type StorageErrorLike = { message: string; status?: number; statusCode?: string };
type StorageAnswer<T> = { data: T | null; error: StorageErrorLike | null };

/** The bucket calls we use (Supabase storage-js; tests pass a fake). */
export type EditBucket = {
  download(path: string, options?: undefined, parameters?: { signal?: AbortSignal }): PromiseLike<StorageAnswer<Blob>>;
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): PromiseLike<StorageAnswer<unknown>>;
  remove(paths: string[]): PromiseLike<StorageAnswer<unknown>>;
};

export type StorageRetryOptions = {
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

/** One failed storage try; `retryable` decides whether another try may help. */
class StorageTryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Worth another try: a timeout, a network error (no HTTP status, e.g. storage-js
 * StorageUnknownError or a thrown fetch error), 408, 429 or any 5xx.
 * Not: other 4xx (not found, no permission, too large) — those never pass.
 */
function retryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/**
 * p4-b1 (QA SF4): runs one storage call with a per-try timeout and a bounded retry.
 * The timeout aborts the try's signal (download passes it to storage-js; upload and
 * remove have no signal option in storage-js, so their late answer is ignored — a
 * retried upload overwrites the same path, upsert). Errors keep `what` but never
 * the storage URL; lib/edit-flow.ts saves its own plain sentence on the row.
 */
async function withStorageRetry<T>(
  what: string,
  call: (signal: AbortSignal) => PromiseLike<StorageAnswer<T>>,
  options: StorageRetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StorageTryError(`[edit] ${what}: timed out after ${options.timeoutMs} ms`, true));
        }, options.timeoutMs);
      });
      let answer: StorageAnswer<T>;
      try {
        answer = await Promise.race([Promise.resolve(call(controller.signal)), timeout]);
      } catch (error) {
        if (error instanceof StorageTryError) throw error;
        throw new StorageTryError(`[edit] ${what}: request failed`, true, { cause: error });
      }
      if (answer.error) {
        throw new StorageTryError(`[edit] ${what}: ${answer.error.message}`, retryableStatus(answer.error.status));
      }
      if (answer.data === null) throw new StorageTryError(`[edit] ${what}: no data`, false);
      return answer.data;
    } catch (error) {
      const tryError = error as StorageTryError;
      if (!tryError.retryable || attempt >= options.maxAttempts) throw tryError;
      const backoff = options.backoffMs * 2 ** (attempt - 1);
      await options.sleep(backoff + Math.round(options.random() * options.backoffMs));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** p5-a: the cleanup's reads (lib/edit-cleanup.ts). Server only, after requireAdmin. */
export function createCleanupStore(): CleanupStore {
  const db = createAdminClient();
  const columns = "id, brand_id, status, final_path, edit_run_id";
  return {
    async listEditedVideos(limit) {
      const { data, error } = await db
        .from("videos")
        .select(columns)
        .eq("kind", "post")
        .not("edit_run_id", "is", null)
        .order("edit_started_at", { ascending: false })
        .limit(limit);
      if (error) fail("list edited videos", error);
      return (data ?? []) as CleanupVideo[];
    },
    async getVideo(id) {
      const { data, error } = await db.from("videos").select(columns).eq("id", id).maybeSingle();
      if (error) fail("load video", error);
      return (data as CleanupVideo | null) ?? null;
    },
  };
}

/** The bucket calls the cleanup uses (Supabase storage-js; tests pass a fake). */
export type CleanupBucket = {
  list(
    path: string,
    options: { limit: number },
  ): PromiseLike<StorageAnswer<{ name: string; updated_at?: string | null; created_at?: string | null }[]>>;
  remove(paths: string[]): PromiseLike<StorageAnswer<unknown>>;
};

/** p5-a: list + remove in the PRIVATE videos bucket, each with the edit task's timeout + bounded retry. */
export function createRunFileStorage(
  bucket: CleanupBucket = createAdminClient().storage.from(VIDEO_BUCKET),
  overrides: Partial<StorageRetryOptions> = {},
): RunFileStorage {
  const options = retryOptions(overrides);
  return {
    async list(folder) {
      const files = await withStorageRetry("list run files", () => bucket.list(folder, { limit: 1000 }), options);
      return files.map((f) => ({ name: f.name, updated_at: f.updated_at ?? f.created_at ?? null }));
    },
    async remove(path) {
      await withStorageRetry("remove run file", () => bucket.remove([path]), options);
    },
  };
}

function retryOptions(overrides: Partial<StorageRetryOptions>): StorageRetryOptions {
  return {
    timeoutMs: EDIT.storage_timeout_s * 1000,
    maxAttempts: EDIT.storage_max_attempts,
    backoffMs: EDIT.storage_backoff_ms,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    ...overrides,
  };
}

/** The PRIVATE videos bucket (raw/ in, final/ out). Every call: timeout + bounded retry (EDIT in lib/qa/config.ts). */
export function createEditFiles(
  bucket: EditBucket = createAdminClient().storage.from(VIDEO_BUCKET),
  overrides: Partial<StorageRetryOptions> = {},
): EditFiles {
  const options = retryOptions(overrides);
  return {
    async download(path) {
      const data = await withStorageRetry("download raw video", (signal) => bucket.download(path, undefined, { signal }), options);
      return new Uint8Array(await data.arrayBuffer());
    },
    async upload(path, bytes, contentType) {
      await withStorageRetry("upload final video", () => bucket.upload(path, bytes, { contentType, upsert: true }), options);
    },
    async remove(path) {
      await withStorageRetry("remove final video", () => bucket.remove([path]), options);
    },
  };
}
