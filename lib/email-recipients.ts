// Decision 6 (Rowan): who gets which (mocked) email in the done-for-you flow.
// - HeyGen consent link: the client's own email, plus a copy for each admin.
// - Reshoot tips: admins only (they talk to the client).
// Admins come from ADMIN_EMAILS (lib/admin.ts). Emails are only rows in
// email_outbox with status 'mocked'; nothing is sent.

const norm = (email: string) => email.trim().toLowerCase();

/**
 * The client: the brand's contact_email, else the brand owner, unless the
 * owner is an admin (done-for-you brands are owned by the admin until the
 * Phase 6 handover). Null when we don't know the client's email.
 */
export function clientEmailFor(
  brand: { contactEmail: string | null; ownerEmail: string | null },
  adminEmails: string[],
): string | null {
  if (brand.contactEmail?.trim()) return norm(brand.contactEmail);
  if (!brand.ownerEmail?.trim()) return null;
  const owner = norm(brand.ownerEmail);
  return adminEmails.map(norm).includes(owner) ? null : owner;
}

export function consentLinkRecipients(clientEmail: string | null, adminEmails: string[]): { to: string; copy: boolean }[] {
  const out: { to: string; copy: boolean }[] = clientEmail ? [{ to: norm(clientEmail), copy: false }] : [];
  for (const admin of adminEmails.map(norm)) {
    if (!out.some((r) => r.to === admin)) out.push({ to: admin, copy: true });
  }
  return out;
}

/** Admins only, each once (lower-case). */
export function adminRecipients(adminEmails: string[]): string[] {
  return [...new Set(adminEmails.map(norm))];
}

export function reshootRecipients(adminEmails: string[]): string[] {
  return adminRecipients(adminEmails);
}
