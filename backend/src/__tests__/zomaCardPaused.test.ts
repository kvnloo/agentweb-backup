import { assertZomaWriteReady } from '../mcp/zomaOnboarding';

describe('Zoma card requirement paused by default', () => {
  it('allows writes without a payment method when flag unset', async () => {
    delete process.env.ZOMA_REQUIRE_PAYMENT_METHOD;
    const resolvePaymentMethod = jest.fn();
    const deps: any = {
      getUser: async () => ({ email: 'a@b.c' }),
      resolvePaymentMethod,
      listAccounts: async () => [],
      now: () => Date.now(),
    };
    await expect(assertZomaWriteReady('u1', deps)).rejects.toThrow(/No usable/);
    expect(resolvePaymentMethod).not.toHaveBeenCalled();
  });
});
