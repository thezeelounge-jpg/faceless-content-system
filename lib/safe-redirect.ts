// After login we send people back to the page they wanted. Only allow paths
// inside this app, so a login link can never bounce someone to another site.

export const DEFAULT_AFTER_LOGIN = "/dashboard";

export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_AFTER_LOGIN;
  const path = value.trim();
  if (!path.startsWith("/")) return DEFAULT_AFTER_LOGIN;
  if (path.startsWith("//") || path.startsWith("/\\")) return DEFAULT_AFTER_LOGIN;
  if (path.includes("://")) return DEFAULT_AFTER_LOGIN;
  if (path === "/login" || path.startsWith("/login?") || path.startsWith("/auth/")) {
    return DEFAULT_AFTER_LOGIN;
  }
  return path;
}

export function isProtectedPath(path: string): boolean {
  return isUnder(path, "/dashboard") || isUnder(path, "/admin");
}

export function isAdminPath(path: string): boolean {
  return isUnder(path, "/admin");
}

function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}
