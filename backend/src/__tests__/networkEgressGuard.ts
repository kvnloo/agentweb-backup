/**
 * ENG-1111 — outbound network egress guard for the backend jest suite.
 *
 * Before this existed, nothing in the test harness stopped a test from reaching a
 * third-party production API. Two incidents proved the cost:
 *
 *   - ENG-960: `seo.orgAnalytics.test.ts` POSTed to Google's *production* API on every
 *     run and got a live 401 back. The suite was green, the test's duration was set by
 *     an internet round trip, and the handler's success path had never once been
 *     exercised because the 401 short-circuited it. Green suite, untested code.
 *   - ENG-1112: a suite POSTed to `api.resend.com` — our real transactional-email
 *     provider — with a real key resolved from Secrets Manager. It looked green only
 *     because that particular key was rejected; a valid key would have sent real mail.
 *
 * Both are the same bug class: a test that silently depends on the internet is not
 * testing what it claims to test, and its result is set by a third party's uptime,
 * rate limits, and credential state rather than by our code.
 *
 * This guard closes the hole at the transport. Loopback stays fully open so supertest,
 * in-process fakes, and DynamoDB Local are unaffected.
 */

import type { ClientRequest, RequestOptions } from 'http';

export type NetworkGuardMode = 'enforce' | 'report' | 'off';

/**
 * A blocked (or, in report mode, observed) outbound request.
 */
export interface EgressViolation {
  /** Hostname only, e.g. `docs.agentweb.pro`. */
  host: string;
  /** Full URL as the caller wrote it, minus any query string (may carry secrets). */
  url: string;
  /** Transport the call came through. */
  transport: 'fetch' | 'http' | 'https';
  /**
   * Name of the test that was running, or `null` when the request was issued at
   * module-load time (an import side effect) rather than by a test body.
   */
  testName: string | null;
  /** Absolute path of the test file whose run issued the request. */
  testPath: string | null;
  /**
   * Stack at the point of the call, recorded only when `NETWORK_GUARD_REPORT` is set.
   *
   * This is not redundant with `testPath`. Some leaks are async operations started by
   * one suite that settle while a *different* suite is running, so they are attributed
   * to an innocent file — three Gemini offenders in the ENG-1111 inventory were exactly
   * this, and none of them reproduced when their apparent owner was run alone. The
   * stack names the module that actually made the call.
   */
  stack?: string;
}

const LOOPBACK_IPV4_PREFIX = '127.';
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '::1',
  '[::1]',
  '0.0.0.0',
  '::',
]);

/**
 * Loopback only. Deliberately narrow: a private-range or `.local` allowance would let
 * a test reach a real box on a developer's LAN or in CI's VPC, which is the same class
 * of hidden dependency this guard exists to remove.
 */
export function isLocalHostname(hostname: string): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTNAMES.has(host) || LOCAL_HOSTNAMES.has(hostname.toLowerCase())) {
    return true;
  }
  if (host.startsWith(LOOPBACK_IPV4_PREFIX)) return true;
  // `foo.localhost` resolves to loopback per RFC 6761.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return false;
}

/**
 * Hosts a test may still reach, with the reason it is not yet stubbed.
 *
 * This must stay empty or near-empty. An entry here is a hole in the guard, not a
 * configuration knob: the fix for an offending suite is a real stub, never a new line
 * in this list. Anything added must name the suite and why a stub is not possible.
 */
export const EGRESS_ALLOWLIST: ReadonlyArray<{ host: string; reason: string }> = [];

function isAllowlisted(hostname: string): boolean {
  return EGRESS_ALLOWLIST.some((entry) => entry.host === hostname.toLowerCase());
}

export class NetworkEgressBlockedError extends Error {
  readonly violation: EgressViolation;

  constructor(violation: EgressViolation) {
    const where = violation.testName
      ? `test: ${violation.testName}`
      : 'issued at module-load time (an import side effect), not by a test body';
    super(
      `ENG-1111 network egress guard blocked an outbound ${violation.transport} request.\n` +
        `  url:  ${violation.url}\n` +
        `  host: ${violation.host}\n` +
        `  ${where}\n` +
        (violation.testPath ? `  file: ${violation.testPath}\n` : '') +
        `\nBackend tests must not reach a non-loopback host. Stub the transport or mock the\n` +
        `module that owns this call in the test file. Do NOT add the host to EGRESS_ALLOWLIST\n` +
        `in src/__tests__/networkEgressGuard.ts — that weakens the guard for every suite.`
    );
    this.name = 'NetworkEgressBlockedError';
    this.violation = violation;
  }
}

export function resolveMode(env: NodeJS.ProcessEnv = process.env): NetworkGuardMode {
  const raw = (env.NETWORK_GUARD_MODE || '').toLowerCase();
  if (raw === 'report' || raw === 'off' || raw === 'enforce') return raw;
  return 'enforce';
}

/**
 * Strip the query string — auth tokens and API keys routinely live there, and this
 * message ends up in CI logs.
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?<redacted>`;
}

function currentTestName(): string | null {
  try {
    // `expect` is global under jest and carries the running test's state.
    const state = (globalThis as any).expect?.getState?.();
    return state?.currentTestName ?? null;
  } catch {
    return null;
  }
}

function currentTestPath(): string | null {
  try {
    const state = (globalThis as any).expect?.getState?.();
    return state?.testPath ?? null;
  } catch {
    return null;
  }
}

function recordViolation(violation: EgressViolation): void {
  const reportFile = process.env.NETWORK_GUARD_REPORT;
  if (reportFile) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      fs.appendFileSync(
        reportFile,
        `${JSON.stringify({ ...violation, stack: new Error().stack })}\n`
      );
    } catch {
      /* reporting is best-effort and must never change a test's result */
    }
  }
}

/**
 * Turn whatever a caller handed `fetch` into a URL string. `fetch` accepts a string,
 * a `URL`, or a `Request`.
 */
export function extractFetchUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const asRequest = input as { url?: unknown };
  if (asRequest && typeof asRequest.url === 'string') return asRequest.url;
  return String(input);
}

/**
 * Reconstruct the target URL for a `http.request` / `https.request` call, which may be
 * given a URL string, a `URL`, or an options object — in any of several arities.
 */
export function extractNodeRequestUrl(
  args: unknown[],
  defaultProtocol: 'http:' | 'https:'
): { url: string; host: string } | null {
  let host: string | undefined;
  let protocol = defaultProtocol;
  let path = '';
  let port = '';

  for (const arg of args) {
    if (typeof arg === 'string') {
      try {
        const parsed = new URL(arg);
        return { url: parsed.toString(), host: parsed.hostname };
      } catch {
        continue;
      }
    }
    if (arg instanceof URL) {
      return { url: arg.toString(), host: arg.hostname };
    }
    if (arg && typeof arg === 'object' && !(arg instanceof Function)) {
      const options = arg as RequestOptions & { href?: string };
      if (typeof options.href === 'string') {
        try {
          const parsed = new URL(options.href);
          return { url: parsed.toString(), host: parsed.hostname };
        } catch {
          /* fall through to piecewise reconstruction */
        }
      }
      if (options.hostname || options.host) {
        host = String(options.hostname || options.host).replace(/:\d+$/, '');
        if (options.protocol) protocol = options.protocol as 'http:' | 'https:';
        if (options.port) port = `:${options.port}`;
        if (options.path) path = String(options.path);
      }
    }
  }

  if (!host) return null;
  return { url: `${protocol}//${host}${port}${path}`, host };
}

type FetchLike = typeof globalThis.fetch;

interface InstalledGuard {
  uninstall: () => void;
  mode: NetworkGuardMode;
}

let installed: InstalledGuard | null = null;

/**
 * Install the guard over `globalThis.fetch` and the node `http`/`https` request
 * entrypoints. Idempotent.
 */
export function installNetworkEgressGuard(
  mode: NetworkGuardMode = resolveMode()
): InstalledGuard {
  if (installed) return installed;

  if (mode === 'off') {
    installed = { uninstall: () => { installed = null; }, mode };
    return installed;
  }

  const check = (
    host: string,
    url: string,
    transport: EgressViolation['transport']
  ): NetworkEgressBlockedError | null => {
    if (isLocalHostname(host) || isAllowlisted(host)) return null;

    const violation: EgressViolation = {
      host: host.toLowerCase(),
      url: redactUrl(url),
      transport,
      testName: currentTestName(),
      testPath: currentTestPath(),
    };
    recordViolation(violation);

    if (mode === 'report') {
      // Report mode is for taking inventory only. It must never be the shipped default:
      // a guard that reports and lets the call through is not a guard.
      console.error(
        `[network-egress-guard][report-only] ${transport} -> ${violation.url} ` +
          `(${violation.testName ?? 'module load'})`
      );
      return null;
    }
    return new NetworkEgressBlockedError(violation);
  };

  const originalFetch = globalThis.fetch;
  const guardedFetch = (async (input: any, init?: any) => {
    const url = extractFetchUrl(input);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      // A relative or unparseable URL cannot leave the box on its own.
      return originalFetch(input, init);
    }
    const blocked = check(host, url, 'fetch');
    if (blocked) throw blocked;
    return originalFetch(input, init);
  }) as FetchLike;
  // Keep `fetch.preconnect` etc. that undici attaches, so feature detection still works.
  Object.assign(guardedFetch, originalFetch);
  globalThis.fetch = guardedFetch;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https');

  const originals: Array<{ mod: any; key: string; fn: any }> = [];
  const wrapNodeRequest = (
    mod: any,
    key: 'request' | 'get',
    protocol: 'http:' | 'https:'
  ) => {
    const original = mod[key];
    originals.push({ mod, key, fn: original });
    mod[key] = function guarded(...args: unknown[]): ClientRequest {
      const target = extractNodeRequestUrl(args, protocol);
      if (target) {
        const blocked = check(target.host, target.url, protocol === 'https:' ? 'https' : 'http');
        if (blocked) throw blocked;
      }
      return original.apply(this, args as never);
    };
  };
  wrapNodeRequest(http, 'request', 'http:');
  wrapNodeRequest(http, 'get', 'http:');
  wrapNodeRequest(https, 'request', 'https:');
  wrapNodeRequest(https, 'get', 'https:');

  installed = {
    mode,
    uninstall: () => {
      globalThis.fetch = originalFetch;
      for (const { mod, key, fn } of originals) mod[key] = fn;
      installed = null;
    },
  };
  return installed;
}
