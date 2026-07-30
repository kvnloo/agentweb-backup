/**
 * Unit tests for the ENG-600 Meta test-account allowlist guardrail.
 * This restricts the two new audience/campaign-launch workflows to an
 * approved test account during development/verification — it is NOT wired
 * into any shared Meta service used by real customer accounts.
 */

import { assertMetaAccountAllowed } from '../services/metaTestAccountGuard';

describe('assertMetaAccountAllowed', () => {
  const ORIGINAL_ENV = process.env.META_TEST_ACCOUNT_ALLOWLIST;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
    else process.env.META_TEST_ACCOUNT_ALLOWLIST = ORIGINAL_ENV;
  });

  it('allows any account when the env var is unset (prod-safe default)', () => {
    delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
    expect(() => assertMetaAccountAllowed('922903076601160')).not.toThrow();
    expect(() => assertMetaAccountAllowed('some-other-account')).not.toThrow();
  });

  it('allows any account when the env var is an empty string', () => {
    process.env.META_TEST_ACCOUNT_ALLOWLIST = '';
    expect(() => assertMetaAccountAllowed('anything')).not.toThrow();
  });

  it('allows any account when the env var is only whitespace', () => {
    process.env.META_TEST_ACCOUNT_ALLOWLIST = '   ';
    expect(() => assertMetaAccountAllowed('anything')).not.toThrow();
  });

  it('allows an account explicitly in a single-entry allowlist', () => {
    process.env.META_TEST_ACCOUNT_ALLOWLIST = '922903076601160';
    expect(() => assertMetaAccountAllowed('922903076601160')).not.toThrow();
  });

  it('rejects an account not in a single-entry allowlist', () => {
    process.env.META_TEST_ACCOUNT_ALLOWLIST = '922903076601160';
    expect(() => assertMetaAccountAllowed('some-customer-account')).toThrow(
      /not in the ENG-600 verification allowlist/
    );
  });

  it('supports a multi-entry comma-separated allowlist with surrounding whitespace', () => {
    process.env.META_TEST_ACCOUNT_ALLOWLIST = ' 111 , 922903076601160 ,222 ';
    expect(() => assertMetaAccountAllowed('922903076601160')).not.toThrow();
    expect(() => assertMetaAccountAllowed('111')).not.toThrow();
    expect(() => assertMetaAccountAllowed('333')).toThrow();
  });

  it('error message includes the rejected account id', () => {
    process.env.META_TEST_ACCOUNT_ALLOWLIST = '922903076601160';
    expect(() => assertMetaAccountAllowed('bad-account')).toThrow(/bad-account/);
  });
});
