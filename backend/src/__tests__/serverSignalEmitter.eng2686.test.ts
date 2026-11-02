import {
  emitAppSignal,
  emitEmailEngagementSignal,
  emitResendEngagementSignal,
  emitStripeSignals,
  mapOnboardingEventToSignal,
  mapResendEventToEngagementSignal,
  PLATFORM_EMAIL_SENDER,
  DEFAULT_HIREEMMA_SIGNAL_LIST_ID,
} from '../services/serverSignalEmitter';

const user = { userId: 'u-9', email: 'founder@acme.io', createdAt: '2026-02-01T00:00:00.000Z' };
const sessionList = { listId: DEFAULT_HIREEMMA_SIGNAL_LIST_ID, listType: 'session', userId: 'owner' };

function deps(over: Record<string, any> = {}) {
  return {
    getList: jest.fn().mockResolvedValue(sessionList),
    ingest: jest.fn().mockResolvedValue({}),
    findUserByStripeCustomerId: jest.fn().mockResolvedValue(user),
    findUserById: jest.fn().mockResolvedValue(user),
    findUserByEmail: jest.fn().mockResolvedValue(user),
    now: () => 1_800_000_000_000,
    logger: { warn: jest.fn(), error: jest.fn() },
    ...over,
  };
}

const parsedOf = (d: ReturnType<typeof deps>, i = 0) => d.ingest.mock.calls[i][0].parsed;

const resend = (type: string, data: Record<string, any> = {}) => ({
  type,
  data: { email_id: 're_1', from: `AgentWeb <${PLATFORM_EMAIL_SENDER}>`, to: ['Founder@Acme.io'], subject: 'Welcome', ...data },
});

describe('ENG-2686 email engagement (platform email only)', () => {
  it.each([
    ['email.sent', 'email_sent'],
    ['email.suppressed', 'email_suppressed'],
    ['email.opened', 'email_opened'],
    ['email.clicked', 'email_clicked'],
    ['email.bounced', 'email_bounced'],
    ['email.complained', 'email_unsubscribed'],
  ])('%s from the platform sender emits %s on the recipient account row', async (type, name) => {
    const d = deps();
    await expect(emitResendEngagementSignal(resend(type, { click: { link: 'https://hireemma.ai/x' } }), d)).resolves.toBe(true);
    expect(d.findUserByEmail).toHaveBeenCalledWith('founder@acme.io');
    const parsed = parsedOf(d);
    expect(parsed.customName).toBe(name);
    expect(parsed.identity.sessionId).toBe('acct-u-9');
    expect(JSON.parse(parsed.client.lastCustomProps).emailId).toBe('re_1');
  });

  it('drops email a customer (or Emma) sends to their own contacts', async () => {
    expect(mapResendEventToEngagementSignal(resend('email.opened', { from: 'Jane <jane@customer.com>' }))).toBeNull();
    expect(mapResendEventToEngagementSignal(resend('email.opened', { from: 'emma@updates.agentweb.pro' }))).toBeNull();
    const d = deps();
    await expect(emitResendEngagementSignal(resend('email.clicked', { from: 'sales@customer.com' }), d)).resolves.toBe(false);
    expect(d.findUserByEmail).not.toHaveBeenCalled();
    expect(d.ingest).not.toHaveBeenCalled();
  });

  it('ignores Resend events outside the plan (delivered, received)', () => {
    expect(mapResendEventToEngagementSignal(resend('email.delivered'))).toBeNull();
    expect(mapResendEventToEngagementSignal(resend('email.received'))).toBeNull();
  });

  it('drops a platform email whose recipient has no AgentWeb account', async () => {
    const d = deps({ findUserByEmail: jest.fn().mockResolvedValue(null) });
    await expect(emitEmailEngagementSignal('stranger@nowhere.io', 'email_sent', {}, d)).resolves.toBe(false);
    expect(d.ingest).not.toHaveBeenCalled();
  });
});

describe('ENG-2686 app lifecycle', () => {
  it('emits login for an account object without a lookup', async () => {
    const d = deps();
    await expect(emitAppSignal(user, 'login', { method: 'password' }, d)).resolves.toBe(true);
    expect(d.findUserById).not.toHaveBeenCalled();
    expect(parsedOf(d).customName).toBe('login');
    expect(JSON.parse(parsedOf(d).client.lastCustomProps)).toEqual({ method: 'password' });
  });

  it('resolves a userId and drops an unknown one', async () => {
    const d = deps();
    await expect(emitAppSignal('u-9', 'integration_connected', { platform: 'hubspot' }, d)).resolves.toBe(true);
    expect(d.findUserById).toHaveBeenCalledWith('u-9');
    const unknown = deps({ findUserById: jest.fn().mockResolvedValue(null) });
    await expect(emitAppSignal('ghost', 'logout', {}, unknown)).resolves.toBe(false);
    expect(unknown.ingest).not.toHaveBeenCalled();
  });

  it('maps onboarding events: terminal ones by name, lifecycle steps as onboarding_step_completed, lateral → none', () => {
    expect(mapOnboardingEventToSignal('onboarding_completed', false)).toEqual({ name: 'onboarding_completed', props: {} });
    expect(mapOnboardingEventToSignal('onboarding_skipped', false)?.name).toBe('onboarding_skipped');
    expect(mapOnboardingEventToSignal('onboarding_abandoned', false)?.name).toBe('onboarding_abandoned');
    expect(mapOnboardingEventToSignal('goal_selected', false)).toEqual({ name: 'onboarding_step_completed', props: { step: 'goal_selected' } });
    expect(mapOnboardingEventToSignal('voice_onboarding_presented', true)).toBeNull();
  });

  it('a trialing subscription.created emits trial_activated alongside subscription_started', async () => {
    const d = deps();
    const event = { id: 'evt_t', type: 'customer.subscription.created', data: { object: { id: 'sub_t', customer: 'cus_1', status: 'trialing' } } };
    await expect(emitStripeSignals(event, d)).resolves.toBe(2);
    expect(d.ingest.mock.calls.map((c: any[]) => c[0].parsed.customName)).toEqual(['subscription_started', 'trial_activated']);
  });
});

describe('ENG-2686 non-blocking emission', () => {
  it('returns false (never throws) when ingest, lookup or list fails', async () => {
    await expect(emitAppSignal(user, 'login', {}, deps({ ingest: jest.fn().mockRejectedValue(new Error('ddb down')) }))).resolves.toBe(false);
    await expect(emitAppSignal('u-9', 'login', {}, deps({ findUserById: jest.fn().mockRejectedValue(new Error('x')) }))).resolves.toBe(false);
    await expect(emitResendEngagementSignal(resend('email.opened'), deps({ findUserByEmail: jest.fn().mockRejectedValue(new Error('x')) }))).resolves.toBe(false);
    await expect(emitEmailEngagementSignal('founder@acme.io', 'email_sent', {}, deps({ getList: jest.fn().mockResolvedValue(null) }))).resolves.toBe(false);
    await expect(emitResendEngagementSignal(null as any, deps())).resolves.toBe(false);
  });

  it('a fire-and-forget caller completes normally while ingest is failing', async () => {
    const d = deps({ ingest: jest.fn().mockRejectedValue(new Error('ddb down')) });
    const handler = async () => {
      void emitAppSignal(user, 'login', {}, d);
      return 'ok';
    };
    await expect(handler()).resolves.toBe('ok');
    await new Promise((r) => setImmediate(r));
    expect(d.logger.error).toHaveBeenCalled();
  });
});
