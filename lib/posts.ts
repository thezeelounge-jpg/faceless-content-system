import "server-only";
import { z } from "zod";
import type { PlannedPostRow, PlanSettings } from "@/lib/planner";
import { localDateString } from "@/lib/posting-times";
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
};

export type PostWithScript = PostRow & {
  scripts: { id: string; version: number; qa_status: string; est_seconds: number | null }[];
};

/** Posts from a week ago onward, oldest first, with their scripts. */
export async function listPosts(brandId: string): Promise<PostWithScript[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await createAdminClient()
    .from("posts")
    .select("id, brand_id, scheduled_for, pillar, title, hook, format, status, scripts(id, version, qa_status, est_seconds)")
    .eq("brand_id", brandId)
    .gte("scheduled_for", since)
    .order("scheduled_for", { ascending: true })
    .limit(120);
  if (error) throw new Error(`Could not load posts: ${error.message}`);
  return (data ?? []) as unknown as PostWithScript[];
}

export async function getPost(postId: string): Promise<PostRow | null> {
  const { data, error } = await createAdminClient()
    .from("posts")
    .select("id, brand_id, scheduled_for, pillar, title, hook, format, status")
    .eq("id", postId)
    .maybeSingle();
  if (error) throw new Error(`Could not load post: ${error.message}`);
  return (data as PostRow | null) ?? null;
}
