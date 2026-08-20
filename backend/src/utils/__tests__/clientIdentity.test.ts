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

import {
  resolveClientIdentity,
  isServerSideUserAgent,
  isPublicIpAddress,
  resolveClientIdentityWithForwarded,
} from '../clientIdentity';

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

/**
 * ENG-926 §B — landing-page leads had NO client identity at all, and that is the gap this
 * closes.
 *
 * The guard above is correct and stays: a value resolved from the REQUEST is the forwarder's,
 * not the visitor's, so it is dropped. But dropping it left lander leads storing neither
 * `client_ip_address` nor `client_user_agent` — both named explicitly in the card's §B as
 * signals that "materially improve Event Match Quality".
 *
 * The visitor's real IP and user agent are known in exactly one place: the site's own Next.js
 * capture route, which the browser DOES post to directly. So the forwarder must declare them,
 * and this is the narrow, guarded path that accepts a declaration.
 *
 * ⚠ WHY THIS IS NOT SIMPLY "TRUST THE BODY". `forward-lead` is public, CORS-open and
 * unauthenticated. A declaration is therefore accepted ONLY when:
 *
 *   1. the CALLER is already recognised as a forwarding server — a real browser can never
 *      override its own identity, or any visitor could launder an arbitrary IP through us;
 *   2. the DECLARED user agent is itself a browser — if a forwarder declares `node`, it is
 *      describing itself, which is the original bug wearing a different hat;
 *   3. the DECLARED IP is a syntactically valid PUBLIC address — a private, loopback,
 *      link-local or CGNAT address cannot be a visitor's public IP and matches nobody at Meta.
 *
 * Stated plainly rather than implied: this does NOT make the value trustworthy against a
 * determined attacker. Anyone can already POST an arbitrary lead to this route with a fake
 * email and fake attribution, so faking an IP alongside them is not a new capability. What the
 * validation buys is CORRECTNESS FOR REAL TRAFFIC — it stops a forwarder from mistakenly
 * declaring its own datacenter identity, which is the exact failure the guard above exists for.
 */

describe('isPublicIpAddress', () => {
  it('accepts ordinary public IPv4', () => {
    for (const ip of ['203.0.113.7', '45.253.245.23', '34.105.84.37', '8.8.8.8']) {
      expect(isPublicIpAddress(ip)).toBe(true);
    }
  });

  it('accepts ordinary public IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPublicIpAddress(ip)).toBe(true);
    }
  });

  it('rejects private, loopback, link-local and CGNAT IPv4', () => {
    // None of these can be a visitor's public address. Storing one is the same class of
    // error as storing the forwarder: a match signal that matches nobody.
    for (const ip of [
      '10.0.0.1', '10.255.255.254',
      '172.16.0.1', '172.31.0.31', '172.31.18.3',   // the two real ALB addresses from ENG-493
      '192.168.1.1',
      '127.0.0.1',                                   // what req.ip actually is today (ENG-493)
      '169.254.169.254',                             // link-local / cloud metadata
      '100.64.0.1',                                  // CGNAT
      '0.0.0.0', '255.255.255.255', '224.0.0.1',
    ]) {
      expect(isPublicIpAddress(ip)).toBe(false);
    }
  });

  it('rejects private, loopback and link-local IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
      expect(isPublicIpAddress(ip)).toBe(false);
    }
  });

  it('judges an IPv4-mapped IPv6 address by its embedded IPv4', () => {
    // ::ffff:127.0.0.1 is loopback wearing a v6 costume. Judging the string shape alone
    // would let it through as "a valid v6 address".
    expect(isPublicIpAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicIpAddress('::ffff:203.0.113.7')).toBe(true);
  });

  it('rejects anything that is not an address at all', () => {
    for (const v of ['', '   ', 'unknown', 'not-an-ip', '203.0.113', '203.0.113.7.8',
                     '999.0.0.1', '203.0.113.7:443', undefined, null, 12345, {}]) {
      expect(isPublicIpAddress(v as any)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace on an otherwise valid address', () => {
    expect(isPublicIpAddress('  203.0.113.7  ')).toBe(true);
  });
});

describe('resolveClientIdentityWithForwarded', () => {
  const BROWSER =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const VERCEL_EGRESS = '44.202.76.171';
  const VISITOR_IP = '45.253.245.23';

  it('accepts a declaration from a recognised forwarder — the case this exists for', () => {
    // The generated capture route runs on Vercel, reads the BROWSER's own x-forwarded-for
    // and user-agent, and declares them. This is the whole point of the change.
    expect(
      resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, {
        clientIp: VISITOR_IP,
        clientUserAgent: BROWSER,
      }),
    ).toEqual({ clientIp: VISITOR_IP, clientUserAgent: BROWSER });
  });

  it('IGNORES a declaration when a real browser posted directly', () => {
    // Otherwise any visitor could launder an arbitrary IP through a public endpoint by
    // declaring one. A direct caller's identity is observed, never self-reported.
    expect(
      resolveClientIdentityWithForwarded(BROWSER, VISITOR_IP, {
        clientIp: '203.0.113.99',
        clientUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/147.0.0.0 Safari/537.36',
      }),
    ).toEqual({ clientIp: VISITOR_IP, clientUserAgent: BROWSER });
  });

  it('rejects the whole declaration when the DECLARED agent is itself server-side', () => {
    // A forwarder declaring `node` is describing itself. Accepting the IP alongside it
    // would re-create the original bug through the new door.
    expect(
      resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, {
        clientIp: VISITOR_IP,
        clientUserAgent: 'node',
      }),
    ).toEqual({});
  });

  it('rejects the whole declaration when no agent is declared', () => {
    expect(
      resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, { clientIp: VISITOR_IP }),
    ).toEqual({});
    expect(
      resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, { clientIp: VISITOR_IP, clientUserAgent: '  ' }),
    ).toEqual({});
  });

  it('keeps a declared browser agent but DROPS a non-public declared IP', () => {
    // The agent is still true information about the visitor and is a real match signal.
    // The IP is not usable, so it is simply absent rather than wrong.
    const got = resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, {
      clientIp: '127.0.0.1',
      clientUserAgent: BROWSER,
    });
    expect(got).toEqual({ clientUserAgent: BROWSER });
  });

  it('never falls back to the forwarder\'s own IP when the declared one is rejected', () => {
    // The failure this whole module exists to prevent.
    const got = resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, {
      clientIp: 'not-an-ip',
      clientUserAgent: BROWSER,
    });
    expect(got.clientIp).toBeUndefined();
  });

  it('behaves exactly like resolveClientIdentity when nothing is declared', () => {
    expect(resolveClientIdentityWithForwarded('node', VERCEL_EGRESS)).toEqual({});
    expect(resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, {})).toEqual({});
    expect(resolveClientIdentityWithForwarded(BROWSER, VISITOR_IP)).toEqual({
      clientIp: VISITOR_IP,
      clientUserAgent: BROWSER,
    });
  });

  it('ignores non-string declared values rather than throwing', () => {
    // The body is attacker-controlled JSON; any type can arrive.
    expect(
      resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, {
        clientIp: { evil: true } as any,
        clientUserAgent: 12345 as any,
      }),
    ).toEqual({});
  });

  it('trims what it accepts from a declaration', () => {
    expect(
      resolveClientIdentityWithForwarded('node', VERCEL_EGRESS, {
        clientIp: `  ${VISITOR_IP}  `,
        clientUserAgent: `  ${BROWSER}  `,
      }),
    ).toEqual({ clientIp: VISITOR_IP, clientUserAgent: BROWSER });
  });
});
