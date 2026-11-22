import dns, { promises as dnsPromisesNamed } from "node:dns";
import dnsPromisesModule, { lookup as lookupNamed, resolve4 as resolve4Named } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalNetworkAllowed, networkAllowed, realFetchForGuardTests } from "@/tests/setup/network-guard";

// SF5: no test can ever reach the network. tests/setup/no-network.ts swaps
// globalThis.fetch for a thrower before every test (vitest.config.mts
// setupFiles). These tests prove the thrower is on by default, and that a
// passthrough spy or vi.restoreAllMocks() can't bring the real fetch back.
//
// SF1 (p3-fix2): the guard also blocks sockets, so node:http, node:https,
// net, tls and undici (Node's own fetch) can't reach anything either. Every
// socket test below aims at a LOCAL stub server on 127.0.0.1 started inside
// the test, so even with the guard switched off (mutation check) nothing
// leaves this machine: the request would just reach the stub, and the test
// fails because the stub saw it.

afterEach(() => vi.restoreAllMocks());

describe("network is disabled in tests", () => {
  it("globalThis.fetch rejects with 'network disabled in tests' and names the URL", async () => {
    await expect(globalThis.fetch("https://api.heygen.com/v3/users/me")).rejects.toThrow(
      "network disabled in tests: https://api.heygen.com/v3/users/me",
    );
  });

  it("a spy without a mock passes through to the thrower, not to the real fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow("network disabled in tests");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("after vi.restoreAllMocks() fetch is still the thrower", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fake"));
    vi.restoreAllMocks();
    await expect(fetch(new URL("https://example.supabase.co/rest/v1/brands"))).rejects.toThrow(
      "network disabled in tests: https://example.supabase.co/rest/v1/brands",
    );
  });
});

describe("sockets are blocked too: http, https, net, tls, undici (SF1)", () => {
  // A local stub that counts every connection and request it sees.
  let server: http.Server;
  let port = 0;
  let connections = 0;
  let requests = 0;

  beforeEach(async () => {
    connections = 0;
    requests = 0;
    server = http.createServer((_req, res) => {
      requests += 1;
      res.end("reached the stub");
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Gives a client a moment to reach the stub if the guard let it through.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const swallow = (emitter: { on(event: "error", fn: (e: Error) => void): unknown }) => emitter.on("error", () => {});

  it("http.get to a local stub on 127.0.0.1 is BLOCKED and the stub never sees it", async () => {
    let reached = false;
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/" }, () => {
        reached = true;
      });
      swallow(req);
    };
    expect(attempt).toThrow(`network disabled in tests: 127.0.0.1:${port}`);
    await settle();
    expect(reached).toBe(false);
    expect(requests).toBe(0);
    expect(connections).toBe(0);
  });

  it("http.request with a URL string is blocked", async () => {
    expect(() => swallow(http.request(`http://127.0.0.1:${port}/x`))).toThrow(
      `network disabled in tests: 127.0.0.1:${port}`,
    );
    await settle();
    expect(connections).toBe(0);
  });

  it("https.request and https.get are blocked", async () => {
    expect(() => swallow(https.request({ hostname: "127.0.0.1", port, path: "/" }))).toThrow(
      `network disabled in tests: 127.0.0.1:${port}`,
    );
    expect(() => swallow(https.get(`https://127.0.0.1:${port}/`))).toThrow("network disabled in tests");
    await settle();
    expect(connections).toBe(0);
  });

  it("net.connect and net.createConnection are blocked", async () => {
    expect(() => swallow(net.connect({ host: "127.0.0.1", port }))).toThrow(
      `network disabled in tests: 127.0.0.1:${port}`,
    );
    expect(() => swallow(net.createConnection(port, "127.0.0.1"))).toThrow(
      `network disabled in tests: 127.0.0.1:${port}`,
    );
    await settle();
    expect(connections).toBe(0);
  });

  it("a hand-made net.Socket can't connect either (the socket-level backstop)", async () => {
    const socket = new net.Socket();
    swallow(socket);
    expect(() => socket.connect(port, "127.0.0.1")).toThrow(`network disabled in tests: 127.0.0.1:${port}`);
    socket.destroy();
    await settle();
    expect(connections).toBe(0);
  });

  it("tls.connect is blocked", async () => {
    expect(() => swallow(tls.connect({ host: "127.0.0.1", port, servername: "localhost" }))).toThrow(
      `network disabled in tests: 127.0.0.1:${port}`,
    );
    await settle();
    expect(connections).toBe(0);
  });

  it("Node's real fetch (undici) is blocked at the socket and never reaches the stub", async () => {
    const realFetch = realFetchForGuardTests();
    expect(realFetch).not.toBe(globalThis.fetch);
    const outcome = await realFetch(`http://127.0.0.1:${port}/`).then(
      async (res) => ({ ok: true as const, body: await res.text() }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(outcome.ok).toBe(false);
    const cause = outcome.ok ? undefined : (outcome.error as { cause?: unknown }).cause;
    expect(String((cause as Error | undefined)?.message)).toContain("network disabled in tests");
    expect(requests).toBe(0);
    expect(connections).toBe(0);
  });
});

describe("DNS is blocked too: node:dns, dns.promises, node:dns/promises, Resolver (p4-fix a)", () => {
  // No real lookup can happen: every call must fail with our own message, not
  // with EAI_AGAIN / ECONNREFUSED from a real resolver.
  const HOST = "api.heygen.com";
  const DISABLED = `network disabled in tests: ${HOST}`;

  it("dns.lookup (callback) fails with the disabled message", async () => {
    const error = await new Promise<unknown>((resolve) => {
      try {
        dns.lookup(HOST, (err) => resolve(err));
      } catch (thrown) {
        resolve(thrown);
      }
    });
    expect(String((error as Error | null)?.message)).toBe(DISABLED);
  });

  it("dns.resolve4 / resolve / lookupService (callback) fail with the disabled message", async () => {
    const viaCallback = (start: (cb: (err: unknown) => void) => void) =>
      new Promise<unknown>((resolve) => {
        try {
          start((err) => resolve(err));
        } catch (thrown) {
          resolve(thrown);
        }
      });
    expect(String(((await viaCallback((cb) => dns.resolve4(HOST, cb))) as Error).message)).toBe(DISABLED);
    expect(String(((await viaCallback((cb) => dns.resolve(HOST, cb))) as Error).message)).toBe(DISABLED);
    expect(String(((await viaCallback((cb) => dns.lookupService("8.8.8.8", 53, cb))) as Error).message)).toContain(
      "network disabled in tests",
    );
  });

  it("dns.promises.lookup rejects with the disabled message (default import)", async () => {
    await expect(dns.promises.lookup(HOST)).rejects.toThrow(DISABLED);
    await expect(dns.promises.resolveAny(HOST)).rejects.toThrow(DISABLED);
  });

  it("`import { promises } from 'node:dns'` sees the guard", async () => {
    await expect(dnsPromisesNamed.lookup(HOST, { all: true })).rejects.toThrow(DISABLED);
    await expect(dnsPromisesNamed.resolve6(HOST)).rejects.toThrow(DISABLED);
  });

  it("node:dns/promises resolve4 rejects (default and named imports)", async () => {
    await expect(dnsPromisesModule.resolve4(HOST)).rejects.toThrow(DISABLED);
    await expect(resolve4Named(HOST)).rejects.toThrow(DISABLED);
    await expect(lookupNamed(HOST)).rejects.toThrow(DISABLED);
  });

  it("only `lookup` of a literal IP passes (Node answers it without a query); names and 'localhost' do not", async () => {
    await expect(dns.promises.lookup("127.0.0.1")).resolves.toMatchObject({ address: "127.0.0.1", family: 4 });
    await expect(dns.promises.lookup("localhost")).rejects.toThrow("network disabled in tests: localhost");
    await expect(dns.promises.resolve4("127.0.0.1")).rejects.toThrow("network disabled in tests: 127.0.0.1");
  });

  it("new dns.Resolver().resolve4 and new dns.promises.Resolver().resolve4 fail", async () => {
    const resolver = new dns.Resolver();
    const error = await new Promise<unknown>((resolve) => {
      try {
        resolver.resolve4(HOST, (err) => resolve(err));
      } catch (thrown) {
        resolve(thrown);
      }
    });
    expect(String((error as Error | null)?.message)).toBe(DISABLED);
    await expect(new dns.promises.Resolver().resolve4(HOST)).rejects.toThrow(DISABLED);
    await expect(new dnsPromisesModule.Resolver().resolveTxt(HOST)).rejects.toThrow(DISABLED);
  });
});

describe("only the opt-in staging tests may use the network", () => {
  const staging = path.resolve("tests/staging/consent-store.staging.test.ts");
  const unit = path.resolve("tests/unit/heygen.test.ts");

  it("is off by default, even for the staging file", () => {
    expect(networkAllowed({ env: {}, testPath: staging })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "true" }, testPath: staging })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: unit })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: undefined })).toBe(false);
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: path.resolve("tests/staging/../unit/x.test.ts") })).toBe(false);
  });

  it("is on only with RUN_STAGING_TESTS=1 AND a file under tests/staging", () => {
    expect(networkAllowed({ env: { RUN_STAGING_TESTS: "1" }, testPath: staging })).toBe(true);
  });

  it("this test file runs with the thrower on (RUN_STAGING_TESTS is not set here)", () => {
    expect(process.env.RUN_STAGING_TESTS).toBeUndefined();
    expect(networkAllowed({ env: process.env, testPath: expect.getState().testPath })).toBe(false);
  });
});

describe("eval:scripts loads the guard unless BOTH live flags are on", () => {
  it("guards by default and with only one of the two flags", () => {
    expect(evalNetworkAllowed({})).toBe(false);
    expect(evalNetworkAllowed({ MOCK_CLAUDE: "true" })).toBe(false);
    expect(evalNetworkAllowed({ MOCK_CLAUDE: "false" })).toBe(false);
    expect(evalNetworkAllowed({ EVAL_ALLOW_NETWORK: "1" })).toBe(false);
    expect(evalNetworkAllowed({ MOCK_CLAUDE: "true", EVAL_ALLOW_NETWORK: "1" })).toBe(false);
  });

  it("needs MOCK_CLAUDE exactly 'false' AND EVAL_ALLOW_NETWORK exactly '1'", () => {
    expect(evalNetworkAllowed({ MOCK_CLAUDE: "FALSE", EVAL_ALLOW_NETWORK: "1" })).toBe(false);
    expect(evalNetworkAllowed({ MOCK_CLAUDE: "false", EVAL_ALLOW_NETWORK: "true" })).toBe(false);
    expect(evalNetworkAllowed({ MOCK_CLAUDE: "false", EVAL_ALLOW_NETWORK: "1" })).toBe(true);
  });
});
