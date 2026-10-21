/**
 * Tests for getTwilioCredentials in secretsManager.ts (ENG-2271).
 *
 * Mirrors secretsManager.whatsapp.test.ts: env vars are used only as a COMPLETE set and are
 * never merged with Secrets Manager, so an account sid from one environment cannot be paired
 * with another's auth token.
 */

export {}; // isolate module scope so top-level mocks don't collide with sibling test files

const mockGetSecretValue = jest.fn();

jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn((params: { SecretId: string }) => ({
      promise: () => mockGetSecretValue(params),
    })),
  })),
}));

const ENV_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const;

const secretCreds = { accountSid: 'ACsmfake', authToken: 'sm-token' };

const setFullEnv = () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACenvfake';
  process.env.TWILIO_AUTH_TOKEN = 'env-token';
};

describe('secretsManager.getTwilioCredentials', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
    ENV_VARS.forEach((v) => delete process.env[v]);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks(); // also undoes the Date.now spy even when a test fails midway
    ENV_VARS.forEach((v) => delete process.env[v]);
  });

  it('returns the env pair without touching Secrets Manager when both are present', async () => {
    setFullEnv();

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).resolves.toEqual({ accountSid: 'ACenvfake', authToken: 'env-token' });
    expect(mockGetSecretValue).not.toHaveBeenCalled();
  });

  it('trims env values and treats a whitespace-only value as unset', async () => {
    setFullEnv();
    process.env.TWILIO_ACCOUNT_SID = '  ACenvfake  ';
    process.env.TWILIO_AUTH_TOKEN = '   ';
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    // The blank token made the env pair incomplete, so nothing from env is used.
    await expect(getTwilioCredentials()).resolves.toEqual(secretCreds);
  });

  it('never merges a partial env set with Secrets Manager, and names what is missing', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACenvfake';
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).resolves.toEqual(secretCreds);
    const warning = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warning).toContain('TWILIO_AUTH_TOKEN');
    expect(warning).not.toContain('TWILIO_ACCOUNT_SID');
  });

  it('stays quiet when no env vars are set at all', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await getTwilioCredentials();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reads the dev secret in development and the prod secret in production', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    process.env.NODE_ENV = 'development';
    let mod = await import('../utils/secretsManager');
    await mod.getTwilioCredentials();
    expect(mockGetSecretValue).toHaveBeenLastCalledWith({ SecretId: 'dev/AgentWeb/Twilio' });

    jest.resetModules();
    process.env.NODE_ENV = 'production';
    mod = await import('../utils/secretsManager');
    await mod.getTwilioCredentials();
    expect(mockGetSecretValue).toHaveBeenLastCalledWith({ SecretId: 'prod/AgentWeb/Twilio' });
  });

  it('returns only the two known fields even if the secret carries extras', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify({ ...secretCreds, other: 'x' }) });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).resolves.toStrictEqual(secretCreds);
  });

  it('fails closed when the secret lacks a field, naming it', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify({ accountSid: 'ACsmfake' }) });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch Twilio credentials');
    expect(errorSpy.mock.calls.flat().map(String).join(' ')).toContain('authToken');
  });

  it('trims the stored values like the env path does', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify({ accountSid: 'ACsmfake\n', authToken: ' sm-token\r\n' }) });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).resolves.toStrictEqual({ accountSid: 'ACsmfake', authToken: 'sm-token' });
  });

  it('never logs secret fragments when the secret is malformed JSON', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: 'FAKE-LEAKY-TOKEN-123 is not json' });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch Twilio credentials');

    const output = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join(' ');
    expect(output).toContain('SyntaxError');
    // JSON.parse quotes only the first ~10 characters of the input in its message.
    expect(output).not.toContain('FAKE-LEAKY');
    // No error object is passed to console either: its stack and message would carry the same text.
    expect([...errorSpy.mock.calls].flat().some((a) => typeof a === 'object')).toBe(false);
  });

  it.each([
    ['a number accountSid', { accountSid: 123, authToken: 'tok' }, 'accountSid'],
    ['an object authToken', { accountSid: 'ACfake', authToken: { x: 1 } }, 'authToken'],
    ['a blank authToken', { accountSid: 'ACfake', authToken: '  ' }, 'authToken'],
    ['a null accountSid', { accountSid: null, authToken: 'tok' }, 'accountSid'],
  ])('fails closed when the secret has %s', async (_label, secret, field) => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secret) });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch Twilio credentials');
    expect(errorSpy.mock.calls.flat().map(String).join(' ')).toContain(field);
  });

  it.each([['null', 'null'], ['an array', '["a","b"]'], ['a string', '"tok"']])('fails closed when the secret JSON is %s', async (_l, raw) => {
    mockGetSecretValue.mockResolvedValue({ SecretString: raw });

    const { getTwilioCredentials } = await import('../utils/secretsManager');
    await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch Twilio credentials');
  });

  it.each([['empty', ''], ['whitespace', '   ']])(
    'fails closed when the secret string is %s',
    async (_label, value) => {
      mockGetSecretValue.mockResolvedValue({ SecretString: value });

      const { getTwilioCredentials } = await import('../utils/secretsManager');
      await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch Twilio credentials');
    },
  );

  it('fails closed on malformed JSON and on a Secrets Manager error, pointing at the env option', async () => {
    mockGetSecretValue.mockResolvedValueOnce({ SecretString: '{not json' });
    let mod = await import('../utils/secretsManager');
    await expect(mod.getTwilioCredentials()).rejects.toThrow(/TWILIO_\* env vars/);

    jest.resetModules();
    mockGetSecretValue.mockRejectedValueOnce(new Error('AccessDenied'));
    mod = await import('../utils/secretsManager');
    await expect(mod.getTwilioCredentials()).rejects.toThrow(/TWILIO_\* env vars/);
  });

  describe('caching the Secrets Manager result', () => {
    it('serves a second call from cache rather than fetching again', async () => {
      mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });
      const { getTwilioCredentials } = await import('../utils/secretsManager');

      await expect(getTwilioCredentials()).resolves.toEqual(secretCreds);
      await expect(getTwilioCredentials()).resolves.toEqual(secretCreds);

      expect(mockGetSecretValue).toHaveBeenCalledTimes(1);
    });

    describe('a failed load', () => {
      let now: number;
      beforeEach(() => {
        now = 1_700_000_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
      });

      it('is remembered for 5 seconds: callers fail fast with no Secrets Manager read and no further log lines', async () => {
        mockGetSecretValue.mockResolvedValue({ SecretString: '' });
        const { getTwilioCredentials } = await import('../utils/secretsManager');

        await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch Twilio credentials');
        const logLinesForOneFailure = errorSpy.mock.calls.length;
        expect(logLinesForOneFailure).toBeGreaterThan(0);
        now += 4_999;
        for (let i = 0; i < 50; i++) await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch Twilio credentials');

        expect(mockGetSecretValue).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(logLinesForOneFailure);
      });

      it('retries against Secrets Manager once the window has passed, and logs again if it still fails', async () => {
        mockGetSecretValue.mockResolvedValue({ SecretString: '' });
        const { getTwilioCredentials } = await import('../utils/secretsManager');

        await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch');
        const logLinesForOneFailure = errorSpy.mock.calls.length;
        now += 5_001;
        await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch');

        expect(mockGetSecretValue).toHaveBeenCalledTimes(2);
        expect(errorSpy).toHaveBeenCalledTimes(2 * logLinesForOneFailure);
      });

      it('recovers on the first call after the window when the secret was fixed', async () => {
        mockGetSecretValue.mockResolvedValueOnce({ SecretString: '' });
        const { getTwilioCredentials } = await import('../utils/secretsManager');

        await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch');
        mockGetSecretValue.mockResolvedValueOnce({ SecretString: JSON.stringify(secretCreds) });
        now += 5_001;
        await expect(getTwilioCredentials()).resolves.toEqual(secretCreds);
        await expect(getTwilioCredentials()).resolves.toEqual(secretCreds); // and the success is cached
        expect(mockGetSecretValue).toHaveBeenCalledTimes(2);
      });

      it('does not block a complete env pair that is set inside the window', async () => {
        mockGetSecretValue.mockResolvedValue({ SecretString: '' });
        const { getTwilioCredentials } = await import('../utils/secretsManager');
        await expect(getTwilioCredentials()).rejects.toThrow('Failed to fetch');

        setFullEnv();
        await expect(getTwilioCredentials()).resolves.toMatchObject({ accountSid: 'ACenvfake' });
      });
    });

    it('re-fetches once the cache entry expires', async () => {
      let now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });
      const { getTwilioCredentials } = await import('../utils/secretsManager');

      await getTwilioCredentials();
      now += 5 * 60 * 1000 - 1; // just under the 5-minute TTL
      await getTwilioCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledTimes(1);

      now += 2; // now just past it
      await getTwilioCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight lookup across concurrent callers', async () => {
      let resolveSecret!: (v: { SecretString: string }) => void;
      mockGetSecretValue.mockReturnValue(new Promise((resolve) => { resolveSecret = resolve; }));
      const { getTwilioCredentials } = await import('../utils/secretsManager');

      const a = getTwilioCredentials();
      const b = getTwilioCredentials();
      resolveSecret({ SecretString: JSON.stringify(secretCreds) });

      await expect(Promise.all([a, b])).resolves.toEqual([secretCreds, secretCreds]);
      expect(mockGetSecretValue).toHaveBeenCalledTimes(1);
    });

    it('__resetTwilioCredentialsCache forces the next call to fetch again', async () => {
      mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });
      const { getTwilioCredentials, __resetTwilioCredentialsCache } = await import('../utils/secretsManager');

      await getTwilioCredentials();
      __resetTwilioCredentialsCache();
      await getTwilioCredentials();

      expect(mockGetSecretValue).toHaveBeenCalledTimes(2);
    });

    it('never caches the env path: a live env change takes effect on the next call', async () => {
      setFullEnv();
      const { getTwilioCredentials } = await import('../utils/secretsManager');

      await expect(getTwilioCredentials()).resolves.toMatchObject({ accountSid: 'ACenvfake' });
      process.env.TWILIO_ACCOUNT_SID = 'ACenvfake2';
      await expect(getTwilioCredentials()).resolves.toMatchObject({ accountSid: 'ACenvfake2' });
      expect(mockGetSecretValue).not.toHaveBeenCalled();
    });
  });
});
