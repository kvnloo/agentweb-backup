/**
 * ENG-2425: load-from-url endpoints must not fetch private/loopback/link-local
 * targets, and must re-validate every redirect hop.
 */
import { fetchPublicHtml, SsrfBlockedError } from '../utils/ssrfGuard';

describe('fetchPublicHtml (ENG-2425)', () => {
  it.each(['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://localhost/'])(
    'rejects %s without any outbound request',
    async (url) => {
      const req = jest.fn();
      await expect(fetchPublicHtml(url, { request: req })).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(req).not.toHaveBeenCalled();
    },
  );

  it('rejects a public host that redirects to a private IP', async () => {
    const req = jest.fn().mockResolvedValueOnce({ status: 302, headers: { location: 'http://169.254.169.254/' }, data: Buffer.alloc(0) });
    const resolvePinned = jest.fn(async (u: string) => {
      if (u.includes('169.254')) throw new SsrfBlockedError();
      return { hostname: 'example.com', address: '93.184.216.34', family: 4 };
    });
    await expect(fetchPublicHtml('https://example.com/', { request: req, resolvePinned })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(req).toHaveBeenCalledTimes(1);
  });

  it('returns the body of a public URL', async () => {
    const req = jest.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from('<title>Hi</title><body>x</body>') });
    const resolvePinned = jest.fn(async () => ({ hostname: 'example.com', address: '93.184.216.34', family: 4 }));
    await expect(fetchPublicHtml('https://example.com/', { request: req, resolvePinned })).resolves.toContain('<title>Hi</title>');
  });

  it('enforces the byte cap', async () => {
    const req = jest.fn().mockResolvedValue({ status: 200, headers: {}, data: Buffer.alloc(11) });
    const resolvePinned = jest.fn(async () => ({ hostname: 'example.com', address: '93.184.216.34', family: 4 }));
    await expect(fetchPublicHtml('https://example.com/', { request: req, resolvePinned }, 15000, 10)).rejects.toThrow(/too large/);
  });
});
