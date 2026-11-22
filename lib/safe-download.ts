import "server-only";
import { promises as dnsPromises } from "node:dns";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { PlainError } from "@/lib/plain-error";

// A careful downloader for files whose link comes from outside (QA MUST FIX 1:
// the HeyGen video link arrives in a webhook body or an API answer, so it must
// never make our server fetch an internal address). Rules, in order, on EVERY
// hop (the first link and each redirect):
//   1. https only, no user:password@, no port other than 443, no literal IP.
//   2. The host is on the allowlist: exact host, or an explicit ".suffix"
//      entry that matches only on a dot boundary. No substring tricks.
//   3. DNS: every address the host resolves to must be public. Private,
//      loopback, link-local, CGNAT, ULA, unspecified, multicast, IPv4-mapped
//      versions of those and cloud metadata addresses are refused.
//   4. One GET, redirects NOT followed (we follow them ourselves); at most
//      `maxRedirects` hops.
//   5. The IP is pinned (p4-fix b, DNS rebinding): the default transport is
//      node:https whose socket `lookup` is createPinnedLookup. At connect
//      time it resolves the host once, refuses if ANY address is blocked and
//      hands the socket only the addresses it just checked, so the socket
//      cannot reach an address that was not validated. TLS servername stays
//      the hostname (the certificate is checked against the host).
//      `agent: false`: a fresh socket per hop. No extra package needed.
// Then: a 2xx answer with a video/* content type, a byte cap checked on
// Content-Length AND while streaming, and one timeout for the whole download.
// Errors are plain and never contain the URL. A host refusal logs one line:
// `[safe-download] refused host=<host> code=<code>` (never the path or query).

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Node's socket `lookup` option (same shape as dns.lookup). */
export type PinnedLookup = NonNullable<https.RequestOptions["lookup"]>;

export type TransportInit = {
  method: "GET";
  redirect: "manual";
  signal: AbortSignal;
  headers: Record<string, string>;
  /** The socket must connect only to the address this hands back. */
  lookup: PinnedLookup;
};
/** One request, no redirects followed. fetch-shaped so tests can pass a fake. */
export type Transport = (url: string, init: TransportInit) => Promise<Response>;

export type SafeDownloadOptions = {
  /** Default: node:https with the pinned lookup (createHttpsTransport). Tests pass a fake. */
  transport?: Transport;
  /** Tests pass a fake. Default: node:dns lookup with all addresses. */
  resolve: Resolver;
  /** Exact hosts, or ".suffix" entries (dot boundary). */
  allowedHosts: readonly string[];
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
};

export type SafeDownloadCode =
  | "bad_url"
  | "not_allowed"
  | "private_address"
  | "too_many_redirects"
  | "too_big"
  | "not_video"
  | "timeout"
  | "http_error"
  | "network";

export class SafeDownloadError extends PlainError {
  constructor(
    readonly code: SafeDownloadCode,
    message: string,
    /** True when trying again later may work (timeout, network, 5xx). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SafeDownloadError";
  }
}

/** The real resolver (never used by tests: they inject a fake). */
export const systemResolver: Resolver = (hostname) => dnsPromises.lookup(hostname, { all: true, verbatim: true });

const refuse = (code: SafeDownloadCode, message: string, retryable = false) => new SafeDownloadError(code, message, retryable);
const BAD_URL = () => refuse("bad_url", "The video link is not a safe https link. Nothing was downloaded.");
const NOT_ALLOWED = () => refuse("not_allowed", "The video link points to a host we do not download from. Nothing was downloaded.");
const PRIVATE = () => refuse("private_address", "The video link points to a private or internal address. Nothing was downloaded.");

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

function ipv4Blocked([a, b, c]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 (unspecified, "this network")
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT (incl. 100.100.100.200 metadata)
    (a === 169 && b === 254) || // 169.254/16 link-local (incl. 169.254.169.254 metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** 8 groups of 16 bits, or null. Handles "::" and a trailing dotted IPv4. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4Parts(dotted[2]);
    if (!v4) return null;
    text = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (s: string) => (s ? s.split(":") : []);
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

const embeddedV4 = (g: number[], at: number) => [g[at] >> 8, g[at] & 0xff, g[at + 1] >> 8, g[at + 1] & 0xff];

/**
 * True when we must NOT connect to this address. Fails closed: anything that
 * is not a clearly public IPv4 or global-unicast IPv6 address is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) return ipv4Blocked(v4);
  const g = ipv6Groups(address);
  if (!g) return true;
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64): judge the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipv4Blocked(embeddedV4(g, 6));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Blocked(embeddedV4(g, 6));
  // 6to4 (2002::/16) carries an IPv4 in bits 16-48.
  if (g[0] === 0x2002) return ipv4Blocked(embeddedV4(g, 1));
  // Only global unicast 2000::/3 is public. This blocks ::, ::1, fe80::/10,
  // fc00::/7 (incl. fd00:ec2::254 metadata), ff00::/8 and the rest.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation range
  return false;
}

// ---------------------------------------------------------------------------
// Hosts and URLs
// ---------------------------------------------------------------------------

const normaliseHost = (host: string) => host.toLowerCase().replace(/\.$/, "");

/** Exact host match, or a ".suffix" entry on a dot boundary. */
export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = normaliseHost(hostname);
  if (!host) return false;
  return allowed.some((entry) => {
    const rule = normaliseHost(entry);
    if (rule.startsWith(".")) return host.endsWith(rule) && host.length > rule.length;
    return host === rule;
  });
}

/** Rules 1 and 2 (no network). Returns the parsed URL. */
function checkUrl(raw: string, allowed: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw BAD_URL();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw BAD_URL();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) throw PRIVATE();
  if (!hostAllowed(host, allowed)) throw NOT_ALLOWED();
  return url;
}

/** Rule 3: every resolved address must be public. */
async function checkDns(url: URL, resolve: Resolver): Promise<void> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    throw refuse("network", "Could not look up the video host. It will be tried again.", true);
  }
  if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) throw PRIVATE();
}

/**
 * The IP pin (p4-fix b, DNS rebinding). Given to node:https as the socket's
 * `lookup`, so it runs at connect time on every hop: it resolves the host
 * ONCE, refuses if ANY address is blocked, and hands the socket only the
 * addresses it just checked. The socket cannot connect anywhere else, even if
 * the host answers differently a moment later.
 */
export function createPinnedLookup(resolve: Resolver): PinnedLookup {
  const lookup = (hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    const all = typeof options === "object" && options !== null && options.all === true;
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) return callback(PRIVATE());
        const checked = addresses.map((a) => ({ address: a.address, family: a.family }));
        if (all) callback(null, checked);
        else callback(null, checked[0].address, checked[0].family);
      },
      () => callback(refuse("network", "Could not look up the video host. It will be tried again.", true)),
    );
  };
  return lookup as unknown as PinnedLookup;
}

const NO_BODY = new Set([204, 205, 304]);

/**
 * The default transport: one node:https GET (no redirects followed) whose
 * socket uses the pinned lookup. TLS `servername` is the hostname, so the
 * certificate is still checked against the host, not the IP. `agent: false`
 * means a fresh socket every hop (no pooled socket from another lookup).
 * `request` is injectable so tests never open a socket.
 */
export type HttpsRequest = (
  options: https.RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ReturnType<typeof https.request>;

export function createHttpsTransport(request: HttpsRequest = (options, callback) => https.request(options, callback)): Transport {
  return (raw, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(raw);
      let req: ReturnType<typeof https.request>;
      try {
        req = request(
          {
            protocol: "https:",
            hostname: url.hostname,
            port: 443,
            path: `${url.pathname}${url.search}`,
            method: init.method,
            headers: init.headers,
            lookup: init.lookup,
            servername: url.hostname,
            agent: false,
            signal: init.signal,
          },
          (res) => {
            try {
              const status = res.statusCode ?? 0;
              if (status < 200 || status > 599) throw new Error("unexpected status");
              const headers = new Headers();
              const rawHeaders = res.rawHeaders ?? [];
              for (let i = 0; i + 1 < rawHeaders.length; i += 2) headers.append(rawHeaders[i], rawHeaders[i + 1]);
              const body = NO_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
              if (!body) res.resume();
              resolve(new Response(body, { status, headers }));
            } catch (error) {
              res.destroy();
              reject(error);
            }
          },
        );
      } catch (error) {
        reject(error);
        return;
      }
      req.on("error", reject);
      req.end();
    });
}

/** One server log line for a refused download: host and code only, never the URL, path or query. */
function logRefusal(raw: string, error: SafeDownloadError): void {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    host = "unparseable";
  }
  const safeHost = host.replace(/[^a-zA-Z0-9.\-:[\]]/g, "?").slice(0, 253) || "none";
  console.warn(`[safe-download] refused host=${safeHost} code=${error.code}`);
}

// ---------------------------------------------------------------------------
// The download
// ---------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function timeoutError(): SafeDownloadError {
  return refuse("timeout", "The video download took too long. It will be tried again.", true);
}

/** Reads one chunk, or throws a timeout as soon as the signal fires. */
function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = () => reject(timeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? timeoutError() : refuse("network", "The video download broke off. It will be tried again.", true));
        void e;
      },
    );
  });
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw refuse("too_big", "The video file is larger than we accept. Nothing was saved.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => null);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The media type without parameters, lower case ("video/mp4"). */
function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

export async function safeDownload(raw: string, opts: SafeDownloadOptions): Promise<{ bytes: Uint8Array; contentType: string }> {
  // The link being checked right now (first link, then each redirect), so a
  // refusal logs the host that was actually refused.
  const current = { raw };
  try {
    return await downloadHops(raw, opts, current);
  } catch (error) {
    if (error instanceof SafeDownloadError && HOST_REFUSALS.has(error.code)) logRefusal(current.raw, error);
    throw error;
  }
}

const HOST_REFUSALS = new Set<SafeDownloadCode>(["bad_url", "not_allowed", "private_address"]);

async function downloadHops(
  raw: string,
  opts: SafeDownloadOptions,
  current: { raw: string },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const transport = opts.transport ?? createHttpsTransport();
  let url = checkUrl(raw, opts.allowedHosts);
  for (let hop = 0; ; hop++) {
    await checkDns(url, opts.resolve);
    let response: Response;
    try {
      response = await transport(url.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { Accept: "video/*" },
        lookup: createPinnedLookup(opts.resolve),
      });
    } catch (error) {
      if (error instanceof SafeDownloadError) throw error;
      if (signal.aborted) throw timeoutError();
      throw refuse("network", "Could not reach the video host. It will be tried again.", true);
    }

    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => null);
      if (hop >= opts.maxRedirects) throw refuse("too_many_redirects", "The video link redirected too many times. Nothing was saved.");
      const location = response.headers.get("location");
      if (!location) throw BAD_URL();
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        throw BAD_URL();
      }
      current.raw = next;
      url = checkUrl(next, opts.allowedHosts);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => null);
      const retryable = response.status >= 500 || response.status === 429;
      throw refuse("http_error", `The video host answered ${response.status}.${retryable ? " It will be tried again." : ""}`, retryable);
    }
    const contentType = mediaType(response.headers.get("content-type"));
    if (!contentType.startsWith("video/")) {
      await response.body?.cancel().catch(() => null);
      throw refuse("not_video", "The video link did not return a video file. Nothing was saved.");
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > opts.maxBytes) {
      await response.body?.cancel().catch(() => null);
      throw refuse("too_big", "The video file is larger than we accept. Nothing was saved.");
    }
    return { bytes: await readCapped(response, opts.maxBytes, signal), contentType };
  }
}
