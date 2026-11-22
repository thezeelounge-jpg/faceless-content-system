import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

// Decides whether a test file may use the real network. Only the opt-in
// staging tests may, and only when Rowan sets RUN_STAGING_TESTS=1 on purpose.
// Everything else (all of `npm test`) gets the thrower.

const STAGING_DIR = path.resolve("tests/staging") + path.sep;

export function networkAllowed(opts: { env: Record<string, string | undefined>; testPath: string | undefined }): boolean {
  if (opts.env.RUN_STAGING_TESTS !== "1" || !opts.testPath) return false;
  return path.resolve(opts.testPath).startsWith(STAGING_DIR);
}

/**
 * `npm run eval:scripts` loads this guard too, unless BOTH live switches are
 * on: MOCK_CLAUDE exactly "false" (the app's own switch) AND an explicit
 * EVAL_ALLOW_NETWORK=1. One switch alone keeps the guard on.
 */
export function evalNetworkAllowed(env: Record<string, string | undefined>): boolean {
  return env.MOCK_CLAUDE === "false" && env.EVAL_ALLOW_NETWORK === "1";
}

export const NETWORK_DISABLED = "network disabled in tests";

/** The fetch every test gets: it never touches the network. */
export const disabledFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`${NETWORK_DISABLED}: ${url}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Socket guard (SF1). Every network client in Node ends in
// net.Socket.prototype.connect: node:http, node:https, net, tls, and undici
// (Node's own fetch and the undici package, which share net/tls). Patching
// that one method blocks them all; the module functions below are wrapped as
// well so the error names the host straight away. PGlite runs in-process and
// opens no socket, so it keeps working. A local server can still LISTEN (the
// guard tests do); nothing can CONNECT, not even to 127.0.0.1.
//
// The patch is installed once per process and switched on/off by a flag, so
// the opt-in staging run (networkAllowed) can turn it off for its own files.

type AnyFn = (...args: unknown[]) => unknown;

type GuardState = {
  patched: boolean;
  blocked: boolean;
  realFetch: typeof fetch;
};

const STATE_KEY = Symbol.for("fcs.tests.networkGuard");

/** One state per process (kept on globalThis so a second setup load reuses it and the real fetch). */
function state(): GuardState {
  const store = globalThis as Record<symbol, GuardState | undefined>;
  store[STATE_KEY] ??= { patched: false, blocked: true, realFetch: globalThis.fetch };
  return store[STATE_KEY];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** "host:port" (or a path) for the error message, from any connect/request arguments. */
export function describeTarget(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first === "string" || first instanceof URL) {
    if (typeof first === "string" && !first.includes("://")) return first; // a unix socket path
    try {
      const url = new URL(first);
      return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    } catch {
      return String(first);
    }
  }
  if (typeof first === "number") return `${text(second) ?? "localhost"}:${first}`;
  if (Array.isArray(first)) return describeTarget(first); // net internals pass [options, cb]
  if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    const p = text(o.path);
    const host = text(o.hostname) ?? text(o.host);
    const port = text(o.port);
    if (!host && p && !port) return p;
    return port ? `${host ?? "localhost"}:${port}` : (host ?? "localhost");
  }
  return "unknown host";
}

function blockedCall(real: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    if (state().blocked) throw new Error(`${NETWORK_DISABLED}: ${describeTarget(args)}`);
    return real.apply(this, args);
  };
}

/** Patches sockets once per process. Starts BLOCKED. */
export function installSocketGuard(): void {
  const guard = state();
  if (guard.patched) return;
  guard.patched = true;

  const proto = net.Socket.prototype as unknown as Record<string, AnyFn>;
  proto.connect = blockedCall(proto.connect);

  const patch = (mod: object, names: string[]) => {
    const target = mod as Record<string, AnyFn>;
    for (const name of names) target[name] = blockedCall(target[name]);
  };
  patch(net, ["connect", "createConnection"]);
  patch(tls, ["connect"]);
  patch(http, ["request", "get"]);
  patch(https, ["request", "get"]);
  installDnsGuard();
  // Make `import { request } from "node:http"` see the patched functions too.
  syncBuiltinESMExports();
}

// ---------------------------------------------------------------------------
// DNS guard (p4-fix a). DNS does not go through net.Socket (c-ares and
// getaddrinfo), so node:dns is patched on its shared module objects:
//   - `dns` (callback API): lookup, lookupService, resolve, resolve4/6/Any/…,
//     reverse. With a callback the error is handed to it on the next tick
//     (like a real failure); without one it throws.
//   - `dns.promises` (the SAME object as `node:dns/promises` and the named
//     `promises` export): the same names reject.
//   - `dns.Resolver` and `dns.promises.Resolver` prototypes (and their base
//     classes): the same names, for every instance.
// Every name starting with lookup / resolve / reverse is patched, so a new
// resolve* added by Node is covered too. setServers / getServers stay real.
// Only exception: `lookup` of a literal IP (no query is sent).

const DNS_CALL = /^(lookup|resolve|reverse)/;

function dnsTarget(name: string, args: unknown[]): string {
  if (name === "lookupService") return `${text(args[0]) ?? "unknown host"}:${text(args[1]) ?? ""}`;
  return text(args[0]) ?? "unknown host";
}

function blockedDnsCall(real: AnyFn, name: string, style: "callback" | "promise"): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    if (!state().blocked) return real.apply(this, args);
    // `lookup` of a literal IP sends no query (Node answers it itself), and a
    // local stub server needs it to LISTEN on 127.0.0.1. Names never pass.
    if (name === "lookup" && typeof args[0] === "string" && net.isIP(args[0])) return real.apply(this, args);
    const error = new Error(`${NETWORK_DISABLED}: ${dnsTarget(name, args)}`);
    if (style === "promise") return Promise.reject(error);
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      process.nextTick(callback as AnyFn, error);
      return undefined;
    }
    throw error;
  };
}

function patchDnsObject(target: object, style: "callback" | "promise", done: Set<object>): void {
  // Walk the prototype chain (Resolver methods may sit on a base class).
  for (let obj: object | null = target; obj && obj !== Object.prototype && !done.has(obj); obj = Object.getPrototypeOf(obj)) {
    done.add(obj);
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (!DNS_CALL.test(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (!desc || typeof desc.value !== "function" || !desc.writable) continue;
      (obj as Record<string, AnyFn>)[name] = blockedDnsCall(desc.value as AnyFn, name, style);
    }
  }
}

function installDnsGuard(): void {
  const done = new Set<object>();
  patchDnsObject(dns, "callback", done);
  patchDnsObject(dns.Resolver.prototype, "callback", done);
  patchDnsObject(dns.promises, "promise", done);
  patchDnsObject(dns.promises.Resolver.prototype, "promise", done);
}

/** Switches the socket guard on (true) or off (false, staging opt-in only). */
export function setNetworkBlocked(blocked: boolean): void {
  state().blocked = blocked;
}

/** Node's real fetch (undici), saved before any test replaced it. Staging opt-in and the guard tests only. */
export function realFetchForGuardTests(): typeof fetch {
  return state().realFetch;
}
