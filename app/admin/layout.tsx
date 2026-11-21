import Link from "next/link";
import type { Metadata } from "next";
import { ADMIN_SECTIONS } from "@/lib/admin-sections";

export const metadata: Metadata = {
  title: "Admin · Creator Tool",
  robots: { index: false, follow: false },
};

// Admin shell. Access is checked inside each page (see components/admin/admin-page.tsx)
// and, as a first quick check, in proxy.ts.
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-border border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/admin" className="font-semibold">
            Creator Tool · Admin
          </Link>
          <Link href="/dashboard" className="text-muted-foreground text-sm hover:underline">
            My account
          </Link>
        </div>
        <nav aria-label="Admin sections" className="mx-auto max-w-5xl overflow-x-auto px-4">
          <ul className="flex gap-1 pb-2 text-sm whitespace-nowrap">
            {ADMIN_SECTIONS.map((section) => (
              <li key={section.href}>
                <Link href={section.href} className="hover:bg-muted block rounded-md px-2.5 py-1.5">
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
