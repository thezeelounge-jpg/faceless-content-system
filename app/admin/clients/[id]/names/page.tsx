import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/admin/action-button";
import { AdminPage } from "@/components/admin/admin-page";
import { AddNameForm, EditNameForm } from "@/components/admin/name-forms";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";
import { getBrand } from "@/lib/brands";
import { listPronunciations } from "@/lib/pronunciations";
import { addName, approveName, editName } from "./actions";

export default function NamesPage({ params }: PageProps<"/admin/clients/[id]/names">) {
  return (
    <AdminPage
      title="How to say names"
      description="How the twin should say names, places and short forms. Only approved names are used."
    >
      <NamesList params={params} />
    </AdminPage>
  );
}

async function NamesList({ params }: Pick<PageProps<"/admin/clients/[id]/names">, "params">) {
  await requireAdmin();
  const { id } = await params;
  const brand = await getBrand(id);
  if (!brand) notFound();
  const names = await listPronunciations(brand.id);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href={`/admin/clients/${brand.id}`} className="text-muted-foreground hover:underline">
          ← {brand.name}
        </Link>
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Add a name</CardTitle>
        </CardHeader>
        <CardContent>
          <AddNameForm action={addName.bind(null, brand.id)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Names ({names.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {names.length === 0 ? (
            <p className="text-muted-foreground text-sm">No names yet. Script checks suggest new ones here.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {names.map((name) => (
                <li key={name.id} className="space-y-2 py-3">
                  <div className="text-muted-foreground text-xs">
                    {name.status === "approved" ? "Approved" : "Suggested — not used until approved"} ·{" "}
                    {name.source === "qa" ? "from script checks" : "added by hand"}
                  </div>
                  <EditNameForm
                    key={`${name.written}|${name.say_as}`}
                    action={editName.bind(null, brand.id, name.id)}
                    written={name.written}
                    sayAs={name.say_as}
                  />
                  {name.status === "suggested" && (
                    <ActionButton
                      action={approveName.bind(null, brand.id, name.id)}
                      label="Approve"
                      pendingLabel="Approving…"
                      size="sm"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
