/**
 * Regression test for ENG-300.
 *
 * bootstrapEmailProviders() used to set `bootstrapped = true` BEFORE awaiting the
 * dynamic import. A second concurrent caller saw the flag, returned immediately,
 * and then read an empty registry — throwing "No email provider registered".
 *
 * It is called on every send, so concurrent first-callers after a cold start hit it.
 */

import {
  bootstrapEmailProviders,
  getEmailProvider,
  EMAIL_PLATFORMS,
} from '../services/emailProviderService';

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));

describe('bootstrapEmailProviders — concurrency (ENG-300)', () => {
  it('gives every concurrent first-caller a populated registry', async () => {
    // All five race the very first bootstrap. Under the old boolean flag, callers
    // 2..5 would resolve before the import completed and see nothing registered.
    await Promise.all(Array.from({ length: 5 }, () => bootstrapEmailProviders()));

    expect(() => getEmailProvider('gmail')).not.toThrow();
    expect(() => getEmailProvider('outlook')).not.toThrow();
  });

  it('registers a provider for every supported platform', async () => {
    await bootstrapEmailProviders();
    for (const platform of EMAIL_PLATFORMS) {
      expect(() => getEmailProvider(platform)).not.toThrow();
    }
  });

  it('is idempotent across repeated calls', async () => {
    await bootstrapEmailProviders();
    await bootstrapEmailProviders();
    expect(getEmailProvider('outlook')).toBe(getEmailProvider('outlook'));
  });

  it('still rejects a platform that is not an email provider', async () => {
    await bootstrapEmailProviders();
    expect(() => getEmailProvider('linkedin')).toThrow(/No email provider registered/);
  });
});
