// The admin (operator) area, from docs/PRODUCT.md. `phase` is when each
// section gets built (see PROMPTS.md).
export const ADMIN_SECTIONS = [
  { href: "/admin/clients", label: "Clients", phase: 2, about: "Add done-for-you clients, brand profiles and monthly plans." },
  { href: "/admin/consents", label: "Consents & twins", phase: 3, about: "Check consent clips, create twins and run likeness tests." },
  { href: "/admin/scripts", label: "Scripts", phase: 2, about: "Read, fix and approve scripts and their QA reports." },
  { href: "/admin/qa", label: "QA queue", phase: 5, about: "Videos waiting for a human check." },
  { href: "/admin/videos", label: "Videos", phase: 3, about: "Every video, its status and its history." },
  { href: "/admin/usage", label: "Usage & spend", phase: 5, about: "Quality metrics, costs and cost per delivered video." },
  { href: "/admin/payments", label: "Payments", phase: 7, about: "Plans, card payments and manual payments." },
  { href: "/admin/settings", label: "Settings", phase: 1, about: "Money-safety switches, setup status and test jobs." },
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export function adminSection(href: AdminSection["href"]): AdminSection {
  const section = ADMIN_SECTIONS.find((item) => item.href === href);
  if (!section) throw new Error(`Unknown admin section: ${href}`);
  return section;
}
