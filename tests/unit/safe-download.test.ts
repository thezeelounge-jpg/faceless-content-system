import { EventEmitter } from "node:events";
import type http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SafeDownloadError,
  createHttpsTransport,
  createPinnedLookup,
  hostAllowed,
  isBlockedAddress,
  safeDownload,
  type ResolvedAddress,
  type SafeDownloadOptions,
} from "@/lib/safe-download";

// QA MUST FIX 1 (SSRF): the video downloader only fetches https links on the
// HeyGen allowlist, whose DNS answers are all public, following at most a few
// redirects (each re-checked), with a byte cap, a timeout and a video/* type.
// Everything here uses a FAKE fetch and a FAKE resolver: no network, no DNS.

afterEach(() => vi.restoreAllMocks());

const HOST = "resource2.heygen.ai";
const GOOD_URL = `https://${HOST}/videos/abc/VIDEO.mp4?sig=1`;
const PUBLIC_IP: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

type Call = { url: string; init: RequestInit };

function fakeFetch(answers: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error("no more fake answers");
    return next(call);
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

const video = (bytes = new Uint8Array([1, 2, 3, 4]), headers: Record<string, string> = {}) => () =>
  new Response(bytes, { status: 200, headers: { "content-type": "video/mp4", ...headers } });
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });

function options(fake: { fetch: typeof globalThis.fetch }, over: Partial<SafeDownloadOptions> = {}): SafeDownloadOptions {
  return {
    transport: fake.fetch,
    resolve: vi.fn(async () => PUBLIC_IP),
    allowedHosts: [HOST],
    maxBytes: 1_000,
    maxRedirects: 3,
    timeoutMs: 5_000,
    ...over,
  };
}

async function refusal(promise: Promise<unknown>): Promise<SafeDownloadError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SafeDownloadError);
  return error as SafeDownloadError;
}

describe("a. host allowlist (exact host or explicit .suffix, nothing else)", () => {
  it("hostAllowed: exact match only for plain entries; '.suffix' entries match on a dot boundary", () => {
    expect(hostAllowed("resource2.heygen.ai", ["resource2.heygen.ai"])).toBe(true);
    expect(hostAllowed("RESOURCE2.HEYGEN.AI", ["resource2.heygen.ai"])).toBe(true);
    expect(hostAllowed("resource2.heygen.ai.", ["resource2.heygen.ai"])).toBe(true);
    for (const host of ["evil-heygen.com", "heygen.com.evil.com", "xresource2.heygen.ai", "resource2.heygen.ai.evil.com", "heygen.ai", ""]) {
      expect(hostAllowed(host, ["resource2.heygen.ai"]), host).toBe(false);
    }
    expect(hostAllowed("a.files.example.org", [".files.example.org"])).toBe(true);
    expect(hostAllowed("files.example.org", [".files.example.org"])).toBe(false);
    expect(hostAllowed("evilfiles.example.org", [".files.example.org"])).toBe(false);
  });

  it("refuses look-alike hosts and userinfo tricks before any DNS or fetch, with a plain message (no URL)", async () => {
    const fake = fakeFetch([]);
    const opts = options(fake);
    for (const url of [
      "https://evil-heygen.com/v.mp4",
      `https://${HOST}.evil.com/v.mp4`,
      `https://${HOST}@evil.com/v.mp4`,
      `https://user:pass@${HOST}/v.mp4`,
      "https://files.heygen.ai/v.mp4",
      `https://${HOST}:8443/v.mp4`,
    ]) {
      const error = await refusal(safeDownload(url, opts));
      expect(["not_allowed", "bad_url"]).toContain(error.code);
      expect(error.message).not.toContain("evil");
      expect(error.message).not.toContain("://");
    }
    expect(fake.calls).toHaveLength(0);
    expect(opts.resolve).not.toHaveBeenCalled();
  });
});

describe("b. https only", () => {
  it("refuses http:, file:, data:, ftp: and junk (nothing fetched)", async () => {
    const fake = fakeFetch([]);
    const opts = options(fake);
    for (const url of [`http://${HOST}/v.mp4`, "file:///etc/passwd", "data:video/mp4;base64,AAAA", `ftp://${HOST}/v.mp4`, "not a url", ""]) {
      const error = await refusal(safeDownload(url, opts));
      expect(error.code).toBe("bad_url");
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("c. redirects: manual, at most maxRedirects hops, each hop re-checked", () => {
  it("asks fetch for redirect: 'manual' and follows an allowed redirect", async () => {
    const fake = fakeFetch([redirect(`https://${HOST}/videos/next.mp4`), video()]);
    const result = await safeDownload(GOOD_URL, options(fake));
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
    expect(fake.calls.map((c) => c.init.redirect)).toEqual(["manual", "manual"]);
    expect(fake.calls[1].url).toBe(`https://${HOST}/videos/next.mp4`);
  });

  it("a redirect to a host off the allowlist, to http, or to a metadata IP is refused (never fetched)", async () => {
    for (const location of ["https://evil.com/v.mp4", `http://${HOST}/v.mp4`, "https://169.254.169.254/latest/meta-data/"]) {
      const fake = fakeFetch([redirect(location)]);
      await refusal(safeDownload(GOOD_URL, options(fake)));
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("DNS is checked again on every hop", async () => {
    const resolve = vi.fn(async (host: string) => (host === "b.example.org" ? [{ address: "10.0.0.5", family: 4 }] : PUBLIC_IP));
    const fake = fakeFetch([redirect("https://b.example.org/v.mp4")]);
    const error = await refusal(safeDownload("https://a.example.org/v.mp4", options(fake, { resolve, allowedHosts: ["a.example.org", "b.example.org"] })));
    expect(error.code).toBe("private_address");
    expect(resolve.mock.calls.map(([h]) => h)).toEqual(["a.example.org", "b.example.org"]);
    expect(fake.calls).toHaveLength(1);
  });

  it("too many hops: refused after maxRedirects", async () => {
    const fake = fakeFetch([
      redirect(`https://${HOST}/1`),
      redirect(`https://${HOST}/2`),
      redirect(`https://${HOST}/3`),
      redirect(`https://${HOST}/4`),
      video(),
    ]);
    const error = await refusal(safeDownload(GOOD_URL, options(fake, { maxRedirects: 3 })));
    expect(error.code).toBe("too_many_redirects");
    expect(fake.calls).toHaveLength(4);
  });
});

describe("d. DNS: refuse private, loopback, link-local, CGNAT, ULA, unspecified, mapped and metadata addresses", () => {
  it("isBlockedAddress: the blocked ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "127.8.8.8",
      "::1",
      "169.254.1.1",
      "169.254.169.254",
      "fe80::1",
      "febf::1",
      "100.64.0.1",
      "100.127.255.255",
      "100.100.100.200",
      "fc00::1",
      "fd00:ec2::254",
      "0.0.0.0",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:7f00:1",
      "::ffff:10.1.2.3",
      "not-an-ip",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("isBlockedAddress: public addresses pass", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("refuses when ANY resolved address is blocked (nothing fetched)", async () => {
    const fake = fakeFetch([video()]);
    const resolve = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const error = await refusal(safeDownload(GOOD_URL, options(fake, { resolve })));
    expect(error.code).toBe("private_address");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses when DNS gives no address", async () => {
    const fake = fakeFetch([video()]);
    await refusal(safeDownload(GOOD_URL, options(fake, { resolve: vi.fn(async () => []) })));
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a literal-IP host even if someone put it on the allowlist", async () => {
    const fake = fakeFetch([video()]);
    for (const url of ["https://169.254.169.254/v.mp4", "https://[::1]/v.mp4", "https://93.184.216.34/v.mp4"]) {
      const host = new URL(url).hostname;
      await refusal(safeDownload(url, options(fake, { allowedHosts: [host] })));
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("e. byte cap and timeout", () => {
  it("Content-Length over the cap: refused up front, body not read", async () => {
    const fake = fakeFetch([video(new Uint8Array(10), { "content-length": "5000" })]);
    const error = await refusal(safeDownload(GOOD_URL, options(fake, { maxBytes: 1_000 })));
    expect(error.code).toBe("too_big");
  });

  it("a body that grows past the cap mid-stream is aborted (stream cancelled)", async () => {
    let pulled = 0;
    const cancel = vi.fn();
    // 20 chunks of 400 bytes (8,000 bytes, no Content-Length) against a 1,000-byte cap.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 20) controller.close();
        else controller.enqueue(new Uint8Array(400));
      },
      cancel,
    });
    const fake = fakeFetch([() => new Response(endless, { status: 200, headers: { "content-type": "video/mp4" } })]);
    const error = await refusal(safeDownload(GOOD_URL, options(fake, { maxBytes: 1_000 })));
    expect(error.code).toBe("too_big");
    expect(cancel).toHaveBeenCalled();
    expect(pulled).toBeLessThan(10);
  });

  it("passes an AbortSignal to fetch; a fetch that never answers times out", async () => {
    const fake = fakeFetch([
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ]);
    const error = await refusal(safeDownload(GOOD_URL, options(fake, { timeoutMs: 20 })));
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
    expect(fake.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a body that stalls mid-stream times out too", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      pull() {
        return new Promise(() => {});
      },
    });
    const fake = fakeFetch([() => new Response(stalled, { status: 200, headers: { "content-type": "video/mp4" } })]);
    const error = await refusal(safeDownload(GOOD_URL, options(fake, { timeoutMs: 30 })));
    expect(error.code).toBe("timeout");
  });
});

describe("f. content type", () => {
  it("accepts video/* (with parameters)", async () => {
    const fake = fakeFetch([video(new Uint8Array([9]), { "content-type": "Video/MP4; codecs=avc1" })]);
    const result = await safeDownload(GOOD_URL, options(fake));
    expect(Array.from(result.bytes)).toEqual([9]);
    expect(result.contentType).toBe("video/mp4");
  });

  it("refuses anything else (html, json, octet-stream, missing)", async () => {
    for (const type of ["text/html", "application/json", "application/octet-stream", ""]) {
      const fake = fakeFetch([
        () => new Response(new Uint8Array([1]), { status: 200, headers: type ? { "content-type": type } : {} }),
      ]);
      const error = await refusal(safeDownload(GOOD_URL, options(fake)));
      expect(error.code, type).toBe("not_video");
    }
  });
});

// ---------------------------------------------------------------------------
// p4-fix b (QA SF2): the socket connects only to the address that was checked.
// A FAKE https.request stands in for node:https: it does what net does on
// connect (calls options.lookup) and records the address it would connect
// to. No socket is ever opened.
// ---------------------------------------------------------------------------

type FakeAnswer = { status: number; headers?: Record<string, string>; body?: number[] };

function fakeHttps(answers: FakeAnswer[]) {
  const connectedTo: string[] = [];
  const seen: https.RequestOptions[] = [];
  const request = ((options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    seen.push(options);
    const req = Object.assign(new EventEmitter(), {
      destroy: () => req,
      end: () => {
        options.lookup?.(String(options.hostname), { all: false }, (err, address) => {
          if (err) return void req.emit("error", err);
          connectedTo.push(String(address));
          const answer = answers.shift();
          if (!answer) return void req.emit("error", new Error("no more fake answers"));
          const res = Object.assign(Readable.from(answer.body ? [Buffer.from(answer.body)] : []), {
            statusCode: answer.status,
            rawHeaders: Object.entries(answer.headers ?? {}).flat(),
          });
          callback(res as unknown as http.IncomingMessage);
        });
      },
    });
    return req;
  }) as unknown as typeof https.request;
  return { request, connectedTo, seen };
}

const mp4Answer = (body = [1, 2, 3]): FakeAnswer => ({ status: 200, headers: { "content-type": "video/mp4" }, body });
const PRIVATE_IPS = ["169.254.169.254", "10.0.0.5"];

function pinnedOptions(fake: ReturnType<typeof fakeHttps>, resolve: SafeDownloadOptions["resolve"]): SafeDownloadOptions {
  return { transport: createHttpsTransport(fake.request), resolve, allowedHosts: [HOST], maxBytes: 1_000, maxRedirects: 3, timeoutMs: 5_000 };
}

describe("g. pinned IP (DNS rebinding, p4-fix b)", () => {
  it("rebinding: public on the check, private at connect time -> refused (private_address), nothing connects to the private IP", async () => {
    for (const privateIp of PRIVATE_IPS) {
      const resolve = vi
        .fn<SafeDownloadOptions["resolve"]>()
        .mockResolvedValueOnce(PUBLIC_IP)
        .mockResolvedValueOnce([{ address: privateIp, family: 4 }]);
      const fake = fakeHttps([mp4Answer()]);
      const error = await refusal(safeDownload(GOOD_URL, pinnedOptions(fake, resolve)));
      expect(error.code, privateIp).toBe("private_address");
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(fake.connectedTo).toEqual([]);
    }
  });

  it("the socket gets exactly the validated address; TLS still checks the hostname; no pooled agent; no API key", async () => {
    const resolve = vi.fn(async () => PUBLIC_IP);
    const fake = fakeHttps([mp4Answer([7, 8])]);
    const result = await safeDownload(GOOD_URL, pinnedOptions(fake, resolve));
    expect(Array.from(result.bytes)).toEqual([7, 8]);
    expect(fake.connectedTo).toEqual(["93.184.216.34"]);
    expect(fake.seen[0]).toMatchObject({ hostname: HOST, servername: HOST, port: 443, path: "/videos/abc/VIDEO.mp4?sig=1", agent: false, method: "GET" });
    expect(JSON.stringify(fake.seen[0].headers)).not.toMatch(/api-key/i);
  });

  it("createPinnedLookup hands back the checked address (single and all:true forms)", async () => {
    const lookup = createPinnedLookup(vi.fn(async () => [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]));
    const single = await new Promise<unknown[]>((resolve) => lookup(HOST, { all: false }, (...args: unknown[]) => resolve(args)));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    const all = await new Promise<unknown[]>((resolve) => lookup(HOST, { all: true }, (...args: unknown[]) => resolve(args)));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]]);
  });

  it("a mixed answer (public + private) at connect time is refused; nothing connects", async () => {
    const lookup = createPinnedLookup(vi.fn(async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]));
    const [err] = await new Promise<unknown[]>((resolve) => lookup(HOST, { all: false }, (...args: unknown[]) => resolve(args)));
    expect(err).toBeInstanceOf(SafeDownloadError);
    expect((err as SafeDownloadError).code).toBe("private_address");

    const resolve = vi
      .fn<SafeDownloadOptions["resolve"]>()
      .mockResolvedValueOnce(PUBLIC_IP)
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    const fake = fakeHttps([mp4Answer()]);
    const error = await refusal(safeDownload(GOOD_URL, pinnedOptions(fake, resolve)));
    expect(error.code).toBe("private_address");
    expect(fake.connectedTo).toEqual([]);
  });

  it("each redirect hop is pinned again (a hop that rebinds is refused)", async () => {
    const resolve = vi
      .fn<SafeDownloadOptions["resolve"]>()
      .mockResolvedValueOnce(PUBLIC_IP) // hop 0 check
      .mockResolvedValueOnce(PUBLIC_IP) // hop 0 connect
      .mockResolvedValueOnce(PUBLIC_IP) // hop 1 check
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]); // hop 1 connect
    const fake = fakeHttps([{ status: 302, headers: { location: `https://${HOST}/videos/next.mp4` } }, mp4Answer()]);
    const error = await refusal(safeDownload(GOOD_URL, pinnedOptions(fake, resolve)));
    expect(error.code).toBe("private_address");
    expect(fake.connectedTo).toEqual(["93.184.216.34"]);
  });

  it("the DEFAULT transport is node:https with the pinned lookup (not fetch)", async () => {
    const fake = fakeHttps([mp4Answer([5])]);
    const spy = vi.spyOn(https, "request").mockImplementation(fake.request as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await safeDownload(GOOD_URL, { resolve: vi.fn(async () => PUBLIC_IP), allowedHosts: [HOST], maxBytes: 1_000, maxRedirects: 3, timeoutMs: 5_000 });
    expect(Array.from(result.bytes)).toEqual([5]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fake.connectedTo).toEqual(["93.184.216.34"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("h. a refused host is logged (host and code only, never the URL)", () => {
  it("logs `[safe-download] refused host=<host> code=<code>`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await refusal(safeDownload("https://evil.example.com/x/y.mp4?sig=secret", options(fakeFetch([]))));
    const resolve = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    await refusal(safeDownload(GOOD_URL, options(fakeFetch([]), { resolve })));
    const lines = warn.mock.calls.map((args) => args.join(" "));
    expect(lines).toEqual([
      "[safe-download] refused host=evil.example.com code=not_allowed",
      `[safe-download] refused host=${HOST} code=private_address`,
    ]);
    expect(lines.join("\n")).not.toMatch(/sig=|\/videos|y\.mp4|https:/);
  });
});

describe("HTTP errors", () => {
  it("a 5xx is retryable, a 4xx is not; messages are plain (no URL)", async () => {
    const five = await refusal(safeDownload(GOOD_URL, options(fakeFetch([() => new Response("x", { status: 503 })]))));
    expect(five).toMatchObject({ code: "http_error", retryable: true });
    const four = await refusal(safeDownload(GOOD_URL, options(fakeFetch([() => new Response("x", { status: 403 })]))));
    expect(four).toMatchObject({ code: "http_error", retryable: false });
    expect(five.message + four.message).not.toContain(HOST);
  });
});
