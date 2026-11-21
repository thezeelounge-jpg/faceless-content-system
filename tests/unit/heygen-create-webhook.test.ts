import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBHOOK_EVENTS, main } from "@/scripts/heygen-create-webhook";

// Item 9: the one-time webhook setup script. NEVER run in tests or by the
// Builder: we import main() and give it a FAKE fetch. Guards: it refuses
// unless MOCK_HEYGEN is exactly "false" AND --yes-create-webhook is passed.
// It never writes the secret anywhere; it prints it once, labelled.

afterEach(() => vi.restoreAllMocks());

const URL_ARG = "--url=https://app.example.com/api/webhooks/heygen";
const LIVE_ENV = { MOCK_HEYGEN: "false", HEYGEN_API_KEY: "test-key-not-real" };

function run(argv: string[], env: Record<string, string | undefined>, answer?: unknown) {
  const lines: string[] = [];
  const fake = vi.fn(async () => new Response(JSON.stringify(answer ?? { data: { endpoint_id: "ep_1", secret: "s3cr3t-shown-once" } })));
  const globalSpy = vi.spyOn(globalThis, "fetch");
  const done = main(argv, { env, print: (line) => lines.push(line), fetch: fake as unknown as typeof fetch });
  return { done, lines, fake, globalSpy };
}

describe("guards", () => {
  for (const value of [undefined, "true", "", "FALSE", "no"]) {
    it(`MOCK_HEYGEN=${JSON.stringify(value)}: refuses, nothing fetched`, async () => {
      const { done, lines, fake, globalSpy } = run(["--yes-create-webhook", URL_ARG], { ...LIVE_ENV, MOCK_HEYGEN: value });
      expect(await done).toBe(1);
      expect(lines.join("\n")).toContain('Refusing: MOCK_HEYGEN must be exactly "false"');
      expect(fake).not.toHaveBeenCalled();
      expect(globalSpy).not.toHaveBeenCalled();
    });
  }

  it("without --yes-create-webhook: refuses, nothing fetched", async () => {
    const { done, lines, fake } = run([URL_ARG], LIVE_ENV);
    expect(await done).toBe(1);
    expect(lines.join("\n")).toContain("Refusing: add --yes-create-webhook");
    expect(fake).not.toHaveBeenCalled();
  });

  it("an http (not https) or missing URL: refuses", async () => {
    const http = run(["--yes-create-webhook", "--url=http://localhost:3000/api/webhooks/heygen"], LIVE_ENV);
    expect(await http.done).toBe(1);
    expect(http.lines.join("\n")).toContain("needs a public https URL");
    const none = run(["--yes-create-webhook"], LIVE_ENV);
    expect(await none.done).toBe(1);
    expect(none.fake).not.toHaveBeenCalled();
  });

  it("no HEYGEN_API_KEY: refuses", async () => {
    const { done, lines, fake } = run(["--yes-create-webhook", URL_ARG], { MOCK_HEYGEN: "false" });
    expect(await done).toBe(1);
    expect(lines.join("\n")).toContain("HEYGEN_API_KEY is not set");
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("with both guards passed (FAKE fetch)", () => {
  it("POSTs our URL and the two video events to /v3/webhooks/endpoints", async () => {
    const { done, fake } = run(["--yes-create-webhook", URL_ARG], LIVE_ENV);
    expect(await done).toBe(0);
    expect(WEBHOOK_EVENTS).toEqual(["avatar_video.success", "avatar_video.fail"]);
    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.heygen.com/v3/webhooks/endpoints");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://app.example.com/api/webhooks/heygen", events: WEBHOOK_EVENTS });
  });

  it("uses NEXT_PUBLIC_SITE_URL when no --url is given", async () => {
    const { done, fake } = run(["--yes-create-webhook"], { ...LIVE_ENV, NEXT_PUBLIC_SITE_URL: "https://site.example.com/" });
    expect(await done).toBe(0);
    const [, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).url).toBe("https://site.example.com/api/webhooks/heygen");
  });

  it("prints the secret exactly once, labelled, and tells the owner to paste it into .env.local themselves", async () => {
    const { done, lines } = run(["--yes-create-webhook", URL_ARG], LIVE_ENV);
    expect(await done).toBe(0);
    const out = lines.join("\n");
    expect(out.split("s3cr3t-shown-once")).toHaveLength(2); // once
    expect(out).toContain("HEYGEN_WEBHOOK_SECRET (HeyGen shows it only once; copy it now):");
    expect(out).toContain("Paste it into .env.local yourself");
    expect(out).toContain("This script did not save it anywhere.");
  });

  it("no secret in HeyGen's answer: says where to find it instead", async () => {
    const { done, lines } = run(["--yes-create-webhook", URL_ARG], LIVE_ENV, { data: { endpoint_id: "ep_2" } });
    expect(await done).toBe(0);
    expect(lines.join("\n")).toContain("HeyGen did not return a secret. Open the HeyGen dashboard");
  });

  it("a HeyGen error: exit 1 with a plain message (no key in it)", async () => {
    const lines: string[] = [];
    const fake = vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }));
    const code = await main(["--yes-create-webhook", URL_ARG], { env: LIVE_ENV, print: (l) => lines.push(l), fetch: fake as unknown as typeof fetch });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("HeyGen did not accept the API key.");
    expect(lines.join("\n")).not.toContain("test-key-not-real");
  });
});

describe("the script file itself", () => {
  it("never writes files (no secret saved anywhere) and is not in any npm script", () => {
    const source = readFileSync("scripts/heygen-create-webhook.ts", "utf8");
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|node:fs/);
    expect(readFileSync("package.json", "utf8")).not.toContain("heygen-create-webhook");
  });
});
