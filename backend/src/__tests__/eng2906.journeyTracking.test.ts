/**
 * ENG-2906 PR1 — trackJourney is fail-open and privacy-allowlisted. The PostHog client is an
 * explicit seam (setJourneyClientForTests); no test ever loads posthog-node or the network.
 */
import {
  aliasJourney,
  anonymousSetupId,
  flushJourney,
  identifyJourney,
  resolveJourneyClientConfig,
  sanitizeJourneyProps,
  setJourneyClientForTests,
  trackJourney,
  type JourneyClient,
} from '../services/journeyTracking';

function fakeClient(overrides: Partial<JourneyClient> = {}): { [K in keyof JourneyClient]: jest.Mock } {
  return {
    capture: jest.fn(),
    identify: jest.fn(),
    alias: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

afterEach(() => setJourneyClientForTests(undefined));

describe('ENG-2906 trackJourney', () => {
  it('captures the event with the userId as distinct id and only allowlisted props', async () => {
    const client = fakeClient();
    setJourneyClientForTests(client);
    await trackJourney({ userId: 'user-1' }, 'connected', {
      product: 'zoma',
      clientType: 'claude_code',
      email: 'owner@acme.com',
      access_token: 'zoma_secret',
      campaignName: 'Black Friday',
      spend: 120,
    });
    expect(client.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'connected',
      properties: { product: 'zoma', clientType: 'claude_code' },
    });
  });

  it('uses the anonymous setup id when there is no user yet', async () => {
    const client = fakeClient();
    setJourneyClientForTests(client);
    await trackJourney({ anonId: 'zoma_setup_abc' }, 'setup_started', { product: 'zoma' });
    expect(client.capture.mock.calls[0][0].distinctId).toBe('zoma_setup_abc');
  });

  it('is fail-open: a throwing client never rejects and never throws', async () => {
    const client = fakeClient({ capture: jest.fn(() => { throw new Error('posthog down'); }) as any });
    setJourneyClientForTests(client);
    const log = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(trackJourney({ userId: 'user-1' }, 'signed_up', { product: 'emma_web' })).resolves.toBeUndefined();
    await expect(identifyJourney('user-1', { signupProduct: 'zoma' })).resolves.toBeUndefined();
    log.mockRestore();
  });

  it('identify/alias failures are swallowed too', async () => {
    const client = fakeClient({
      identify: jest.fn(() => { throw new Error('x'); }) as any,
      alias: jest.fn(() => { throw new Error('y'); }) as any,
      flush: jest.fn().mockRejectedValue(new Error('z')),
    });
    setJourneyClientForTests(client);
    const log = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(identifyJourney('user-1', { zomaStage: 'connected' })).resolves.toBeUndefined();
    await expect(aliasJourney('user-1', 'zoma_setup_abc')).resolves.toBeUndefined();
    await expect(flushJourney()).resolves.toBeUndefined();
    log.mockRestore();
  });

  it('sets allowlisted person properties (signup set-once, products/stage set)', async () => {
    const client = fakeClient();
    setJourneyClientForTests(client);
    await identifyJourney('user-1', {
      signupProduct: 'zoma', signupPath: 'zoma_device', signupClient: 'zoma_device', signupRef: 'hn',
      products: ['zoma', 'emma_mcp'], zomaStage: 'connected', email: 'x@y.com',
    });
    expect(client.identify).toHaveBeenCalledWith({
      distinctId: 'user-1',
      properties: {
        $set_once: { signupProduct: 'zoma', signupPath: 'zoma_device', signupClient: 'zoma_device', signupRef: 'hn' },
        $set: { products: ['zoma', 'emma_mcp'], zomaStage: 'connected' },
      },
    });
  });

  it('aliases the anonymous setup id onto the user', async () => {
    const client = fakeClient();
    setJourneyClientForTests(client);
    await aliasJourney('user-1', 'zoma_setup_abc');
    expect(client.alias).toHaveBeenCalledWith({ distinctId: 'user-1', alias: 'zoma_setup_abc' });
  });

  it('is a silent no-op when tracking is disabled (no client)', async () => {
    setJourneyClientForTests(null);
    await expect(trackJourney({ userId: 'user-1' }, 'connected', {})).resolves.toBeUndefined();
  });
});

describe('ENG-2906 privacy allowlist', () => {
  it('drops non-allowlisted keys, email-like and token-like values, and objects', () => {
    expect(
      sanitizeJourneyProps({
        product: 'zoma',
        ref: 'someone@acme.com',
        platform: 'meta',
        toolName: 'zoma_getting_started',
        signupClient: 'zoma_' + 'A'.repeat(43),
        clientType: 'Bearer abc',
        authMethod: 'aw_' + 'b'.repeat(40),
        nested: { a: 1 },
        account_id: 'act_123',
      }),
    ).toEqual({ product: 'zoma', platform: 'meta', toolName: 'zoma_getting_started' });
  });

  it('anonymous setup ids are a hash of the device id, never the device id itself', () => {
    const id = anonymousSetupId('f'.repeat(64));
    expect(id).toMatch(/^zoma_setup_[0-9a-f]{32}$/);
    expect(id).not.toContain('f'.repeat(32));
  });
});

describe('ENG-2906 client config', () => {
  it('defaults the host and falls back to the public project token', () => {
    expect(resolveJourneyClientConfig({ NODE_ENV: 'production' })).toEqual({
      token: 'phc_miHNk9CcBDiPNUkGnNvKuvaJDPy8zzKGqSj3RnsusHwL',
      host: 'https://us.i.posthog.com',
    });
    expect(resolveJourneyClientConfig({ NODE_ENV: 'production', POSTHOG_PROJECT_TOKEN: 'phc_x', POSTHOG_HOST: 'https://eu.i.posthog.com' })).toEqual({
      token: 'phc_x',
      host: 'https://eu.i.posthog.com',
    });
  });

  it('is disabled under test and by JOURNEY_TRACKING_DISABLED', () => {
    expect(resolveJourneyClientConfig({ NODE_ENV: 'test' })).toBeNull();
    expect(resolveJourneyClientConfig({ NODE_ENV: 'production', JOURNEY_TRACKING_DISABLED: 'true' })).toBeNull();
  });
});
