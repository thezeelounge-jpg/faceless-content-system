// Reads settings from environment variables (.env.local on your laptop,
// project settings on Vercel and Trigger.dev). Never put real keys in code.

/** Returns the value of an env var, or undefined when it is missing or blank. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Money safety: HeyGen and speech-to-text run in mock mode unless the env var
 * is exactly "false". Forgetting to set it can never spend money by accident.
 */
export function isMockHeygen(): boolean {
  return process.env.MOCK_HEYGEN?.trim() !== "false";
}

export function isMockStt(): boolean {
  return process.env.MOCK_STT?.trim() !== "false";
}

/**
 * B-roll search (Pexels, Phase 4 part B) follows the same rule. In this phase
 * there is no real client at all: mock = local fixture clips; "false" = a
 * plain "not set up yet" error (lib/broll.ts).
 */
export function isMockPexels(): boolean {
  return process.env.MOCK_PEXELS?.trim() !== "false";
}

/** Claude follows the same rule: sample answers, no API calls, unless exactly "false". */
export function isMockClaude(): boolean {
  return process.env.MOCK_CLAUDE?.trim() !== "false";
}

/**
 * Money safety: the most guarded HeyGen calls per Asia/Karachi day, used when
 * app_settings has no `heygen_daily_caps` row (lib/heygen-spend.ts). The
 * migration inserts the same numbers; the admin can change them there.
 */
export const HEYGEN_DAILY_CAP_DEFAULTS = { render: 3, create_twin: 2 } as const;

export function isGoogleLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GOOGLE_LOGIN?.trim() === "true";
}

/** The public address of the app, used in login emails. */
export function getSiteUrl(): string {
  const configured = readEnv("NEXT_PUBLIC_SITE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const vercelUrl = readEnv("VERCEL_URL");
  if (vercelUrl) return `https://${vercelUrl}`;
  return "http://localhost:3000";
}

export type SupabasePublicConfig = { url: string; publishableKey: string };

/** Returns the Supabase address and public key, or null if not set up yet. */
export function getSupabasePublicConfig(): SupabasePublicConfig | null {
  const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const publishableKey = readEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !publishableKey) return null;
  return { url, publishableKey };
}

export const SUPABASE_NOT_SET_UP =
  "Supabase is not set up yet. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to .env.local, then restart the app.";

/** Env vars the app uses, which phase needs them, and whether each is secret. */
export const ENV_CHECKLIST: { name: string; phase: number; secret: boolean; note: string }[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", phase: 1, secret: false, note: "Supabase project address" },
  { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", phase: 1, secret: false, note: "Supabase public key" },
  { name: "SUPABASE_SECRET_KEY", phase: 1, secret: true, note: "Supabase secret key (server only)" },
  { name: "ADMIN_EMAILS", phase: 1, secret: false, note: "Who can open /admin" },
  { name: "TRIGGER_SECRET_KEY", phase: 1, secret: true, note: "Starts background jobs" },
  { name: "ANTHROPIC_API_KEY", phase: 2, secret: true, note: "Claude API" },
  { name: "HEYGEN_API_KEY", phase: 3, secret: true, note: "HeyGen API" },
  { name: "HEYGEN_WEBHOOK_SECRET", phase: 3, secret: true, note: "Checks HeyGen webhooks" },
  { name: "STT_API_KEY", phase: 4, secret: true, note: "Speech-to-text" },
  { name: "PEXELS_API_KEY", phase: 4, secret: true, note: "Stock b-roll" },
  { name: "RESEND_API_KEY", phase: 5, secret: true, note: "Email" },
  { name: "LEMONSQUEEZY_API_KEY", phase: 7, secret: true, note: "Card payments" },
];

/** Which env vars are set. Returns names and true/false only, never values. */
export function envStatus() {
  return ENV_CHECKLIST.map((item) => ({ ...item, isSet: readEnv(item.name) !== undefined }));
}
