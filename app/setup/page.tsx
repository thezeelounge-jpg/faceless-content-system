import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EnvStatusList, MockModeList } from "@/components/env-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Setup check · Creator Tool", robots: { index: false } };

// Laptop-only page: shows which keys are in .env.local before login works.
// Hidden (404) on the live site.
export default function SetupPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="mx-auto w-full max-w-xl flex-1 space-y-4 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Setup check</h1>
      <p className="text-muted-foreground text-sm">
        Only visible on your laptop. Fill in .env.local in Notepad, then restart the app. Values are never shown here.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Phase 1 settings</CardTitle>
          <CardDescription>Needed for login, the database, admin and background jobs.</CardDescription>
        </CardHeader>
        <CardContent>
          <EnvStatusList upToPhase={1} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Money safety</CardTitle>
        </CardHeader>
        <CardContent>
          <MockModeList />
        </CardContent>
      </Card>
    </main>
  );
}
