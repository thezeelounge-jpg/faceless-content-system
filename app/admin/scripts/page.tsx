import { AdminPage } from "@/components/admin/admin-page";
import { adminSection } from "@/lib/admin-sections";

const section = adminSection("/admin/scripts");

export default function ScriptsPage() {
  return <AdminPage title={section.label} description={section.about} phase={section.phase} />;
}
