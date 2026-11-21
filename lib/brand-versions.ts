// Brand profile versions. Every "Write profile" and every edit saves a new
// brand_versions row through the save_brand_version() database function,
// which locks the brand row and bumps brands.current_version in one step.
import { brandProfileOutput, type BrandProfileOutput } from "@/lib/ai-schemas";

export const MAX_PILLARS = 6;

export type VersionSource = "generated" | "edited";

/** Anything with Supabase's rpc() (the admin client, or a fake in tests). */
export type RpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** What the brand-page actions send back. `values` refills the edit form after an error. */
export type ProfileActionState = {
  status: "idle" | "ok" | "error";
  message: string;
  values?: { profile_md: string; pillars: { name: string; description: string }[] };
  attempt?: number;
};

/** One plain sentence for what's wrong with an edited profile, or null when it's fine. */
export function profileProblem(profile: unknown): string | null {
  const result = brandProfileOutput.safeParse(profile);
  if (result.success) return null;
  const field = result.error.issues[0]?.path[0];
  if (field === "pillars") return "A profile needs 4 to 6 pillars, each with a name (2+ letters) and a description (10+ letters).";
  return "The profile text must be 200 to 8,000 characters.";
}

/** Reads the profile edit form (not yet checked). Empty pillar rows are skipped. */
export function profileFromFormData(data: FormData) {
  const get = (key: string) => {
    const value = data.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const pillars = [];
  for (let n = 1; n <= MAX_PILLARS; n++) {
    const name = get(`pillar_name_${n}`);
    const description = get(`pillar_description_${n}`);
    if (name || description) pillars.push({ name, description });
  }
  return { profile_md: get("profile_md"), pillars };
}

/** Checks the profile and saves it as the next version. Returns the new version number. */
export async function saveBrandVersion(
  db: RpcClient,
  brandId: string,
  profile: BrandProfileOutput,
  source: VersionSource,
): Promise<number> {
  const checked = brandProfileOutput.parse(profile);
  const { data, error } = await db.rpc("save_brand_version", {
    p_brand_id: brandId,
    p_profile_md: checked.profile_md,
    p_pillars: checked.pillars,
    p_source: source,
  });
  if (error) throw new Error(`Couldn't save the profile: ${error.message}`);
  if (typeof data !== "number") throw new Error("Couldn't save the profile: no version number came back.");
  return data;
}
