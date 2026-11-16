import {
  buildListUnsubscribeHeaders,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../dripListUnsubscribe';

const SECRET = 'test-secret';
const P = { orgId: 'org-1', contactId: 'c-1', sequenceId: 'seq-1' };

describe('unsubscribe token (ENG-2553)', () => {
  it('round-trips and is URL-safe', () => {
    const t = signUnsubscribeToken(P, SECRET);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribeToken(t, SECRET)).toEqual(P);
  });

  it('round-trips without sequenceId', () => {
    const t = signUnsubscribeToken({ orgId: 'o', contactId: 'c' }, SECRET);
    expect(verifyUnsubscribeToken(t, SECRET)).toEqual({ orgId: 'o', contactId: 'c' });
  });

  it('rejects a wrong secret', () => {
    expect(verifyUnsubscribeToken(signUnsubscribeToken(P, SECRET), 'other')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const [, sig] = signUnsubscribeToken(P, SECRET).split('.');
    const forged = Buffer.from(JSON.stringify({ orgId: 'org-2', contactId: 'c-1' })).toString('base64url');
    expect(verifyUnsubscribeToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it.each(['', 'abc', 'a.b.c', 'a b.c', '..'])('rejects malformed token %p', (t) => {
    expect(verifyUnsubscribeToken(t, SECRET)).toBeNull();
  });

  it('fails closed on empty secret', () => {
    expect(() => signUnsubscribeToken(P, '')).toThrow();
    expect(verifyUnsubscribeToken(signUnsubscribeToken(P, SECRET), '')).toBeNull();
  });

  it('requires orgId and contactId', () => {
    expect(() => signUnsubscribeToken({ orgId: '', contactId: 'c' }, SECRET)).toThrow();
    expect(() => signUnsubscribeToken({ orgId: 'o', contactId: ' ' }, SECRET)).toThrow();
  });
});

describe('buildListUnsubscribeHeaders (ENG-2553)', () => {
  const token = signUnsubscribeToken(P, SECRET);

  it('builds RFC 8058 one-click headers', () => {
    const h = buildListUnsubscribeHeaders({ baseUrl: 'https://api.agentweb.pro/unsubscribe', token });
    expect(h['List-Unsubscribe']).toBe(`<https://api.agentweb.pro/unsubscribe?t=${token}>`);
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('ENG-2557 encodes reserved chars in the mailto local part', () => {
    const h = buildListUnsubscribeHeaders({ baseUrl: 'https://x.io/u', token, mailto: 'unsub?team@example.com' });
    expect(h['List-Unsubscribe']).toBe(`<https://x.io/u?t=${token}>, <mailto:unsub%3Fteam@example.com?subject=unsubscribe>`);
  });

  it('appends optional mailto', () => {
    const h = buildListUnsubscribeHeaders({ baseUrl: 'https://x.io/u', token, mailto: 'unsub@x.io' });
    expect(h['List-Unsubscribe']).toBe(`<https://x.io/u?t=${token}>, <mailto:unsub@x.io?subject=unsubscribe>`);
  });

  it('rejects non-https and malformed base URLs', () => {
    expect(() => buildListUnsubscribeHeaders({ baseUrl: 'http://x.io/u', token })).toThrow();
    expect(() => buildListUnsubscribeHeaders({ baseUrl: 'not a url', token })).toThrow();
  });

  it('rejects CR/LF injection', () => {
    expect(() => buildListUnsubscribeHeaders({ baseUrl: 'https://x.io/u\r\nBcc: a@b.c', token })).toThrow();
    expect(() => buildListUnsubscribeHeaders({ baseUrl: 'https://x.io/u', token, mailto: 'a@b.c\r\nX: y' })).toThrow();
    expect(() => buildListUnsubscribeHeaders({ baseUrl: 'https://x.io/u', token: 'a\r\nb' })).toThrow();
  });

  it('header values never contain CR/LF', () => {
    const h = buildListUnsubscribeHeaders({ baseUrl: 'https://x.io/u', token, mailto: 'u@x.io' });
    Object.values(h).forEach((v) => expect(v).not.toMatch(/[\r\n]/));
  });
});
