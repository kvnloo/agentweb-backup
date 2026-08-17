/**
 * ENG-926 §B follow-up — do not store the forwarding server as the visitor.
 *
 * Landing pages do NOT post to forward-lead from the browser. They post to their own
 * Next.js route, which then calls our API server-side from Vercel:
 *
 *   hireemma.ai        → app/(frontend)/api/lead/route.ts → buildForwardLeadBody() → forward-lead
 *   generated landers  → buildCaptureRoute's app/api/capture/route.ts → forward-lead
 *
 * Neither forwards the visitor's IP or user agent, so `x-forwarded-for` / `req.ip` resolve to
 * Vercel's egress. A real AC1 run through a real browser stored `clientIp: 44.202.76.171`
 * (AWS) and `clientUserAgent: node` — the forwarder, not the person.
 *
 * A wrong IP is WORSE than no IP: Meta treats client_ip_address as a match signal, and a
 * datacenter address cannot match anyone. Storing nothing is the honest answer — the same
 * third-state discipline §F applies to verdicts, applied here to a field.
 *
 * This also matters because §34 made these attributes WRITE-ONCE via if_not_exists. A lead
 * that stores the forwarder's IP can never have it replaced through updateLead, so every
 * lead captured before this guard is permanently wrong rather than merely stale.
 */

import { resolveClientIdentity, isServerSideUserAgent } from '../clientIdentity';

describe('isServerSideUserAgent', () => {
  it('recognises the agent actually observed in production', () => {
    expect(isServerSideUserAgent('node')).toBe(true);
  });

  it('recognises the common server-side HTTP clients', () => {
    for (const ua of [
      'node', 'Node.js', 'node-fetch/2.6.7', 'undici', 'axios/1.6.2', 'got (https://github.com/sindresorhus/got)',
      'python-requests/2.31.0', 'Go-http-client/1.1', 'curl/8.4.0', 'okhttp/4.9.0',
      'Java/17.0.1', 'PostmanRuntime/7.36.0', 'Next.js Middleware',
    ]) {
      expect(isServerSideUserAgent(ua)).toBe(true);
    }
  });

  it('does not flag real browser user agents', () => {
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36',
    ]) {
      expect(isServerSideUserAgent(ua)).toBe(false);
    }
  });

  it('is case insensitive and tolerates surrounding whitespace', () => {
    expect(isServerSideUserAgent('  NODE  ')).toBe(true);
    expect(isServerSideUserAgent('AXIOS/1.0')).toBe(true);
  });

  it('treats a missing or blank agent as server-side', () => {
    // Every real browser sends a User-Agent. Its absence on this route means the caller is
    // not a browser, so whatever IP arrived belongs to that caller and not to a visitor.
    expect(isServerSideUserAgent(undefined)).toBe(true);
    expect(isServerSideUserAgent('')).toBe(true);
    expect(isServerSideUserAgent('   ')).toBe(true);
    expect(isServerSideUserAgent(null as any)).toBe(true);
    expect(isServerSideUserAgent(12345 as any)).toBe(true);
  });

  it('does not flag a browser agent merely because it contains a substring like "java"', () => {
    // "Java/17" is server-side; a browser advertising JavaScript support is not. The guard
    // must not become a substring match that swallows real traffic.
    expect(isServerSideUserAgent('Mozilla/5.0 (compatible) JavaFX/8 Safari/537.36')).toBe(false);
  });
});

describe('resolveClientIdentity', () => {
  const BROWSER =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  it('keeps both when a real browser posted directly', () => {
    expect(resolveClientIdentity(BROWSER, '203.0.113.7')).toEqual({
      clientIp: '203.0.113.7',
      clientUserAgent: BROWSER,
    });
  });

  it('drops BOTH when the caller is a forwarding server — the observed production case', () => {
    // Vercel's egress + the Node fetch agent. Neither describes the visitor.
    expect(resolveClientIdentity('node', '44.202.76.171')).toEqual({});
  });

  it('drops the IP too, not just the agent', () => {
    // The IP is the actual match signal; dropping only the user agent would leave the
    // damaging half in place and look like the bug was fixed.
    const got = resolveClientIdentity('axios/1.6.2', '44.202.76.171');
    expect(got.clientIp).toBeUndefined();
    expect(got.clientUserAgent).toBeUndefined();
  });

  it('drops both when no user agent arrived at all', () => {
    expect(resolveClientIdentity(undefined, '44.202.76.171')).toEqual({});
  });

  it('returns a browser agent even when no IP could be resolved', () => {
    expect(resolveClientIdentity(BROWSER, undefined)).toEqual({ clientUserAgent: BROWSER });
    expect(resolveClientIdentity(BROWSER, '')).toEqual({ clientUserAgent: BROWSER });
  });

  it('never stores the "unknown" sentinel the CAPI call falls back to', () => {
    expect(resolveClientIdentity(BROWSER, 'unknown').clientIp).toBeUndefined();
  });

  it('trims what it keeps', () => {
    expect(resolveClientIdentity(`  ${BROWSER}  `, '  203.0.113.7  ')).toEqual({
      clientIp: '203.0.113.7',
      clientUserAgent: BROWSER,
    });
  });

  it('returns an empty object rather than undefined so callers can always spread it', () => {
    expect(resolveClientIdentity(undefined, undefined)).toEqual({});
  });
});
