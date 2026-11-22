import "server-only";
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
        .select("id, brand_id, kind, status, raw_path, final_path, transcript, error")
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
    async saveTranscript(id, transcript) {
      const { error } = await db.from("videos").update({ transcript }).eq("id", id);
      if (error) fail("save transcript", error);
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

/** The PRIVATE videos bucket (raw/ in, final/ out). */
export function createEditFiles(): EditFiles {
  const bucket = createAdminClient().storage.from(VIDEO_BUCKET);
  return {
    async download(path) {
      const { data, error } = await bucket.download(path);
      if (error || !data) fail("download raw video", error);
      return new Uint8Array(await data.arrayBuffer());
    },
    async upload(path, bytes, contentType) {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: true });
      if (error) fail("upload final video", error);
    },
    async remove(path) {
      const { error } = await bucket.remove([path]);
      if (error) fail("remove final video", error);
    },
  };
}
