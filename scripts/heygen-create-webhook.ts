// ONE-TIME SETUP (owner only, with a real HEYGEN_API_KEY): registers our
// webhook address with HeyGen (POST /v3/webhooks/endpoints) for the events
// avatar_video.success and avatar_video.fail. Free, but it changes the live
// HeyGen workspace, so it is guarded twice:
//   1. MOCK_HEYGEN must be exactly "false", and
//   2. you must pass --yes-create-webhook.
// It never saves the secret anywhere. HeyGen shows the secret only once
// (docs "Webhooks": "will not be shown again"), so it is printed ONCE to this
// terminal, labelled. Paste it into .env.local yourself (and into Vercel and
// Trigger.dev env settings). How to run: docs/HEYGEN-NOTES.md, "How to run once".
// NOT part of any npm script; never run by tests or the Builder.

import { pathToFileURL } from "node:url";
import { HeygenError, createHeygenClient } from "../lib/heygen";

export const WEBHOOK_EVENTS = ["avatar_video.success", "avatar_video.fail"];

type Deps = {
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  /** Tests inject a FAKE fetch. The real run uses the global fetch. */
  fetch?: typeof globalThis.fetch;
};

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function targetUrl(argv: string[], env: Deps["env"]): string | null {
  const arg = argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);
  if (arg) return httpsUrl(arg);
  const site = httpsUrl(env.NEXT_PUBLIC_SITE_URL);
  return site ? `${site}/api/webhooks/heygen` : null;
}

/** Returns the exit code (0 = done). */
export async function main(argv: string[], deps: Deps): Promise<number> {
  const { env, print } = deps;
  if (env.MOCK_HEYGEN?.trim() !== "false") {
    print('Refusing: MOCK_HEYGEN must be exactly "false" for this one-time setup. Nothing was sent to HeyGen.');
    return 1;
  }
  if (!argv.includes("--yes-create-webhook")) {
    print("Refusing: add --yes-create-webhook to confirm you want to register the webhook on HeyGen. Nothing was sent.");
    return 1;
  }
  const url = targetUrl(argv, env);
  if (!url) {
    print("Refusing: HeyGen needs a public https URL, e.g. --url=https://your-app.vercel.app/api/webhooks/heygen. Nothing was sent.");
    return 1;
  }
  const apiKey = env.HEYGEN_API_KEY?.trim();
  if (!apiKey) {
    print("Refusing: HEYGEN_API_KEY is not set. Nothing was sent.");
    return 1;
  }

  const client = createHeygenClient({
    mock: false,
    apiKey,
    fetch: deps.fetch ?? ((...args) => globalThis.fetch(...args)),
  });
  try {
    const endpoint = await client.createWebhookEndpoint({ url, events: WEBHOOK_EVENTS });
    print(`Webhook registered on HeyGen for ${url} (endpoint id ${endpoint.endpointId}).`);
    if (endpoint.secret) {
      print("");
      print("HEYGEN_WEBHOOK_SECRET (HeyGen shows it only once; copy it now):");
      print(endpoint.secret);
      print("");
      print("Paste it into .env.local yourself as HEYGEN_WEBHOOK_SECRET=<the value above>,");
      print("then add the same value in Vercel and Trigger.dev (Environment Variables).");
      print("This script did not save it anywhere. Clear this terminal when you are done.");
    } else {
      print("HeyGen did not return a secret. Open the HeyGen dashboard (Settings → Webhooks) to find it,");
      print("then paste it into .env.local yourself as HEYGEN_WEBHOOK_SECRET.");
    }
    return 0;
  } catch (error) {
    print(error instanceof HeygenError ? error.message : "Could not register the webhook. Nothing was saved.");
    return 1;
  }
}

// Run only when started directly (never when a test imports main()).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { env: process.env, print: (line) => console.log(line) }).then((code) => process.exit(code));
}
