import "server-only";
import { z } from "zod";
import type { PlannedPostRow, PlanSettings } from "@/lib/planner";
import { localDateString } from "@/lib/posting-times";
import type { StoredScript } from "@/lib/qa/script-pipeline";
import type { NewScriptRow } from "@/lib/scripts";
import { createAdminClient } from "@/lib/supabase/admin";

// Posts and plan settings for the admin area. Uses the secret key, so call
// these only after requireAdmin().

const ramadanSetting = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

/** Ramadan dates from app_settings ("ramadan": { start, end }). Missing or broken → none. */
export async function loadPlanSettings(): Promise<PlanSettings> {
  const { data, error } = await createAdminClient().from("app_settings").select("value").eq("key", "ramadan").maybeSingle();
  if (error) throw new Error(`Could not load plan settings: ${error.message}`);
  const parsed = ramadanSetting.safeParse(data?.value);
  return { ramadan: parsed.success ? parsed.data : null };
}

/** The local date of the brand's last post, or null when it has none. */
export async function lastPlannedDate(brandId: string, timezone: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("posts")
    .select("scheduled_for")
    .eq("brand_id", brandId)
    .order("scheduled_for", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load posts: ${error.message}`);
  return data ? localDateString(new Date(data.scheduled_for as string), timezone) : null;
}

export async function insertPosts(rows: PlannedPostRow[]): Promise<void> {
  const { error } = await createAdminClient().from("posts").insert(rows);
  if (error) throw new Error(`Could not save posts: ${error.message}`);
}

export type PostRow = {
  id: string;
  brand_id: string;
  scheduled_for: string;
  pillar: string | null;
  title: string;
  hook: string | null;
  format: "talking" | "story";
  status: string;
  status_reason?: string | null;
};

export type PostWithScript = PostRow & {
  scripts: {
    id: string;
    version: number;
    qa_status: string;
    est_seconds: number | null;
    display_text: string | null;
    spoken_text: string | null;
    hashtags: string[];
  }[];
};

/** Posts from a week ago onward, oldest first, with their scripts. */
export async function listPosts(brandId: string): Promise<PostWithScript[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await createAdminClient()
    .from("posts")
    .select("id, brand_id, scheduled_for, pillar, title, hook, format, status, status_reason, scripts(id, version, qa_status, est_seconds, display_text, spoken_text, hashtags)")
    .eq("brand_id", brandId)
    .gte("scheduled_for", since)
    .order("scheduled_for", { ascending: true })
    .limit(120);
  if (error) throw new Error(`Could not load posts: ${error.message}`);
  return (data ?? []) as unknown as PostWithScript[];
}

/** The plan on the brand owner's profile (null when none, e.g. managed brands). */
export async function getOwnerPlan(ownerId: string): Promise<string | null> {
  const { data, error } = await createAdminClient().from("profiles").select("plan").eq("id", ownerId).maybeSingle();
  if (error) throw new Error(`Could not load the owner's plan: ${error.message}`);
  return (data?.plan as string | null | undefined) ?? null;
}

/**
 * Saves version 1 of a post's script, marks the post "scripting" (the QA
 * gates move it on) and returns the script id. The unique (post_id, version)
 * rule stops doubles.
 */
export async function saveFirstScript(row: NewScriptRow): Promise<string> {
  const db = createAdminClient();
  const { data, error } = await db.from("scripts").insert(row).select("id").single();
  if (error) throw new Error(`Could not save script: ${error.message}`);
  const { error: postError } = await db
    .from("posts")
    .update({ status: "scripting" })
    .eq("id", row.post_id)
    .eq("status", "planned");
  if (postError) throw new Error(`Could not update post status: ${postError.message}`);
  return (data as { id: string }).id;
}

/** Ids come from the browser: anything that isn't a UUID is "not found", without asking the database. */
export function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

const SCRIPT_COLUMNS =
  "id, post_id, version, est_seconds, qa_status, spoken_text, hook, body, cta, display_text, captions, hashtags, broll_keywords, edit_plan";

export type ScriptVersionRow = Pick<StoredScript, "id" | "version" | "qa_status" | "spoken_text">;

/** A script, its post and every version of the post's script, for "Run checks". */
export async function getScriptForChecks(
  scriptId: string,
): Promise<{ script: StoredScript; post: PostRow; versions: ScriptVersionRow[] } | null> {
  if (!isUuid(scriptId)) return null;
  const db = createAdminClient();
  const { data, error } = await db.from("scripts").select(SCRIPT_COLUMNS).eq("id", scriptId).maybeSingle();
  if (error) throw new Error(`Could not load script: ${error.message}`);
  if (!data) return null;
  const script = { ...(data as unknown as StoredScript), est_seconds: Number((data as { est_seconds: unknown }).est_seconds) };
  const post = await getPost(script.post_id);
  if (!post) return null;
  const { data: versions, error: versionsError } = await db
    .from("scripts")
    .select("id, version, qa_status, spoken_text")
    .eq("post_id", post.id);
  if (versionsError) throw new Error(`Could not load script versions: ${versionsError.message}`);
  return { script, post, versions: (versions ?? []) as ScriptVersionRow[] };
}

/**
 * Saves one plain sentence on a post that is still being scripted, so the
 * problem shows on the row (status unchanged). The QA gates clear it when
 * they move the post on.
 */
export async function savePostProblem(postId: string, reason: string): Promise<void> {
  if (!isUuid(postId)) return;
  const { error } = await createAdminClient()
    .from("posts")
    .update({ status_reason: reason })
    .eq("id", postId)
    .in("status", ["planned", "scripting"]);
  if (error) throw new Error(`Could not save the post's problem: ${error.message}`);
}

export async function getPost(postId: string): Promise<PostRow | null> {
  if (!isUuid(postId)) return null;
  const { data, error } = await createAdminClient()
    .from("posts")
    .select("id, brand_id, scheduled_for, pillar, title, hook, format, status")
    .eq("id", postId)
    .maybeSingle();
  if (error) throw new Error(`Could not load post: ${error.message}`);
  return (data as PostRow | null) ?? null;
}
