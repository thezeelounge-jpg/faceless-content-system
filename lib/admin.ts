// Admins are the emails listed in ADMIN_EMAILS (comma-separated).
// This is always checked on the server, never only in the browser.

export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export function isAdminEmail(
  email: string | null | undefined,
  raw: string | undefined = process.env.ADMIN_EMAILS,
): boolean {
  if (!email) return false;
  return parseAdminEmails(raw).includes(email.trim().toLowerCase());
}
