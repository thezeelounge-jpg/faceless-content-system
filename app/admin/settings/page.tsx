import { AdminPage } from "@/components/admin/admin-page";
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

        <Card className="md:col-span-2">
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
