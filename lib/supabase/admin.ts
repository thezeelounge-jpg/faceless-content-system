import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig, readEnv, SUPABASE_NOT_SET_UP } from "@/lib/config";

/**
 * Supabase client with the SECRET key. It skips Row Level Security, so:
 * - use it only in server code,
 * - only after checking who is asking (requireAdmin / requireUser),
 * - never send its results to the browser without filtering them.
 */
export function createAdminClient() {
  const config = getSupabasePublicConfig();
  const secretKey = readEnv("SUPABASE_SECRET_KEY");
  if (!config || !secretKey) {
    throw new Error(`${SUPABASE_NOT_SET_UP} Also add SUPABASE_SECRET_KEY.`);
  }
  return createClient(config.url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
