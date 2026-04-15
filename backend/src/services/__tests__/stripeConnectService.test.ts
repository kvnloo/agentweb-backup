import {
  buildAuthorizeUrl,
  getStripeConnectConfig,
  exchangeCodeForTokens,
  deauthorize,
  refreshAccessToken,
  getClientForUser,
} from '../stripeConnectService';

describe('stripeConnectService', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    process.env.STRIPE_CONNECT_CLIENT_ID_LIVE = 'ca_live_xyz';
    process.env.STRIPE_CONNECT_CLIENT_ID_TEST = 'ca_test_abc';
    process.env.STRIPE_CONNECT_MODE = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_platform_secret';
    process.env.BACKEND_URL = 'http://localhost:3001';
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  describe('getStripeConnectConfig', () => {
    it('defaults to test mode in non-prod when STRIPE_CONNECT_MODE is unset', () => {
      delete process.env.STRIPE_CONNECT_MODE;
      const cfg = getStripeConnectConfig();
      expect(cfg.mode).toBe('test');
      expect(cfg.clientId).toBe('ca_test_abc');
    });

    it('uses live client_id when STRIPE_CONNECT_MODE=live', () => {
      process.env.STRIPE_CONNECT_MODE = 'live';
      expect(getStripeConnectConfig().clientId).toBe('ca_live_xyz');
    });

    it('defaults to live when NODE_ENV=production and no explicit mode', () => {
      delete process.env.STRIPE_CONNECT_MODE;
      process.env.NODE_ENV = 'production';
      expect(getStripeConnectConfig().mode).toBe('live');
    });

    it('throws if the resolved client_id env var is missing', () => {
      delete process.env.STRIPE_CONNECT_CLIENT_ID_TEST;
      expect(() => getStripeConnectConfig()).toThrow(/STRIPE_CONNECT_CLIENT_ID_TEST/);
    });

    it('builds redirect URI from BACKEND_URL without trailing slash', () => {
      process.env.BACKEND_URL = 'https://api.example.com/';
      const cfg = getStripeConnectConfig();
      expect(cfg.redirectUri).toBe('https://api.example.com/api/stripe/connect/callback');
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('includes response_type, client_id, scope=read_only, redirect_uri, state', () => {
      const url = buildAuthorizeUrl('my-state-token');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://connect.stripe.com/oauth/authorize');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('client_id')).toBe('ca_test_abc');
      expect(parsed.searchParams.get('scope')).toBe('read_only');
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3001/api/stripe/connect/callback'
      );
      expect(parsed.searchParams.get('state')).toBe('my-state-token');
    });

    it('never requests read_write scope', () => {
      const url = buildAuthorizeUrl('state');
      expect(url).not.toContain('read_write');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('posts to /oauth/token with grant_type=authorization_code and platform secret', async () => {
      const post = jest.fn().mockResolvedValue({
        data: {
          access_token: 'sk_test_access',
          refresh_token: 'rt_live_refresh',
          stripe_user_id: 'acct_1RVyGeGS8i9KS4NK',
          scope: 'read_only',
          livemode: false,
          token_type: 'bearer',
        },
      });
      const httpClient = { post } as any;
      const result = await exchangeCodeForTokens('auth-code-xyz', getStripeConnectConfig(), httpClient);
      expect(post).toHaveBeenCalledTimes(1);
      const [url, body, opts] = post.mock.calls[0];
      expect(url).toBe('https://connect.stripe.com/oauth/token');
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=auth-code-xyz');
      expect(opts.headers.Authorization).toBe('Bearer sk_test_platform_secret');
      expect(result.stripe_user_id).toBe('acct_1RVyGeGS8i9KS4NK');
      expect(result.scope).toBe('read_only');
    });

    it('throws when platform secret key is missing', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      await expect(exchangeCodeForTokens('c')).rejects.toThrow(/STRIPE_SECRET_KEY/);
    });
  });

  describe('refreshAccessToken', () => {
    it('posts grant_type=refresh_token with the refresh token', async () => {
      const post = jest.fn().mockResolvedValue({
        data: {
          access_token: 'sk_test_new',
          refresh_token: 'rt_live_new',
          stripe_user_id: 'acct_abc',
          scope: 'read_only',
          livemode: false,
          token_type: 'bearer',
        },
      });
      await refreshAccessToken('rt_old', getStripeConnectConfig(), { post } as any);
      const [, body] = post.mock.calls[0];
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=rt_old');
    });
  });

  describe('deauthorize', () => {
    it('posts client_id + stripe_user_id and returns the response', async () => {
      const post = jest.fn().mockResolvedValue({ data: { stripe_user_id: 'acct_zzz' } });
      const result = await deauthorize('acct_zzz', getStripeConnectConfig(), { post } as any);
      expect(post).toHaveBeenCalledTimes(1);
      const [url, body] = post.mock.calls[0];
      expect(url).toBe('https://connect.stripe.com/oauth/deauthorize');
      expect(body).toContain('client_id=ca_test_abc');
      expect(body).toContain('stripe_user_id=acct_zzz');
      expect(result.stripe_user_id).toBe('acct_zzz');
    });

    it('swallows 401 (already deauthorized) and returns success', async () => {
      const err = Object.assign(new Error('unauthorized'), {
        response: { status: 401, data: { error: 'invalid_grant' } },
      });
      const post = jest.fn().mockRejectedValue(err);
      const result = await deauthorize('acct_gone', getStripeConnectConfig(), { post } as any);
      expect(result.stripe_user_id).toBe('acct_gone');
    });

    it('rethrows on non-401 errors', async () => {
      const err = Object.assign(new Error('server down'), {
        response: { status: 503, data: { error: 'service_unavailable' } },
      });
      const post = jest.fn().mockRejectedValue(err);
      await expect(
        deauthorize('acct_fine', getStripeConnectConfig(), { post } as any)
      ).rejects.toThrow(/server down/);
    });
  });

  describe('getClientForUser', () => {
    it('returns null when no connected account id', () => {
      expect(getClientForUser(null)).toBeNull();
      expect(getClientForUser({})).toBeNull();
    });

    it('returns a Stripe client when user has a connected account', () => {
      const client = getClientForUser({ stripeConnectedAccountId: 'acct_1RVyGeGS8i9KS4NK' } as any);
      expect(client).not.toBeNull();
      // Stripe SDK doesn't expose stripeAccount directly, but the client should
      // be an instance that we can use.
      expect(typeof (client as any).customers?.list).toBe('function');
    });

    it('returns null when STRIPE_SECRET_KEY is missing', () => {
      delete process.env.STRIPE_SECRET_KEY;
      expect(getClientForUser({ stripeConnectedAccountId: 'acct_x' } as any)).toBeNull();
    });
  });
});
