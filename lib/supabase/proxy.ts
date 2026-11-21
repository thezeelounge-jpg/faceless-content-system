import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicConfig } from "@/lib/config";

export type ProxyUser = { id: string; email: string | null };

/**
 * Runs on every request (from proxy.ts). Refreshes the login cookies so
 * sessions don't expire while someone is using the app, and tells the proxy
 * who is signed in.
 */
export async function updateSession(
  request: NextRequest,
): Promise<{ response: NextResponse; user: ProxyUser | null }> {
  let response = NextResponse.next({ request });

  const config = getSupabasePublicConfig();
  if (!config) return { response, user: null };

  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  // Must run before anything else so a refreshed token is written back.
  const { data, error } = await supabase.auth.getClaims();
  const claims = error ? null : data?.claims;
  const user = claims?.sub ? { id: claims.sub, email: claims.email ?? null } : null;

  return { response, user };
}

/** Copies refreshed login cookies onto a redirect or rewrite response. */
export function withSessionCookies(from: NextResponse, to: NextResponse): NextResponse {
  from.cookies.getAll().forEach((cookie) => to.cookies.set(cookie));
  const cacheControl = from.headers.get("Cache-Control");
  if (cacheControl) to.headers.set("Cache-Control", cacheControl);
  return to;
}
