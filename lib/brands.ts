import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Reads brands for the admin area. Uses the secret key, so call these only
// after requireAdmin() (admin pages load data inside <AdminPage>).

export type BrandRow = {
  id: string;
  owner_id: string;
  name: string;
  niche: string | null;
  audience: string | null;
  offers: string | null;
  tone: string | null;
  sound_answers: Record<string, string>;
  samples: string | null;
  banned_words: string[];
  language: "en" | "roman_urdu" | "hinglish";
  pillars: unknown;
  posting_days: number[];
  posts_per_week: number;
  audience_countries: string[];
  posting_times_override: unknown;
  autopilot_level: string;
  words_per_second: number;
  is_managed: boolean;
  paused: boolean;
  profile_md: string | null;
  current_version: number;
  created_at: string;
};

export type BrandVersionRow = {
  id: string;
  version: number;
  source: "generated" | "edited";
  created_at: string;
};

export async function listBrandVersions(brandId: string): Promise<BrandVersionRow[]> {
  const { data, error } = await createAdminClient()
    .from("brand_versions")
    .select("id, version, source, created_at")
    .eq("brand_id", brandId)
    .order("version", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Could not load profile history: ${error.message}`);
  return (data ?? []) as BrandVersionRow[];
}

export type BrandListItem = Pick<BrandRow, "id" | "name" | "niche" | "is_managed" | "current_version" | "created_at">;

export async function listBrands(): Promise<BrandListItem[]> {
  const { data, error } = await createAdminClient()
    .from("brands")
    .select("id, name, niche, is_managed, current_version, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not load clients: ${error.message}`);
  return (data ?? []) as BrandListItem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBrandId(id: string): boolean {
  return UUID.test(id);
}

export async function getBrand(id: string): Promise<BrandRow | null> {
  if (!isBrandId(id)) return null;
  const { data, error } = await createAdminClient().from("brands").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load client: ${error.message}`);
  return (data as BrandRow | null) ?? null;
}
