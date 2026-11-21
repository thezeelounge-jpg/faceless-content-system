import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminPage } from "@/components/admin/admin-page";
import { StartConsentForm } from "@/components/admin/consent-forms";
import { RecordingGuide } from "@/components/admin/recording-guide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";
import { getBrand } from "@/lib/brands";
import { startConsentAction } from "@/app/admin/consents/actions";

// Consent for one brand (admin now; customers get the same steps in Phase 6).

export default function ConsentStartPage({ params }: PageProps<"/admin/clients/[id]/consent">) {
  return (
    <AdminPage title="Consent clip" description="Step 1: who is in the clip, and do they agree.">
      <StartConsent params={params} />
    </AdminPage>
  );
}

async function StartConsent({ params }: Pick<PageProps<"/admin/clients/[id]/consent">, "params">) {
  await requireAdmin();
  const { id } = await params;
  const brand = await getBrand(id);
  if (!brand) notFound();
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href={`/admin/clients/${brand.id}`} className="text-muted-foreground hover:underline">
          ← {brand.name}
        </Link>
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Start a consent for {brand.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <StartConsentForm action={startConsentAction.bind(null, brand.id)} />
        </CardContent>
      </Card>
      <RecordingGuide />
    </div>
  );
}
