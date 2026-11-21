// Scans the browser bundle (.next/static) for secrets. Reports only file
// names and pattern names, never the matched text, so a leak is never
// copied into a log.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ENV_CHECKLIST } from "@/lib/config";

export type Finding = { file: string; pattern: string };

const SECRET_NAMES = ENV_CHECKLIST.filter((item) => item.secret).map((item) => item.name);

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

/** True for Supabase "service_role" JWTs. Public "anon" JWTs are fine in the browser. */
function isServiceRoleJwt(payload: string): boolean {
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: unknown };
    return json.role === "service_role";
  } catch {
    return false;
  }
}

/**
 * The names of every secret pattern found in `text`.
 * `envValues` are the real secret values from this machine's env (if any);
 * they are compared but never returned.
 */
export function findSecrets(text: string, envValues: Record<string, string | undefined> = {}): string[] {
  const found = new Set<string>();
  if (/sk-ant-[A-Za-z0-9_-]{8,}/.test(text)) found.add("anthropic key (sk-ant-)");
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) found.add("supabase secret key (sb_secret_)");
  for (const match of text.matchAll(JWT)) {
    if (isServiceRoleJwt(match[1])) found.add("supabase service_role JWT");
  }
  for (const name of SECRET_NAMES) {
    if (text.includes(name)) found.add(`secret env name ${name}`);
    const value = envValues[name]?.trim();
    if (value && value.length >= 8 && text.includes(value)) found.add(`value of ${name}`);
  }
  return [...found].sort();
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/** Scans every text file under `dir` (relative names in the result). */
export function scanDirectory(dir: string, envValues: Record<string, string | undefined> = {}): Finding[] {
  const findings: Finding[] = [];
  for (const file of listFiles(dir)) {
    if (!/\.(js|mjs|cjs|json|css|html|txt|map)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of findSecrets(text, envValues)) {
      findings.push({ file: path.relative(dir, file), pattern });
    }
  }
  return findings;
}

/** The secret env values set on this machine, by name (for comparison only). */
export function secretEnvValues(): Record<string, string | undefined> {
  return Object.fromEntries(SECRET_NAMES.map((name) => [name, process.env[name]]));
}
