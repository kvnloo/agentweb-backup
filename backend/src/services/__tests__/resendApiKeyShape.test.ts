import { maskResendApiKey, validateResendApiKey } from '../resendApiKeyShape';

const VALID = 're_AbCdEfGhIjKlMnOpQrSt_1234';

describe('validateResendApiKey (ENG-2560)', () => {
  it('accepts a well-formed key and trims surrounding whitespace', () => {
    expect(validateResendApiKey(`  ${VALID}\n`)).toEqual({ ok: true, key: VALID });
  });

  it('accepts boundary body lengths 20 and 100', () => {
    expect(validateResendApiKey(`re_${'a'.repeat(20)}`).ok).toBe(true);
    expect(validateResendApiKey(`re_${'a'.repeat(100)}`).ok).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    [undefined, 'empty'],
    [42, 'empty'],
    ['sk_AbCdEfGhIjKlMnOpQrSt', 'missing_prefix'],
    ['RE_AbCdEfGhIjKlMnOpQrSt', 'missing_prefix'],
    ['re_', 'bad_length'],
    [`re_${'a'.repeat(19)}`, 'bad_length'],
    [`re_${'a'.repeat(101)}`, 'bad_length'],
    ['re_AbCdEfGh IjKlMnOpQrSt', 'bad_characters'],
    ['re_AbCdEfGh-IjKlMnOpQrSt', 'bad_characters'],
  ])('rejects %p as %s', (raw, reason) => {
    expect(validateResendApiKey(raw)).toEqual({ ok: false, reason });
  });

  it('never echoes the raw input in a rejection', () => {
    const secret = 're_SECRETVALUE-should-not-leak-xyz';
    const out = validateResendApiKey(secret);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('SECRETVALUE');
  });
});

describe('maskResendApiKey (ENG-2560)', () => {
  it('shows only the last 4 chars of a valid key', () => {
    expect(maskResendApiKey(VALID)).toBe('re_\u20261234');
    expect(maskResendApiKey(VALID)).not.toContain('AbCd');
  });

  it.each(['', 're_short', 'not-a-key-at-all-but-long-enough', null])('falls back for %p', (raw) => {
    expect(maskResendApiKey(raw)).toBe('re_\u2026****');
  });
});
