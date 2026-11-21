import Link from "next/link";
import { AdminPage } from "@/components/admin/admin-page";
import { Card, CardContent } from "@/components/ui/card";
import { adminSection } from "@/lib/admin-sections";
import { requireAdmin } from "@/lib/auth";
import { createConsentStore } from "@/lib/consent-store";

const section = adminSection("/admin/consents");

export default function ConsentsAndTwinsPage() {
  return (
    <AdminPage title={section.label} description={section.about}>
      <ConsentList />
    </AdminPage>
  );
}

async function ConsentList() {
  await requireAdmin();
  const store = createConsentStore();
  const consents = await store.listConsents();
  const brandNames = new Map<string, string>();
  for (const id of new Set(consents.map((c) => c.brand_id))) {
    brandNames.set(id, (await store.getBrandContact(id))?.name ?? "Unknown client");
  }
  if (consents.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          No consent clips yet. Open a client and press “Consent clip and twin”.
        </CardContent>
      </Card>
    );
  }
  return (
    <ul className="divide-y rounded border">
      {consents.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
          <Link href={`/admin/consents/${c.id}`} className="font-medium underline">
            {brandNames.get(c.brand_id)}: {c.person_legal_name}
          </Link>
          <span className="text-muted-foreground">
            {c.admin_status} · {c.clip_checks ? (c.clip_checks.passed ? "checks passed" : "checks failed") : c.clip_path ? "not checked" : "no clip yet"} ·{" "}
            {new Date(c.created_at).toLocaleDateString("en-GB")}
          </span>
        </li>
      ))}
    </ul>
  );
}
