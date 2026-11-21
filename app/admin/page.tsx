import Link from "next/link";
import { AdminPage } from "@/components/admin/admin-page";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ADMIN_SECTIONS } from "@/lib/admin-sections";

export default function AdminOverviewPage() {
  return (
    <AdminPage title="Admin" description="Run the done-for-you service from here.">
      <div className="grid gap-3 sm:grid-cols-2">
        {ADMIN_SECTIONS.map((section) => (
          <Link key={section.href} href={section.href} className="rounded-xl focus-visible:outline-2">
            <Card className="hover:bg-muted/50 h-full transition-colors">
              <CardHeader>
                <CardTitle>{section.label}</CardTitle>
                <CardDescription>
                  {section.about} {section.phase > 1 ? `(Phase ${section.phase})` : ""}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </AdminPage>
  );
}
