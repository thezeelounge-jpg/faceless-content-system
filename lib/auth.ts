import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabasePublicConfig } from "@/lib/config";
import { isAdminEmail } from "@/lib/admin";

export type CurrentUser = { id: string; email: string; isAdmin: boolean };

/**
 * Who is signed in, checked with the Supabase Auth server.
 * Reads cookies, so call it only inside a <Suspense> boundary (Cache Components).
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Always decide at request time, never at build time, even before the
  // Supabase keys exist. Otherwise a build without keys would bake in a redirect.
  await connection();
  if (!getSupabasePublicConfig()) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const email = data.user.email ?? "";
  return { id: data.user.id, email, isAdmin: isAdminEmail(email) };
});

/** Sends logged-out people to the login page. */
export async function requireUser(nextPath = "/dashboard"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}

/** Admin-only pages and actions. Non-admins get "not found". */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser("/admin");
  if (!user.isAdmin) notFound();
  return user;
}
