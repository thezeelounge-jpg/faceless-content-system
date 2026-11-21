import Link from "next/link";
import { AdminPage } from "@/components/admin/admin-page";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { adminSection } from "@/lib/admin-sections";
import { NICHE_PRESETS } from "@/lib/brand-input";
import { listBrands } from "@/lib/brands";

const section = adminSection("/admin/clients");

export default function ClientsPage() {
  return (
    <AdminPage title={section.label} description={section.about}>
      <Link href="/admin/clients/new" className={buttonVariants({ size: "lg" })}>
        New client
      </Link>
      <ClientList />
    </AdminPage>
  );
}

async function ClientList() {
  let brands;
  try {
    brands = await listBrands();
  } catch (error) {
    console.error("[admin] clients:", error instanceof Error ? error.message : error);
    return <p className="text-destructive mt-4 text-sm">Couldn&apos;t load clients. Check that Supabase is set up.</p>;
  }

  if (brands.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent className="text-muted-foreground text-sm">No clients yet. Add the first one.</CardContent>
      </Card>
    );
  }

  return (
    <ul className="divide-border border-border mt-4 divide-y rounded-lg border">
      {brands.map((brand) => (
        <li key={brand.id}>
          <Link href={`/admin/clients/${brand.id}`} className="hover:bg-muted flex items-center justify-between gap-3 p-3">
            <span className="min-w-0">
              <span className="block truncate font-medium">{brand.name}</span>
              <span className="text-muted-foreground block text-xs">
                {NICHE_PRESETS.find((n) => n.value === brand.niche)?.label ?? "No niche"}
                {brand.is_managed ? " · Done for you" : " · Self-serve"}
              </span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {brand.current_version > 0 ? `Profile v${brand.current_version}` : "No profile yet"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
