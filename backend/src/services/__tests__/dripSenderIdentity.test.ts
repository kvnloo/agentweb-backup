import { buildSenderIdentity, MAX_DISPLAY_NAME_LENGTH } from '../dripSenderIdentity';

describe('buildSenderIdentity (ENG-2555)', () => {
  it('returns a bare normalized address when no name is given', () => {
    expect(buildSenderIdentity({ fromAddress: '  No-Reply@UseHaven.ai ' })).toEqual({
      ok: true,
      from: 'no-reply@usehaven.ai',
    });
  });

  it('treats a whitespace-only name as absent', () => {
    expect(buildSenderIdentity({ fromAddress: 'a@usehaven.ai', fromName: '   ' })).toEqual({
      ok: true,
      from: 'a@usehaven.ai',
    });
  });

  it('quotes the display name and escapes quotes and backslashes', () => {
    const r = buildSenderIdentity({ fromAddress: 'a@usehaven.ai', fromName: 'Haven "Team" \\ Ops' });
    expect(r).toEqual({ ok: true, from: '"Haven \\"Team\\" \\\\ Ops" <a@usehaven.ai>' });
  });

  it('includes a normalized reply-to', () => {
    expect(
      buildSenderIdentity({ fromAddress: 'a@usehaven.ai', fromName: 'Haven', replyTo: ' Sales@UseHaven.ai ' }),
    ).toEqual({ ok: true, from: '"Haven" <a@usehaven.ai>', replyTo: 'sales@usehaven.ai' });
  });

  it.each([
    [{ fromAddress: 'a@usehaven.ai\r\nBcc: x@evil.com' }],
    [{ fromAddress: 'a@usehaven.ai', fromName: 'Haven\nBcc: x@evil.com' }],
    [{ fromAddress: 'a@usehaven.ai', replyTo: 'b@usehaven.ai\r' }],
    [{ fromAddress: 'a@usehaven.ai', fromName: 'Ha\0ven' }],
  ])('rejects header injection %#', (input) => {
    expect(buildSenderIdentity(input)).toEqual({ ok: false, error: 'header_injection' });
  });

  it.each([[''], ['not-an-email'], [null], [42], ['a@b@c.com']])('rejects invalid from %p', (fromAddress) => {
    expect(buildSenderIdentity({ fromAddress })).toEqual({ ok: false, error: 'invalid_from_address' });
  });

  it('rejects an invalid reply-to', () => {
    expect(buildSenderIdentity({ fromAddress: 'a@usehaven.ai', replyTo: 'nope' })).toEqual({
      ok: false,
      error: 'invalid_reply_to',
    });
  });

  it('ignores an empty reply-to', () => {
    expect(buildSenderIdentity({ fromAddress: 'a@usehaven.ai', replyTo: ' ' })).toEqual({
      ok: true,
      from: 'a@usehaven.ai',
    });
  });

  it('rejects display names over the limit and accepts exactly the limit', () => {
    const at = 'x'.repeat(MAX_DISPLAY_NAME_LENGTH);
    expect(buildSenderIdentity({ fromAddress: 'a@usehaven.ai', fromName: at }).ok).toBe(true);
    expect(buildSenderIdentity({ fromAddress: 'a@usehaven.ai', fromName: at + 'x' })).toEqual({
      ok: false,
      error: 'display_name_too_long',
    });
  });

  it('enforces allowedDomains case-insensitively', () => {
    expect(buildSenderIdentity({ fromAddress: 'a@usehaven.ai', allowedDomains: [' UseHaven.ai '] }).ok).toBe(true);
    expect(buildSenderIdentity({ fromAddress: 'a@agentweb.pro', allowedDomains: ['usehaven.ai'] })).toEqual({
      ok: false,
      error: 'from_domain_not_allowed',
    });
  });
});
