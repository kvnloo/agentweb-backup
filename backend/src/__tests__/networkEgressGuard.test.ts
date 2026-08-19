/**
 * ENG-1111. Shared policy enforced at both the global `fetch` wrapper (setup.ts) and the
 * `node-fetch` module mock (__mocks__/node-fetch.ts) -- one list, so an allowlist entry
 * can't drift between the two call sites.
 */
import {
  assertLocalOrAllowed,
  RealNetworkEgressError,
  ALLOWED_HOSTNAMES,
} from './networkEgressGuard';

describe('networkEgressGuard', () => {
  afterEach(() => {
    ALLOWED_HOSTNAMES.delete('test-allowlisted.example.com');
  });

  it('blocks a request to a real non-local host', () => {
    expect(() => assertLocalOrAllowed('https://api.googleapis.com/v3/foo')).toThrow(
      RealNetworkEgressError
    );
  });

  it('names the blocked URL in the thrown error', () => {
    expect(() => assertLocalOrAllowed('https://api.resend.com/emails')).toThrow(
      /https:\/\/api\.resend\.com\/emails/
    );
  });

  it('names the currently-running test in the thrown error', () => {
    expect(() => assertLocalOrAllowed('https://api.stripe.com/v1/charges')).toThrow(
      /names the currently-running test in the thrown error/
    );
  });

  it('does not hang or swallow the block -- it always throws synchronously, never resolves', () => {
    let threw = false;
    try {
      assertLocalOrAllowed('https://graph.facebook.com/v19.0/act_1/campaigns');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('allows localhost', () => {
    expect(() => assertLocalOrAllowed('http://localhost:3001/api/health')).not.toThrow();
  });

  it('allows 127.0.0.1', () => {
    expect(() => assertLocalOrAllowed('http://127.0.0.1:5432/')).not.toThrow();
  });

  it('allows an explicitly allowlisted hostname', () => {
    ALLOWED_HOSTNAMES.add('test-allowlisted.example.com');
    expect(() => assertLocalOrAllowed('https://test-allowlisted.example.com/ping')).not.toThrow();
  });

  it('allows a non-absolute URL (in-process transports never leave the process)', () => {
    expect(() => assertLocalOrAllowed('/api/tasks/123')).not.toThrow();
  });
});
