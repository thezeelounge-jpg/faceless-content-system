import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Home · Creator Tool" };

// Placeholder home for signed-in people. The real customer app comes in Phase 6.
export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}

async function DashboardContent() {
  const user = await requireUser("/dashboard");
  const supabase = await createClient();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("email, role, created_at")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">You’re logged in</CardTitle>
        <CardDescription>{user.email}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          {profile
            ? "Your account record is set up."
            : error
              ? "The database isn't set up yet (the tables haven't been created)."
              : "Your account record is missing. Ask the admin to check the database setup."}
        </p>
        <div className="flex flex-wrap gap-2">
          {user.isAdmin && (
            <Link href="/admin" className={buttonVariants({ size: "lg" })}>
              Open admin
            </Link>
          )}
          <form action={signOut}>
            <Button type="submit" variant="outline" size="lg">
              Log out
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
