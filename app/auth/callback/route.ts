import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-redirect";

const EMAIL_TYPES: EmailOtpType[] = ["email", "magiclink", "signup", "invite", "recovery", "email_change"];

// Login links (email and Google) land here. We swap the one-time code for a
// session cookie, then send the person to where they were going.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNextPath(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  try {
    const supabase = await createClient();

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL(next, url.origin));
      console.error("[auth/callback] code exchange failed:", error.message);
    } else if (tokenHash && type && EMAIL_TYPES.includes(type)) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      if (!error) return NextResponse.redirect(new URL(next, url.origin));
      console.error("[auth/callback] token check failed:", error.message);
    }
  } catch (error) {
    console.error("[auth/callback] failed:", error instanceof Error ? error.message : error);
  }

  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
