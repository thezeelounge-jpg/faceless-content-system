import { AdminPage } from "@/components/admin/admin-page";
import { ActionForm } from "@/components/admin/action-form";
import { EDIT } from "@/lib/qa/config";
import { cleanupEditFilesAction } from "../edit-cleanup-actions";
import { ResumeRenders } from "@/components/admin/resume-renders";
import { StuckClaims } from "@/components/admin/stuck-claims";
import { EnvStatusList, MockModeList } from "@/components/env-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminSection } from "@/lib/admin-sections";
import { RunTestJob } from "./run-test-job";

const section = adminSection("/admin/settings");

export default function SettingsPage() {
  return (
    <AdminPage title={section.label} description={section.about}>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Money safety</CardTitle>
            <CardDescription>Mock mode uses sample files and spends nothing.</CardDescription>
          </CardHeader>
          <CardContent>
            <MockModeList />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Background jobs</CardTitle>
            <CardDescription>
              Starts the test job on Trigger.dev. On your laptop, keep <code>npm run trigger:dev</code> running.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunTestJob />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>HeyGen connection</CardTitle>
            <CardDescription>
              Checks the HeyGen key (GET /v3/users/me, free). In mock mode it shows the sample user and calls nothing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a className="text-sm underline" href="/api/admin/heygen-check" target="_blank" rel="noreferrer">
              Check HeyGen
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>HeyGen pause switch</CardTitle>
            <CardDescription>
              The daily spend cap pauses all HeyGen work. Check today&apos;s HeyGen spend before resuming. Every resume is logged.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResumeRenders />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stuck HeyGen claims</CardTitle>
            <CardDescription>
              Renders, likeness tests or twins whose HeyGen answer was lost. Look in the HeyGen dashboard first: only clear one if
              nothing was made there, or you may pay twice.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StuckClaims />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Old edit files</CardTitle>
            <CardDescription>
              Removes leftover edit files from runs that stopped half-way. Never a file a video uses, never one still being
              edited, and only files older than {EDIT.stray_run_min_age_s / 3600} hours.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={cleanupEditFilesAction}
              label="Clean up old edit files"
              pendingLabel="Cleaning up…"
              confirmCheck={{ name: "confirm_cleanup", label: "Remove old edit files that no video uses." }}
              variant="outline"
              size="sm"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Setup status</CardTitle>
            <CardDescription>Which settings are filled in. Values are never shown.</CardDescription>
          </CardHeader>
          <CardContent>
            <EnvStatusList />
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
