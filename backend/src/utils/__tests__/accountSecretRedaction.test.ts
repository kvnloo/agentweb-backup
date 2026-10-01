import {
  redactAccountSecrets,
  redactAccountsSecrets,
  sanitizeUserForResponse,
} from '../accountSecretRedaction';

describe('redactAccountSecrets', () => {
  it('strips access_token and refresh_token but keeps safe config fields', () => {
    const account = {
      platform: 'twitter',
      account_id: 'tw-1',
      account_name: '@handle',
      config: {
        account_type: 'personal',
        twitter_user_id: '999',
        username: 'handle',
        access_token: 'secret-access-value',
        refresh_token: 'secret-refresh-value',
        token_expires_at: 123456,
        scopes: ['tweet.read'],
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    const safe = redactAccountSecrets(account);

    expect(safe.config).not.toHaveProperty('access_token');
    expect(safe.config).not.toHaveProperty('refresh_token');
    expect(safe.config).toMatchObject({
      account_type: 'personal',
      twitter_user_id: '999',
      username: 'handle',
      token_expires_at: 123456,
      scopes: ['tweet.read'],
    });
    expect(safe.platform).toBe('twitter');
    expect(safe.account_id).toBe('tw-1');
  });

  it('strips api_key (Fathom) and webhook_signing_key (Attio/Calendly)', () => {
    const fathomAccount = {
      platform: 'fathom',
      account_id: 'f-1',
      account_name: 'Fathom',
      config: {
        account_type: 'api_key',
        api_key: 'secret-fathom-key',
        access_token: 'secret-access',
        token_expires_at: 0,
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const calendlyAccount = {
      platform: 'calendly',
      account_id: 'c-1',
      account_name: 'Calendly',
      config: {
        account_type: 'calendly',
        access_token: 'secret-access',
        refresh_token: 'secret-refresh',
        webhook_signing_key: 'secret-hmac-key',
        user_uri: 'https://api.calendly.com/users/1',
        organization_uri: 'https://api.calendly.com/organizations/1',
        booking_tracking_active: true,
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    expect(redactAccountSecrets(fathomAccount).config).not.toHaveProperty('api_key');
    const safeCalendly = redactAccountSecrets(calendlyAccount);
    expect(safeCalendly.config).not.toHaveProperty('webhook_signing_key');
    expect(safeCalendly.config).not.toHaveProperty('access_token');
    expect(safeCalendly.config).not.toHaveProperty('refresh_token');
    expect(safeCalendly.config).toMatchObject({ booking_tracking_active: true });
  });

  it('normalizes a missing config to an empty object rather than throwing', () => {
    const account: any = { platform: 'unipile', account_id: 'u-1', account_name: 'LinkedIn' };
    expect(redactAccountSecrets(account).config).toEqual({});
  });
});

describe('redactAccountsSecrets', () => {
  it('maps over an array and treats null/undefined as empty', () => {
    const accounts = [
      { platform: 'gmail', account_id: 'g-1', account_name: 'a@x.com', config: { access_token: 'secret' } },
    ];
    expect(redactAccountsSecrets(accounts)[0].config).not.toHaveProperty('access_token');
    expect(redactAccountsSecrets(undefined)).toEqual([]);
    expect(redactAccountsSecrets(null)).toEqual([]);
  });
});

describe('sanitizeUserForResponse', () => {
  it('strips password, secrets, resetPasswordToken, Stripe Connect tokens, and redacts connected_accounts', () => {
    const user = {
      userId: 'u-1',
      email: 'user@example.com',
      password: 'hashed-password',
      secrets: { foo: 'encrypted-value' },
      resetPasswordToken: 'reset-token-value',
      stripeConnectAccessToken: 'encrypted-stripe-access',
      stripeConnectRefreshToken: 'encrypted-stripe-refresh',
      connected_accounts: [
        {
          platform: 'hubspot',
          account_id: 'h-1',
          account_name: 'HubSpot',
          config: { access_token: 'secret', refresh_token: 'secret2', hub_id: 1 },
        },
      ],
      displayName: 'Test User',
    };

    const safe = sanitizeUserForResponse(user) as Record<string, any>;

    expect(safe).not.toHaveProperty('password');
    expect(safe).not.toHaveProperty('secrets');
    expect(safe).not.toHaveProperty('resetPasswordToken');
    expect(safe).not.toHaveProperty('stripeConnectAccessToken');
    expect(safe).not.toHaveProperty('stripeConnectRefreshToken');
    expect(safe.connected_accounts[0].config).not.toHaveProperty('access_token');
    expect(safe.connected_accounts[0].config).not.toHaveProperty('refresh_token');
    expect(safe.connected_accounts[0].config.hub_id).toBe(1);
    expect(safe.displayName).toBe('Test User');
    expect(safe.userId).toBe('u-1');
  });

  it('passes through null/undefined unchanged', () => {
    expect(sanitizeUserForResponse(null)).toBeNull();
    expect(sanitizeUserForResponse(undefined)).toBeUndefined();
  });
});
