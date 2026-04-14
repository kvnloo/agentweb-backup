import {
  onUserSignup,
  onEmmaSessionStart,
  onStripeSubscriptionEvent,
} from '../crmSignalHooks';
import type { SyncInput, SyncResult } from '../contactSyncService';

function makeStubSync() {
  const calls: SyncInput[] = [];
  const fn = jest.fn(async (input: SyncInput): Promise<SyncResult> => {
    calls.push(input);
    return {
      contactId: input.identity.email?.toLowerCase() || `nocontact:${input.sourceRecordId}`,
      created: true,
      deduplicated: false,
      event: {
        contactId: input.identity.email?.toLowerCase() || 'x',
        eventTimestamp: '2026-04-13T00:00:00Z',
        eventId: 'evt_1',
        source: input.source,
        eventType: input.eventType,
        payload: input.payload || {},
        sourceRecordId: input.sourceRecordId,
        createdAt: '2026-04-13T00:00:00Z',
      },
      scores: { heatScore: 0, healthScore: 0, lifecycle: 'unknown' },
    };
  });
  return { fn, calls };
}

const silentLogger = { error: jest.fn(), warn: jest.fn() };

describe('onUserSignup', () => {
  it('builds a signup sync payload from user fields', async () => {
    const { fn, calls } = makeStubSync();
    await onUserSignup(
      {
        userId: 'u_123',
        email: 'Jane@Acme.com',
        firstName: 'Jane',
        lastName: 'Doe',
        companyName: 'Acme',
        isOAuthUser: false,
      },
      { syncContact: fn, logger: silentLogger }
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].source).toBe('signup');
    expect(calls[0].sourceRecordId).toBe('user-u_123');
    expect(calls[0].identity.email).toBe('Jane@Acme.com');
    expect(calls[0].identity.firstName).toBe('Jane');
    expect(calls[0].identity.lastName).toBe('Doe');
    expect(calls[0].companyName).toBe('Acme');
    expect(calls[0].eventType).toBe('contact.created');
    expect(calls[0].payload?.signupSource).toBe('password');
    expect(calls[0].payload?.userId).toBe('u_123');
  });

  it('derives first/last name from displayName when not given', async () => {
    const { fn, calls } = makeStubSync();
    await onUserSignup(
      { userId: 'u_1', email: 'a@b.com', displayName: 'Harsha Vankayalapati' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(calls[0].identity.firstName).toBe('Harsha');
    expect(calls[0].identity.lastName).toBe('Vankayalapati');
  });

  it('marks signupSource=oauth when isOAuthUser', async () => {
    const { fn, calls } = makeStubSync();
    await onUserSignup(
      { userId: 'u_1', email: 'a@b.com', isOAuthUser: true },
      { syncContact: fn, logger: silentLogger }
    );
    expect(calls[0].payload?.signupSource).toBe('oauth');
  });

  it('swallows errors so caller is never broken', async () => {
    const fn = jest.fn(async () => {
      throw new Error('dynamo down');
    });
    const res = await onUserSignup(
      { userId: 'u_1', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(res).toBeNull();
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('skips when email missing', async () => {
    const { fn } = makeStubSync();
    const res = await onUserSignup(
      { userId: 'u_1', email: '' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(res).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('onEmmaSessionStart', () => {
  it('logs an engagement.emma_session event', async () => {
    const { fn, calls } = makeStubSync();
    await onEmmaSessionStart(
      {
        sessionId: 'sess_abc',
        userId: 'u_1',
        email: 'harsha@agentweb.pro',
        portalType: 'customer',
        sessionType: 'regular',
      },
      { syncContact: fn, logger: silentLogger }
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].source).toBe('emma_session');
    expect(calls[0].sourceRecordId).toBe('emma-session-sess_abc');
    expect(calls[0].eventType).toBe('engagement.emma_session');
    expect(calls[0].payload?.sessionId).toBe('sess_abc');
    expect(calls[0].payload?.portalType).toBe('customer');
  });

  it('is idempotent on replay via sourceRecordId shape', async () => {
    // Same sessionId -> same sourceRecordId -> contactSyncService dedupes.
    const { fn } = makeStubSync();
    await onEmmaSessionStart(
      { sessionId: 'sess_1', userId: 'u_1', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    await onEmmaSessionStart(
      { sessionId: 'sess_1', userId: 'u_1', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][0].sourceRecordId).toBe(
      fn.mock.calls[1][0].sourceRecordId
    );
  });

  it('swallows errors so caller is never broken', async () => {
    const fn = jest.fn(async () => {
      throw new Error('boom');
    });
    const res = await onEmmaSessionStart(
      { sessionId: 'sess_1', userId: 'u_1', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(res).toBeNull();
  });

  it('skips when email missing', async () => {
    const { fn } = makeStubSync();
    const res = await onEmmaSessionStart(
      { sessionId: 'sess_1', userId: 'u_1', email: '' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(res).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('onStripeSubscriptionEvent', () => {
  it('maps customer.subscription.created -> payment.subscribed', async () => {
    const { fn, calls } = makeStubSync();
    await onStripeSubscriptionEvent(
      {
        eventId: 'evt_abc',
        eventType: 'customer.subscription.created',
        email: 'jane@acme.com',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'active',
        subscriptionType: 'pro',
      },
      { syncContact: fn, logger: silentLogger }
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].source).toBe('stripe');
    expect(calls[0].sourceRecordId).toBe('stripe-evt_abc');
    expect(calls[0].eventType).toBe('payment.subscribed');
    expect(calls[0].payload?.stripeCustomerId).toBe('cus_1');
    expect(calls[0].payload?.status).toBe('active');
  });

  it('maps customer.subscription.deleted -> payment.canceled', async () => {
    const { fn, calls } = makeStubSync();
    await onStripeSubscriptionEvent(
      { eventId: 'e2', eventType: 'customer.subscription.deleted', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(calls[0].eventType).toBe('payment.canceled');
  });

  it('maps customer.subscription.updated (past_due) -> payment.updated', async () => {
    const { fn, calls } = makeStubSync();
    await onStripeSubscriptionEvent(
      {
        eventId: 'e3',
        eventType: 'customer.subscription.updated',
        email: 'a@b.com',
        status: 'past_due',
      },
      { syncContact: fn, logger: silentLogger }
    );
    expect(calls[0].eventType).toBe('payment.updated');
    expect(calls[0].payload?.status).toBe('past_due');
  });

  it('is idempotent on the same Stripe event id (sourceRecordId)', async () => {
    const { fn } = makeStubSync();
    await onStripeSubscriptionEvent(
      { eventId: 'evt_dup', eventType: 'customer.subscription.updated', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    await onStripeSubscriptionEvent(
      { eventId: 'evt_dup', eventType: 'customer.subscription.updated', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(fn.mock.calls[0][0].sourceRecordId).toBe(
      fn.mock.calls[1][0].sourceRecordId
    );
  });

  it('skips when email missing', async () => {
    const { fn } = makeStubSync();
    const res = await onStripeSubscriptionEvent(
      { eventId: 'e', eventType: 'customer.subscription.updated', email: '' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(res).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('swallows errors so webhook response is never broken', async () => {
    const fn = jest.fn(async () => {
      throw new Error('network');
    });
    const res = await onStripeSubscriptionEvent(
      { eventId: 'e', eventType: 'customer.subscription.updated', email: 'a@b.com' },
      { syncContact: fn, logger: silentLogger }
    );
    expect(res).toBeNull();
  });
});
