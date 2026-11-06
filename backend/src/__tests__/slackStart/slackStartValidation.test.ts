/**
 * ENG-2782 S1 — public intake input validation: work email only, and a public
 * company website that cannot be used to aim the brand-build scraper at our
 * own network (SSRF).
 */
import { normalizeWorkEmail, normalizeWebsite } from '../../services/slackStart/slackStartValidation';

const publicResolver = jest.fn(async () => undefined);

describe('normalizeWorkEmail', () => {
  it('accepts a work email and returns the lowercased address and company domain', () => {
    expect(normalizeWorkEmail('  Sam@Acme.CO ')).toEqual({ ok: true, email: 'sam@acme.co', domain: 'acme.co' });
  });

  it.each(['', 'nope', 'a@b', 'a @acme.co', 'x'.repeat(250) + '@acme.co', 42, null])('rejects malformed %p', (raw) => {
    expect(normalizeWorkEmail(raw)).toEqual({ ok: false, code: 'invalid_email' });
  });

  it.each(['sam@gmail.com', 'sam@outlook.com', 'sam@proton.me'])('rejects personal mailbox %s', (raw) => {
    expect(normalizeWorkEmail(raw)).toEqual({ ok: false, code: 'personal_email' });
  });
});

describe('normalizeWebsite', () => {
  beforeEach(() => publicResolver.mockClear());

  it('adds https:// to a bare domain and keeps only the origin', async () => {
    await expect(normalizeWebsite('acme.co/pricing?x=1', { assertPublic: publicResolver })).resolves.toEqual({
      ok: true,
      url: 'https://acme.co',
      host: 'acme.co',
    });
    expect(publicResolver).toHaveBeenCalledWith('https://acme.co');
  });

  it.each([
    'localhost',
    'http://127.0.0.1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://10.0.0.5',
    'ftp://acme.co',
    'javascript:alert(1)',
    'https://user:pass@acme.co',
    'https://acme.co:8443',
    'intranet',
    'https://metadata.google.internal',
    '',
    'a'.repeat(300) + '.com',
  ])('rejects non-public or malformed website %p without resolving it', async (raw) => {
    await expect(normalizeWebsite(raw, { assertPublic: publicResolver })).resolves.toEqual({ ok: false, code: 'invalid_website' });
  });

  it('rejects a hostname whose DNS answer is private (rebinding-style)', async () => {
    const privateResolver = jest.fn(async () => {
      throw new Error('URL resolves to a private/internal address');
    });
    await expect(normalizeWebsite('evil.example.com', { assertPublic: privateResolver })).resolves.toEqual({
      ok: false,
      code: 'invalid_website',
    });
  });
});
