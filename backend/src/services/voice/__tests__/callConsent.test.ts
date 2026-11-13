import { buildCallConsentNotice, buildCallConsentRecord, consentPhoneDigits, hasCallConsent, pageUrlOf, parseCallConsent } from '../callConsent';

const TEXT = buildCallConsentNotice('Acme Plumbing LLC');
const ok = (over: Record<string, unknown> = {}) => ({ granted: true, text: TEXT, version: 'v1', ...over });
// Exactly N characters containing "call" and "automated".
const textOf = (n: number) => `call automated ${'a'.repeat(n)}`.slice(0, n);

describe('parseCallConsent', () => {
  it('accepts the approved notice', () => {
    expect(parseCallConsent(ok())).toEqual({ ok: true, text: TEXT, version: 'v1' });
    expect(TEXT).toContain('pressing 3 on a call');
  });
  it('trims the text and allows no version', () => {
    expect(parseCallConsent({ granted: true, text: `  ${TEXT}  ` })).toEqual({ ok: true, text: TEXT });
  });
  it.each([
    ['absent', undefined, 'absent'], ['null', null, 'absent'], ['an unticked box (granted false)', ok({ granted: false }), 'unchecked'],
    ['a string', 'yes', 'not_object'], ['an array', [], 'not_object'],
    ['granted "true"', ok({ granted: 'true' }), 'not_granted'], ['granted 1', ok({ granted: 1 }), 'not_granted'],
    ['text not a string', ok({ text: 5 }), 'bad_text'], ['text 39 chars', ok({ text: textOf(39) }), 'text_too_short'],
    ['text 1001 chars', ok({ text: textOf(1001) }), 'text_too_long'],
    ['no call word', ok({ text: 'I agree to be contacted by automated systems about my enquiry.' }), 'text_no_call_word'],
    ['"recall" is not "call"', ok({ text: 'I agree to be contacted by automated systems and I recall nothing.' }), 'text_no_call_word'],
    ['no automated word', ok({ text: 'I agree that Acme may call me at the number above about my enquiry.' }), 'text_no_automated_word'],
    ['"unautomated" is not "automated"', ok({ text: 'I agree that Acme may call me at the number above, unautomated calls only.' }), 'text_no_automated_word'],
    ['placeholder name', ok({ text: buildCallConsentNotice('[REGISTERED BUSINESS NAME]') }), 'placeholder_name'],
    ['lower-case placeholder', ok({ text: buildCallConsentNotice('registered business name') }), 'placeholder_name'],
    ['spaced placeholder', ok({ text: buildCallConsentNotice('REGISTERED   BUSINESS\tNAME') }), 'placeholder_name'],
    ['any bracketed name placeholder', ok({ text: buildCallConsentNotice('[ Your Company Name ]') }), 'placeholder_name'],
    ['bad version', ok({ version: 'v 1!' }), 'bad_version'], ['long version', ok({ version: 'a'.repeat(33) }), 'bad_version'], ['numeric version', ok({ version: 1 }), 'bad_version'],
  ])('rejects %s', (_n, raw, reason) => {
    expect(parseCallConsent(raw)).toEqual({ ok: false, reason });
  });
  it('accepts text of exactly 40 and 1000 characters', () => {
    expect(parseCallConsent(ok({ text: textOf(40) })).ok).toBe(true);
    expect(parseCallConsent(ok({ text: textOf(1000) })).ok).toBe(true);
  });
});

describe('record and helpers', () => {
  it('stamps the server time and the phone digits, caps fields and omits absent ones', () => {
    const at = new Date('2026-11-13T10:00:00.000Z');
    expect(buildCallConsentRecord({ text: TEXT }, { phone: '(212) 555-0142', pageUrl: 'https://a.test/p', ip: '1.2.3.4', userAgent: 'u'.repeat(400) }, at)).toEqual({
      granted: true, text: TEXT, phoneDigits: '12125550142', capturedAt: at.toISOString(), pageUrl: 'https://a.test/p', ip: '1.2.3.4', userAgent: 'u'.repeat(300), source: 'form',
    });
    expect(Object.keys(buildCallConsentRecord({ text: TEXT }, { phone: '2125550142' }, at))).toEqual(['granted', 'text', 'phoneDigits', 'capturedAt', 'source']);
  });
  it('pageUrlOf keeps host and path only', () => {
    expect(pageUrlOf('https://user:pw@a.test:8080/lp/x?email=a@b.c&utm=1#frag')).toBe('https://a.test:8080/lp/x');
    expect(pageUrlOf('javascript:alert(1)')).toBeUndefined();
    expect(pageUrlOf('not a url')).toBeUndefined();
    expect(pageUrlOf(undefined)).toBeUndefined();
    expect(pageUrlOf(`https://a.test/${'p'.repeat(400)}`)).toHaveLength(300);
  });
  it('consentPhoneDigits normalises spellings of one number alike and gives "" for junk', () => {
    expect(consentPhoneDigits('(212) 555-0142')).toBe('12125550142');
    expect(consentPhoneDigits('+1 212 555 0142')).toBe('12125550142');
    expect(consentPhoneDigits('2125550142')).toBe('12125550142');
    expect(consentPhoneDigits('12345')).toBe('');
    expect(consentPhoneDigits(undefined)).toBe('');
  });
  it('hasCallConsent needs granted === true AND phoneDigits equal to the lead\'s own normalised phone', () => {
    const rec = { granted: true, phoneDigits: '12125550142' };
    expect(hasCallConsent({ phone: '(212) 555-0142', system: { callConsent: rec } })).toBe(true);
    expect(hasCallConsent({ phone: '+12125550142', system: { callConsent: rec } })).toBe(true);
    expect(hasCallConsent({ phone: '(212) 555-0199', system: { callConsent: rec } })).toBe(false); // phone changed
    expect(hasCallConsent({ system: { callConsent: rec } })).toBe(false); // lead without a phone
    expect(hasCallConsent({ phone: '  ', system: { callConsent: rec } })).toBe(false);
    expect(hasCallConsent({ phone: '(212) 555-0142', system: { callConsent: { granted: true } } })).toBe(false); // no phoneDigits
    expect(hasCallConsent({ phone: '(212) 555-0142', system: { callConsent: { granted: 'true', phoneDigits: '12125550142' } } })).toBe(false);
    expect(hasCallConsent({ phone: '(212) 555-0142', system: {} })).toBe(false);
    expect(hasCallConsent({ phone: '(212) 555-0142' })).toBe(false);
  });
});
