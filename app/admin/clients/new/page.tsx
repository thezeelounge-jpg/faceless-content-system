import Link from "next/link";
import { AdminPage } from "@/components/admin/admin-page";
import { BrandForm } from "@/components/onboarding/brand-form";
import { createManagedBrand } from "./actions";

export default function NewClientPage() {
  return (
    <AdminPage title="New client" description="A done-for-you client. Takes about 10 minutes with the client on a call.">
      <p className="text-sm">
        <Link href="/admin/clients" className="text-muted-foreground hover:underline">
          ← All clients
        </Link>
      </p>
      <BrandForm action={createManagedBrand} submitLabel="Save client" />
    </AdminPage>
  );
}
