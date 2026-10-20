import { composeOneOffEmail, type OneOffEmailInput } from '../dripOneOffEmail';
import { verifyUnsubscribeToken } from '../dripListUnsubscribe';
import { buildSuppressionList } from '../dripSuppressionList';

const SECRET = 'test-secret';

function base(over: Partial<OneOffEmailInput> = {}): OneOffEmailInput {
  return {
    orgId: 'org-1',
    contactId: 'c-1',
    to: ' Lead@Example.com ',
    fromAddress: 'no-reply@usehaven.ai',
    fromName: 'Haven',
    replyTo: 'team@usehaven.ai',
    allowedDomains: ['usehaven.ai'],
    subject: '  Hello  ',
    html: '<p>Hi</p>',
    suppression: buildSuppressionList(['blocked@example.org', '@spam.test']),
    unsubscribe: { secret: SECRET, baseUrl: 'https://app.agentweb.pro/u' },
    ...over,
  };
}

describe('composeOneOffEmail (ENG-2558)', () => {
  it('builds a Resend payload with identity, normalized recipient and unsubscribe headers', () => {
    const r = composeOneOffEmail(base({ text: 'Hi' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      from: '"Haven" <no-reply@usehaven.ai>',
      to: ['lead@example.com'],
      reply_to: 'team@usehaven.ai',
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
    expect(r.payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const m = /[?&]t=([^>&]+)>/.exec(r.payload.headers['List-Unsubscribe']);
    expect(m).not.toBeNull();
    expect(verifyUnsubscribeToken(decodeURIComponent(m![1]), SECRET)).toEqual({
      orgId: 'org-1',
      contactId: 'c-1',
    });
  });

  it('omits reply_to and blank text when absent', () => {
    const r = composeOneOffEmail(base({ replyTo: undefined, text: '  ' }));
    expect(r.ok && r.payload.reply_to).toBe(undefined);
    expect(r.ok && 'text' in r.payload).toBe(false);
  });

  it('refuses suppressed recipients (exact and domain)', () => {
    expect(composeOneOffEmail(base({ to: 'BLOCKED@example.org' }))).toEqual({
      ok: false,
      error: 'suppressed',
      reason: 'exact',
    });
    expect(composeOneOffEmail(base({ to: 'x@spam.test' }))).toEqual({
      ok: false,
      error: 'suppressed',
      reason: 'domain',
    });
  });

  it('refuses invalid recipients', () => {
    expect(composeOneOffEmail(base({ to: 'nope' }))).toEqual({ ok: false, error: 'invalid_recipient' });
    expect(composeOneOffEmail(base({ to: 42 }))).toEqual({ ok: false, error: 'invalid_recipient' });
  });

  it('propagates sender identity errors', () => {
    expect(composeOneOffEmail(base({ fromAddress: 'a@other.com' }))).toEqual({
      ok: false,
      error: 'from_domain_not_allowed',
    });
    expect(composeOneOffEmail(base({ fromName: 'x\r\nBcc: a@b.c' }))).toEqual({
      ok: false,
      error: 'header_injection',
    });
  });

  it('validates subject and body', () => {
    expect(composeOneOffEmail(base({ subject: '  ' }))).toEqual({ ok: false, error: 'invalid_subject' });
    expect(composeOneOffEmail(base({ subject: 'a\nBcc: x' }))).toEqual({ ok: false, error: 'invalid_subject' });
    expect(composeOneOffEmail(base({ subject: undefined }))).toEqual({ ok: false, error: 'invalid_subject' });
    expect(composeOneOffEmail(base({ html: ' ' }))).toEqual({ ok: false, error: 'empty_body' });
  });

  it('fails closed on bad unsubscribe config without throwing', () => {
    expect(composeOneOffEmail(base({ unsubscribe: { secret: '', baseUrl: 'https://a.b/u' } }))).toEqual({
      ok: false,
      error: 'invalid_unsubscribe_config',
    });
    expect(
      composeOneOffEmail(base({ unsubscribe: { secret: SECRET, baseUrl: 'http://a.b/u' } })),
    ).toEqual({ ok: false, error: 'invalid_unsubscribe_config' });
    expect(composeOneOffEmail(base({ contactId: '' }))).toEqual({
      ok: false,
      error: 'invalid_unsubscribe_config',
    });
  });
});
