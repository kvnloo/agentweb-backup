import { createStripeClient, STRIPE_API_VERSION } from '../services/stripeClientFactory';

/**
 * Characterization + guard tests for the Stripe client factory (ENG-401).
 *
 * AC1: with STRIPE_API_BASE unset, the client is identical to the previous
 *      inline construction (real Stripe host, pinned apiVersion).
 * AC2: with STRIPE_API_BASE set while NODE_ENV=production, boot fails loudly.
 *
 * Uses the SDK's public `getApiField()` to read the resolved transport config
 * without making any network calls.
 */
describe('createStripeClient', () => {
  const savedBase = process.env.STRIPE_API_BASE;
  const savedEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedBase === undefined) delete process.env.STRIPE_API_BASE;
    else process.env.STRIPE_API_BASE = savedBase;
    process.env.NODE_ENV = savedEnv;
  });

  describe('default behavior (STRIPE_API_BASE unset) — characterization', () => {
    beforeEach(() => {
      delete process.env.STRIPE_API_BASE;
      process.env.NODE_ENV = 'test';
    });

    it('targets the real Stripe host', () => {
      const client = createStripeClient('sk_test_dummy');
      expect((client as any).getApiField('host')).toBe('api.stripe.com');
      expect((client as any).getApiField('protocol')).toBe('https');
    });

    it('pins the expected API version', () => {
      const client = createStripeClient('sk_test_dummy');
      expect((client as any).getApiField('version')).toBe(STRIPE_API_VERSION);
    });

    it('passes extra options through (e.g. Connect stripeAccount)', () => {
      const client = createStripeClient('sk_test_dummy', {
        stripeAccount: 'acct_123',
      });
      expect((client as any).getApiField('stripeAccount')).toBe('acct_123');
      expect((client as any).getApiField('host')).toBe('api.stripe.com');
    });
  });

  describe('STRIPE_API_BASE set outside production — test seam', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('redirects host/port/protocol to the mock base', () => {
      process.env.STRIPE_API_BASE = 'http://localhost:12111';
      const client = createStripeClient('sk_test_dummy');
      expect((client as any).getApiField('host')).toBe('localhost');
      expect((client as any).getApiField('protocol')).toBe('http');
      expect(String((client as any).getApiField('port'))).toBe('12111');
    });

    it('honors an https base without an explicit port', () => {
      process.env.STRIPE_API_BASE = 'https://abc--stripe.sandbox.argalabs.com';
      const client = createStripeClient('sk_test_dummy');
      expect((client as any).getApiField('host')).toBe('abc--stripe.sandbox.argalabs.com');
      expect((client as any).getApiField('protocol')).toBe('https');
    });

    it('throws loudly on a malformed base', () => {
      process.env.STRIPE_API_BASE = 'not-a-url';
      expect(() => createStripeClient('sk_test_dummy')).toThrow();
    });
  });

  describe('STRIPE_API_BASE set in production — hard boot guard (AC2)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('refuses to construct a client, naming the reason', () => {
      process.env.STRIPE_API_BASE = 'http://localhost:12111';
      expect(() => createStripeClient('sk_live_dummy')).toThrow(/production/i);
    });

    it('is unaffected when STRIPE_API_BASE is unset in production', () => {
      delete process.env.STRIPE_API_BASE;
      const client = createStripeClient('sk_live_dummy');
      expect((client as any).getApiField('host')).toBe('api.stripe.com');
    });
  });
});
