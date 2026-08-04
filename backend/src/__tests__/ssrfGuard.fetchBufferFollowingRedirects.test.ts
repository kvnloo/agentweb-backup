/**
 * ENG-834 follow-up: the SSRF guard added to describe_image's non-S3 image fetch
 * set `maxRedirects: 0`. That closes the redirect-bypass hole (an attacker-supplied
 * public URL 302'ing to 169.254.169.254 would otherwise defeat the address pinning)
 * but ALSO false-blocks every legitimate one-hop URL — e.g. a Google Drive
 * `uc?export=view` link, which 303s once to drive.usercontent.google.com and serves
 * a perfectly ordinary image. Prod session f91329f2 failed exactly this way.
 *
 * `fetchBufferFollowingRedirects` keeps BOTH properties, the same way
 * googleAdsTrackingPreflight.fetchHtmlFollowingRedirects already does for HTML:
 * follow hop-by-hop, re-running the pinned public-address check at EVERY hop, so a
 * redirect into private space is blocked at the hop that tries it.
 *
 * Deps are injected so the redirect/SSRF behaviour is unit-testable with no real
 * network and no real DNS.
 */

import {
  fetchBufferFollowingRedirects,
  SsrfBlockedError,
  type RedirectFetchDeps,
} from '../utils/ssrfGuard';

/** Build injectable deps from a scripted map of url -> response. */
function makeDeps(
  responses: Record<string, { status: number; headers?: Record<string, string>; data?: Buffer }>,
  blockedHosts: string[] = []
): { deps: RedirectFetchDeps; fetched: string[]; checked: string[] } {
  const fetched: string[] = [];
  const checked: string[] = [];
  const deps: RedirectFetchDeps = {
    resolvePinned: async (url: string) => {
      checked.push(url);
      const host = new URL(url).hostname;
      if (blockedHosts.includes(host)) {
        throw new SsrfBlockedError();
      }
      return { hostname: host, address: '93.184.216.34', family: 4 };
    },
    request: async (url: string) => {
      fetched.push(url);
      const res = responses[url];
      if (!res) throw new Error(`unscripted request to ${url}`);
      return { status: res.status, headers: res.headers ?? {}, data: res.data ?? Buffer.alloc(0) };
    },
  };
  return { deps, fetched, checked };
}

describe('fetchBufferFollowingRedirects', () => {
  const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  // ---- FAIL cases -------------------------------------------------------

  it('blocks a URL whose own host is private, without ever fetching it', async () => {
    const { deps, fetched } = makeDeps({}, ['169.254.169.254']);
    await expect(
      fetchBufferFollowingRedirects('http://169.254.169.254/latest/meta-data/', deps)
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetched).toEqual([]);
  });

  it('blocks a redirect that hops into private space (the bypass this exists to stop)', async () => {
    const start = 'https://evil.example.com/pic.png';
    const { deps, fetched, checked } = makeDeps(
      {
        [start]: { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
      },
      ['169.254.169.254']
    );
    await expect(fetchBufferFollowingRedirects(start, deps)).rejects.toBeInstanceOf(SsrfBlockedError);
    // The guard ran on the redirect target, and the private hop was never fetched.
    expect(checked).toContain('http://169.254.169.254/latest/meta-data/');
    expect(fetched).toEqual([start]);
  });

  it('refuses a redirect to a non-http(s) scheme', async () => {
    const start = 'https://example.com/pic.png';
    const { deps } = makeDeps({
      [start]: { status: 302, headers: { location: 'file:///etc/passwd' } },
    });
    await expect(fetchBufferFollowingRedirects(start, deps)).rejects.toThrow(/non-http/i);
  });

  it('throws when a redirect carries no Location header', async () => {
    const start = 'https://example.com/pic.png';
    const { deps } = makeDeps({ [start]: { status: 302, headers: {} } });
    await expect(fetchBufferFollowingRedirects(start, deps)).rejects.toThrow(/no Location/i);
  });

  it('gives up after too many redirects instead of looping forever', async () => {
    const a = 'https://example.com/a';
    const b = 'https://example.com/b';
    const { deps } = makeDeps({
      [a]: { status: 302, headers: { location: b } },
      [b]: { status: 302, headers: { location: a } },
    });
    await expect(fetchBufferFollowingRedirects(a, deps, 3)).rejects.toThrow(/too many redirects/i);
  });

  it('throws on a non-2xx/3xx status', async () => {
    const start = 'https://example.com/gone.png';
    const { deps } = makeDeps({ [start]: { status: 404 } });
    await expect(fetchBufferFollowingRedirects(start, deps)).rejects.toThrow(/404/);
  });

  // ---- SUCCESS cases ----------------------------------------------------

  it('returns the body for a direct 200 with no redirect', async () => {
    const start = 'https://example.com/pic.png';
    const { deps, checked } = makeDeps({
      [start]: { status: 200, headers: { 'content-type': 'image/png' }, data: IMG },
    });
    const out = await fetchBufferFollowingRedirects(start, deps);
    expect(out.buffer).toEqual(IMG);
    expect(out.contentType).toBe('image/png');
    expect(out.finalUrl).toBe(start);
    expect(checked).toEqual([start]);
  });

  it('follows the Google Drive 303 hop and returns the final image (the prod repro)', async () => {
    const start = 'https://drive.google.com/uc?export=view&id=ABC';
    const target = 'https://drive.usercontent.google.com/download?id=ABC&export=view';
    const { deps, checked } = makeDeps({
      [start]: { status: 303, headers: { location: target } },
      [target]: { status: 200, headers: { 'content-type': 'image/webp' }, data: IMG },
    });
    const out = await fetchBufferFollowingRedirects(start, deps);
    expect(out.buffer).toEqual(IMG);
    expect(out.contentType).toBe('image/webp');
    expect(out.finalUrl).toBe(target);
    // Re-validated at BOTH hops — that is what makes following redirects safe.
    expect(checked).toEqual([start, target]);
  });

  it('resolves a relative Location against the current URL', async () => {
    const start = 'https://example.com/a/pic.png';
    const target = 'https://example.com/b/real.png';
    const { deps } = makeDeps({
      [start]: { status: 301, headers: { location: '/b/real.png' } },
      [target]: { status: 200, headers: { 'content-type': 'image/png' }, data: IMG },
    });
    const out = await fetchBufferFollowingRedirects(start, deps);
    expect(out.finalUrl).toBe(target);
  });

  it('tolerates a capitalised Location header', async () => {
    const start = 'https://example.com/pic.png';
    const target = 'https://example.com/real.png';
    const { deps } = makeDeps({
      [start]: { status: 302, headers: { Location: target } },
      [target]: { status: 200, headers: { 'content-type': 'image/png' }, data: IMG },
    });
    const out = await fetchBufferFollowingRedirects(start, deps);
    expect(out.finalUrl).toBe(target);
  });

  it('returns an empty content-type rather than inventing one when the header is absent', async () => {
    const start = 'https://example.com/pic';
    const { deps } = makeDeps({ [start]: { status: 200, headers: {}, data: IMG } });
    const out = await fetchBufferFollowingRedirects(start, deps);
    // ENG-370: a fabricated media type would short-circuit sharp detection downstream.
    expect(out.contentType).toBe('');
  });
});

/**
 * The 30s timeout must bound the WHOLE fetch, not each hop. Applied per hop it
 * multiplies by the redirect limit (6 hops x 30s = 180s), and this download sits
 * OUTSIDE describe_image's 90s vision bound — so a slow redirect chain could stall
 * a tool call for minutes and eat the run's generation budget. That is exactly the
 * unbounded-media-call failure ENG-294 exists to prevent.
 */
describe('fetchBufferFollowingRedirects — total time budget', () => {
  const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  it('shares one budget across hops instead of restarting it each hop', async () => {
    const a = 'https://example.com/a';
    const b = 'https://example.com/b';
    const seen: number[] = [];
    const deps: RedirectFetchDeps = {
      resolvePinned: async () => ({ hostname: 'example.com', address: '93.184.216.34', family: 4 }),
      request: async (url: string, _pinned: any, timeoutMs: number) => {
        seen.push(timeoutMs);
        await new Promise((r) => setTimeout(r, 40));
        return url === a
          ? { status: 302, headers: { location: b }, data: Buffer.alloc(0) }
          : { status: 200, headers: { 'content-type': 'image/png' }, data: IMG };
      },
    };
    await fetchBufferFollowingRedirects(a, deps, 5, 400);
    expect(seen).toHaveLength(2);
    // Second hop must get the REMAINING budget, strictly less than the first.
    expect(seen[1]).toBeLessThan(seen[0]);
  });

  it('gives up once the budget is exhausted rather than starting another hop', async () => {
    const start = 'https://example.com/slow';
    const deps: RedirectFetchDeps = {
      resolvePinned: async () => ({ hostname: 'example.com', address: '93.184.216.34', family: 4 }),
      request: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { status: 302, headers: { location: start }, data: Buffer.alloc(0) };
      },
    };
    await expect(fetchBufferFollowingRedirects(start, deps, 5, 50)).rejects.toThrow(/timed out/i);
  });
});

/**
 * Greptile P1 (security): an agent-supplied image URL is untrusted, so a hostile
 * or merely huge origin could stream an unbounded body that we buffer whole and
 * then hand to sharp — excessive memory/CPU that can destabilise the backend.
 * The transport caps the response, and the loop refuses an oversized body (and
 * an oversized declared Content-Length) as a second line of defence in case a
 * transport ignores the cap.
 */
describe('fetchBufferFollowingRedirects — response size cap', () => {
  const CAP = 1024;
  const pinned = async () => ({ hostname: 'example.com', address: '93.184.216.34', family: 4 });

  it('passes the byte cap down to the transport so the body is never fully buffered', async () => {
    let seenCap: number | undefined;
    const deps: RedirectFetchDeps = {
      resolvePinned: pinned,
      request: async (_url: string, _pinned: any, _timeoutMs: number, maxBytes?: number) => {
        seenCap = maxBytes;
        return { status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.alloc(10) };
      },
    };
    await fetchBufferFollowingRedirects('https://example.com/big.png', deps, 5, 30000, CAP);
    expect(seenCap).toBe(CAP);
  });

  it('rejects a body larger than the cap', async () => {
    const deps: RedirectFetchDeps = {
      resolvePinned: pinned,
      request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.alloc(CAP + 1) }),
    };
    await expect(
      fetchBufferFollowingRedirects('https://example.com/big.png', deps, 5, 30000, CAP)
    ).rejects.toThrow(/too large/i);
  });

  it('rejects on a declared Content-Length over the cap', async () => {
    const deps: RedirectFetchDeps = {
      resolvePinned: pinned,
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(CAP * 100) },
        data: Buffer.alloc(4),
      }),
    };
    await expect(
      fetchBufferFollowingRedirects('https://example.com/big.png', deps, 5, 30000, CAP)
    ).rejects.toThrow(/too large/i);
  });

  it('accepts a body exactly at the cap', async () => {
    const deps: RedirectFetchDeps = {
      resolvePinned: pinned,
      request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.alloc(CAP) }),
    };
    const out = await fetchBufferFollowingRedirects('https://example.com/ok.png', deps, 5, 30000, CAP);
    expect(out.buffer.length).toBe(CAP);
  });
});
