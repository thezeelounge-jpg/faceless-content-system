"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl, getSupabasePublicConfig, isGoogleLoginEnabled } from "@/lib/config";
import { safeNextPath } from "@/lib/safe-redirect";

export type LoginState =
  | { status: "idle"; message: string }
  | { status: "sent"; message: string; email: string }
  | { status: "error"; message: string };

const emailSchema = z.email();

function callbackUrl(next: string) {
  return `${getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`;
}

/** Emails a one-time login link. New emails get an account automatically. */
export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = emailSchema.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  if (!parsed.success) {
    return { status: "error", message: "Please enter a valid email address." };
  }
  if (!getSupabasePublicConfig()) {
    return { status: "error", message: "Login isn't set up yet. The Supabase keys are missing." };
  }

  const next = safeNextPath(formData.get("next"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: callbackUrl(next) },
  });

  if (error) {
    console.error("[login] magic link failed:", error.status, error.code, error.message);
    const tooMany = error.status === 429;
    return {
      status: "error",
      message: tooMany
        ? "Too many login emails just now. Please wait a minute and try again."
        : "We couldn't send the login email. Please try again in a minute.",
    };
  }

  return { status: "sent", message: "Check your email for a login link.", email: parsed.data };
}

/** Starts Google login (only when NEXT_PUBLIC_GOOGLE_LOGIN=true). */
export async function signInWithGoogle(formData: FormData) {
  if (!isGoogleLoginEnabled() || !getSupabasePublicConfig()) redirect("/login");

  const next = safeNextPath(formData.get("next"));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(next) },
  });

  if (error || !data.url) {
    console.error("[login] google failed:", error?.message);
    redirect("/login?error=google");
  }
  redirect(data.url);
}
