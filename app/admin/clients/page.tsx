import { AdminPage } from "@/components/admin/admin-page";
import { adminSection } from "@/lib/admin-sections";

const section = adminSection("/admin/clients");

export default function ClientsPage() {
  return <AdminPage title={section.label} description={section.about} phase={section.phase} />;
}
