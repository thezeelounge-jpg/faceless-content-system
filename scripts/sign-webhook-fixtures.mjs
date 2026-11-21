// Writes the .sig file next to each HeyGen webhook fixture in
// tests/fixtures/heygen/webhooks/: hex HMAC-SHA256 of the file's exact bytes,
// keyed with the TEST-ONLY secret below (never a real secret).
// Run after editing a fixture: node scripts/sign-webhook-fixtures.mjs
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TEST_WEBHOOK_SECRET = "test-webhook-secret-not-real";
const dir = path.resolve("tests/fixtures/heygen/webhooks");

for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
  const raw = readFileSync(path.join(dir, file));
  const signature = createHmac("sha256", TEST_WEBHOOK_SECRET).update(raw).digest("hex");
  writeFileSync(path.join(dir, file.replace(/\.json$/, ".sig")), `${signature}\n`);
  console.log(`signed ${file}`);
}
