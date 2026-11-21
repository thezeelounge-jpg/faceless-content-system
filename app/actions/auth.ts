"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupabasePublicConfig } from "@/lib/config";

export async function signOut() {
  if (getSupabasePublicConfig()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
