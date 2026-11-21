import { AdminPage } from "@/components/admin/admin-page";
import { adminSection } from "@/lib/admin-sections";

const section = adminSection("/admin/videos");

export default function VideosPage() {
  return <AdminPage title={section.label} description={section.about} phase={section.phase} />;
}
