import { buildCallConsentNotice, buildCallConsentRecord, CALL_CONSENT_NAME_PLACEHOLDER, hasCallConsent, pageUrlOf, parseCallConsent } from '../callConsent';

const TEXT = buildCallConsentNotice('Acme Plumbing LLC');
const ok = (over: Record<string, unknown> = {}) => ({ granted: true, text: TEXT, version: 'v1', ...over });

describe('parseCallConsent', () => {
  it('accepts the approved notice', () => {
    expect(parseCallConsent(ok())).toEqual({ ok: true, text: TEXT, version: 'v1' });
    expect(TEXT).toContain('pressing 3 on a call');
  });
  it('trims the text and allows no version', () => {
    expect(parseCallConsent({ granted: true, text: `  ${TEXT}  ` })).toEqual({ ok: true, text: TEXT });
  });
  it.each([
    ['absent', undefined, 'absent'], ['null', null, 'absent'], ['a string', 'yes', 'not_object'], ['an array', [], 'not_object'],
    ['granted "true"', ok({ granted: 'true' }), 'not_granted'], ['granted false', ok({ granted: false }), 'not_granted'], ['granted 1', ok({ granted: 1 }), 'not_granted'],
    ['text not a string', ok({ text: 5 }), 'bad_text'], ['text 39 chars', ok({ text: 'a call to me please, thanks a lot ok ok.'.slice(0, 39) }), 'text_too_short'],
    ['text 1001 chars', ok({ text: `call ${'a'.repeat(996)}` }), 'text_too_long'], ['no call word', ok({ text: 'I agree to be contacted by this business about my enquiry.' }), 'text_no_call_word'],
    ['"recall" is not "call"', ok({ text: 'I agree to be contacted and I recall nothing else about it at all.' }), 'text_no_call_word'],
    ['placeholder name', ok({ text: buildCallConsentNotice(CALL_CONSENT_NAME_PLACEHOLDER) }), 'placeholder_name'],
    ['bad version', ok({ version: 'v 1!' }), 'bad_version'], ['long version', ok({ version: 'a'.repeat(33) }), 'bad_version'], ['numeric version', ok({ version: 1 }), 'bad_version'],
  ])('rejects %s', (_n, raw, reason) => {
    expect(parseCallConsent(raw)).toEqual({ ok: false, reason });
  });
  it('accepts text of exactly 40 and 1000 characters', () => {
    expect(parseCallConsent(ok({ text: `call${'a'.repeat(36)}` })).ok).toBe(true);
    expect(parseCallConsent(ok({ text: `call${'a'.repeat(996)}` })).ok).toBe(true);
  });
});

describe('record and helpers', () => {
  it('stamps the server time, caps fields and omits absent ones', () => {
    const at = new Date('2026-11-13T10:00:00.000Z');
    expect(buildCallConsentRecord({ text: TEXT }, { pageUrl: 'https://a.test/p', ip: '1.2.3.4', userAgent: 'u'.repeat(400) }, at)).toEqual({
      granted: true, text: TEXT, capturedAt: at.toISOString(), pageUrl: 'https://a.test/p', ip: '1.2.3.4', userAgent: 'u'.repeat(300), source: 'form',
    });
    expect(Object.keys(buildCallConsentRecord({ text: TEXT }, {}, at))).toEqual(['granted', 'text', 'capturedAt', 'source']);
  });
  it('pageUrlOf keeps host and path only', () => {
    expect(pageUrlOf('https://user:pw@a.test:8080/lp/x?email=a@b.c&utm=1#frag')).toBe('https://a.test:8080/lp/x');
    expect(pageUrlOf('javascript:alert(1)')).toBeUndefined();
    expect(pageUrlOf('not a url')).toBeUndefined();
    expect(pageUrlOf(undefined)).toBeUndefined();
    expect(pageUrlOf(`https://a.test/${'p'.repeat(400)}`)).toHaveLength(300);
  });
  it('hasCallConsent needs granted === true', () => {
    expect(hasCallConsent({ system: { callConsent: { granted: true } } })).toBe(true);
    expect(hasCallConsent({ system: { callConsent: { granted: 'true' } } })).toBe(false);
    expect(hasCallConsent({ system: {} })).toBe(false);
    expect(hasCallConsent({})).toBe(false);
  });
});
