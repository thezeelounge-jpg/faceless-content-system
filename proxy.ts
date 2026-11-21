import { NextResponse, type NextRequest } from "next/server";
import { updateSession, withSessionCookies } from "@/lib/supabase/proxy";
import { isAdminEmail } from "@/lib/admin";
import { isAdminPath, isProtectedPath } from "@/lib/safe-redirect";

// Runs before every page request (Next.js 16 calls middleware "proxy").
// 1. Keeps login sessions fresh.
// 2. Quick check: logged-out people can't open /dashboard or /admin,
//    and non-admins can't open /admin.
// The real permission checks also run on the server in each page and action.
export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);
  const path = request.nextUrl.pathname;

  if (isProtectedPath(path) && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", path);
    return withSessionCookies(response, NextResponse.redirect(loginUrl));
  }

  if (isAdminPath(path) && user && !isAdminEmail(user.email)) {
    return withSessionCookies(response, new NextResponse("Not found", { status: 404 }));
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static files and images.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp4|txt)$).*)",
  ],
};
