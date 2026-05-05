import { fetchAndExtract, fetchTopPages } from '../services/webContentFetcher';
import * as dnsMod from 'dns';

const originalFetch = global.fetch;
const originalLookup = dnsMod.promises.lookup;

// By default, pretend every hostname resolves to a public IP so existing tests
// don't hit real DNS. SSRF tests that need a private-IP resolution override
// this within their own `it(...)` block.
beforeEach(() => {
  (dnsMod.promises as any).lookup = jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterAll(() => {
  (dnsMod.promises as any).lookup = originalLookup;
});

function mockHtmlResponse(html: string): any {
  // Simulate streaming body with a single chunk
  const encoder = new TextEncoder();
  const chunk = encoder.encode(html);
  let read = false;
  return {
    ok: true,
    headers: { get: (k: string) => k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
    body: {
      getReader: () => ({
        read: async () => {
          if (read) return { done: true, value: undefined };
          read = true;
          return { done: false, value: chunk };
        },
      }),
    },
  };
}

describe('fetchAndExtract', () => {
  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('extracts title and main text from a basic HTML page', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue(mockHtmlResponse(
      `<html><head><title>Acme Corp</title></head>
       <body><nav>Home</nav><main><h1>Acme</h1><p>Acme is a Series B SaaS startup with 200 employees.</p></main><footer>Contact</footer></body></html>`
    ));

    const r = await fetchAndExtract('https://acme.com/about');
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Acme Corp');
    expect(r!.text).toContain('Series B SaaS startup');
    // Nav and footer should be stripped
    expect(r!.text).not.toContain('Contact');
  });

  it('returns null for known-skip domains (linkedin, login walls)', async () => {
    (global as any).fetch = jest.fn();
    expect(await fetchAndExtract('https://linkedin.com/in/whoever')).toBeNull();
    expect(await fetchAndExtract('https://login.microsoftonline.com/foo')).toBeNull();
    expect((global as any).fetch).not.toHaveBeenCalled();  // never invoked
  });

  it('returns null for non-HTML content', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    });
    expect(await fetchAndExtract('https://api.example.com/data.json')).toBeNull();
  });

  it('returns null when HTTP response is not ok', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      headers: { get: () => 'text/html' },
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    });
    expect(await fetchAndExtract('https://acme.com/missing')).toBeNull();
  });

  it('returns null when fetch throws (network error / timeout)', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('network'));
    expect(await fetchAndExtract('https://acme.com/x')).toBeNull();
  });

  it('caps body bytes when a hostile server sends one oversized chunk', async () => {
    // Single chunk much larger than the 1MB body cap. The reader must slice
    // it to fit and stop reading rather than allocating the full payload.
    const oversized = new Uint8Array(5_000_000);
    // Fill with valid UTF-8 'a' bytes so the decode succeeds
    oversized.fill(97);
    let read = false;
    const cancel = jest.fn().mockResolvedValue(undefined);
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: (k: string) => k.toLowerCase() === 'content-type' ? 'text/html' : null },
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: oversized };
          },
          cancel,
        }),
      },
    });

    const r = await fetchAndExtract('https://acme.com/huge');
    // No <main> wrapping — the extracted text falls back to <body>, then is
    // capped at 4000 chars by the existing output cap. The point of this test
    // is that the decode/extract didn't OOM on a 5MB chunk.
    expect(r).not.toBeNull();
    expect(r!.text.length).toBeLessThanOrEqual(4001);
    expect(cancel).toHaveBeenCalled();
  });

  it('caps output at 4000 chars', async () => {
    const longText = 'lorem ipsum '.repeat(1000);
    (global as any).fetch = jest.fn().mockResolvedValue(mockHtmlResponse(
      `<html><body><main>${longText}</main></body></html>`
    ));
    const r = await fetchAndExtract('https://acme.com/long');
    expect(r).not.toBeNull();
    expect(r!.text.length).toBeLessThanOrEqual(4001); // 4000 + ellipsis
  });

  it('skips PDFs and images by URL extension', async () => {
    (global as any).fetch = jest.fn();
    expect(await fetchAndExtract('https://acme.com/whitepaper.pdf')).toBeNull();
    expect(await fetchAndExtract('https://acme.com/logo.png')).toBeNull();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  describe('SSRF defense', () => {
    it('rejects non-http(s) schemes', async () => {
      (global as any).fetch = jest.fn();
      expect(await fetchAndExtract('file:///etc/passwd')).toBeNull();
      expect(await fetchAndExtract('ftp://internal/secret')).toBeNull();
      expect(await fetchAndExtract('gopher://x/_path')).toBeNull();
      expect((global as any).fetch).not.toHaveBeenCalled();
    });

    it('rejects literal private / reserved IP hosts', async () => {
      (global as any).fetch = jest.fn();
      // AWS instance metadata, loopback, RFC1918 ranges
      expect(await fetchAndExtract('http://169.254.169.254/latest/meta-data/')).toBeNull();
      expect(await fetchAndExtract('http://127.0.0.1:8080/admin')).toBeNull();
      expect(await fetchAndExtract('http://10.0.0.5/internal')).toBeNull();
      expect(await fetchAndExtract('http://192.168.1.1/router')).toBeNull();
      expect(await fetchAndExtract('http://172.16.0.1/internal')).toBeNull();
      expect(await fetchAndExtract('http://[::1]/loopback')).toBeNull();
      expect((global as any).fetch).not.toHaveBeenCalled();
    });

    it('rejects hostnames that resolve to private IPs (DNS rebinding)', async () => {
      (dnsMod.promises as any).lookup = jest.fn().mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      (global as any).fetch = jest.fn();
      expect(await fetchAndExtract('https://evil.example.com/page')).toBeNull();
      expect((global as any).fetch).not.toHaveBeenCalled();
    });
  });
});

describe('fetchTopPages', () => {
  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('returns only successful pages, capped at topN', async () => {
    let call = 0;
    (global as any).fetch = jest.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(mockHtmlResponse('<html><body><main>page 1 content</main></body></html>'));
      if (call === 2) return Promise.reject(new Error('fail'));
      return Promise.resolve(mockHtmlResponse('<html><body><main>page 3 content</main></body></html>'));
    });

    const pages = await fetchTopPages(
      ['https://a.com', 'https://b.com', 'https://c.com'],
      2  // topN
    );
    // call 3 (https://c.com) is past topN, only first 2 are tried; one succeeds
    expect(pages.length).toBe(1);
    expect(pages[0].text).toContain('page 1');
  });
});
