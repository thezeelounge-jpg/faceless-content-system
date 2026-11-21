import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminPage } from "@/components/admin/admin-page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AUTOPILOT_LEVELS, COUNTRIES, LANGUAGES, NICHE_PRESETS, WEEKDAYS } from "@/lib/brand-input";
import { getBrand } from "@/lib/brands";

export default function BrandPage({ params }: PageProps<"/admin/clients/[id]">) {
  return (
    <AdminPage title="Client">
      <p className="text-sm">
        <Link href="/admin/clients" className="text-muted-foreground hover:underline">
          ← All clients
        </Link>
      </p>
      <BrandDetail params={params} />
    </AdminPage>
  );
}

async function BrandDetail({ params }: Pick<PageProps<"/admin/clients/[id]">, "params">) {
  const { id } = await params;
  const brand = await getBrand(id);
  if (!brand) notFound();

  const label = <T extends { value: string | number; label: string }>(list: readonly T[], value: unknown) =>
    list.find((item) => item.value === value)?.label ?? String(value ?? "—");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{brand.name}</h2>
      <Card>
        <CardHeader>
          <CardTitle>Onboarding answers</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <Row term="Niche">{label(NICHE_PRESETS, brand.niche)}</Row>
            <Row term="Audience">{brand.audience}</Row>
            <Row term="Offers">{brand.offers}</Row>
            <Row term="Tone">{brand.tone}</Row>
            <Row term="Language">{label(LANGUAGES, brand.language)}</Row>
            <Row term="Posting">
              {brand.posts_per_week} a week on {brand.posting_days.map((d) => label(WEEKDAYS, d)).join(", ")}
            </Row>
            <Row term="Countries">{brand.audience_countries.map((c) => label(COUNTRIES, c)).join(", ")}</Row>
            <Row term="Autopilot">{label(AUTOPILOT_LEVELS, brand.autopilot_level)}</Row>
            <Row term="Banned words">{brand.banned_words.join(", ") || "None"}</Row>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="break-words whitespace-pre-wrap">{children}</dd>
    </>
  );
}
