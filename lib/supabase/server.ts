import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabasePublicConfig, SUPABASE_NOT_SET_UP } from "@/lib/config";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * It acts as the signed-in user, so Row Level Security applies.
 * Create a new one for every request; never share it.
 */
export async function createClient() {
  const config = getSupabasePublicConfig();
  if (!config) throw new Error(SUPABASE_NOT_SET_UP);

  const cookieStore = await cookies();

  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components can't set cookies. That's fine: proxy.ts refreshes
          // the session cookies on every request.
        }
      },
    },
  });
}
