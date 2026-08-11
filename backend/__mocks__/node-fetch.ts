// Jest manual mock for 'node-fetch', wired via moduleNameMapper in jest.config.js.
//
// ENG-1111. `node-fetch` is a separate implementation from Node's native `fetch` --
// wrapping `globalThis.fetch` in setup.ts (see src/__tests__/networkEgressGuard.ts) does
// not cover code that explicitly `require('node-fetch')`s (controllers/tasks.ts,
// services/emailService.ts's HTML-report fetch). This mock applies the identical
// local-or-allowlisted policy at that boundary, sharing the same allowlist so the two
// callers can't drift apart. Delegates to the real node-fetch once the URL clears the
// guard, so in-process/local calls behave exactly as before.
import { assertLocalOrAllowed } from '../src/__tests__/networkEgressGuard';

const realNodeFetch = jest.requireActual('node-fetch');
const realFetchFn: (url: unknown, init?: unknown) => unknown =
  typeof realNodeFetch === 'function' ? realNodeFetch : realNodeFetch.default;

function resolveUrl(url: unknown): string {
  if (typeof url === 'string') return url;
  if (url && typeof url === 'object' && 'href' in url) return String((url as { href: unknown }).href);
  return String(url);
}

function guardedFetch(url: unknown, init?: unknown) {
  assertLocalOrAllowed(resolveUrl(url));
  return realFetchFn(url, init);
}

module.exports = Object.assign(guardedFetch, realNodeFetch, { default: guardedFetch });
