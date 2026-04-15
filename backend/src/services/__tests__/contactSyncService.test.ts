// Stub the auto-enroll module — contactSyncService lazy-requires it at call
// time. Without this, signup-typed test inputs would drag in real db.ts and
// try to talk to DynamoDB.
jest.mock('../signupAutoEnrollService', () => ({
  enrollSignupIntoFoundersList: jest.fn(async () => ({
    enrolled: false,
    reason: 'test_stub',
  })),
  FOUNDERS_USERID: 'be754b6c-767e-44ec-b181-4042cfe45ea9',
  FOUNDERS_SIGNUPS_LIST_NAME: 'AgentWeb Signups',
}));

import {
  syncContact,
  resolveIdentity,
  mergeFields,
  SyncInput,
  ContactSignalBundle,
} from '../contactSyncService';
import { ContactEvent } from '../contactEventsDb';

function baseInput(overrides: Partial<SyncInput> = {}): SyncInput {
  return {
    source: 'signup',
    sourceRecordId: 'user_1_signup',
    identity: { email: 'Jane@Acme.com' },
    eventType: 'contact.created',
    payload: { plan: 'free' },
    ...overrides,
  };
}

function makeStubEventsDb(initialEvents: ContactEvent[] = []) {
  const store: ContactEvent[] = [...initialEvents];
  const deps = {
    logEvent: jest.fn(async (input: any) => {
      const dup = store.find(e => e.sourceRecordId === input.sourceRecordId);
      if (dup) return { event: dup, deduplicated: true };
      const event: ContactEvent = {
        contactId: input.contactId,
        eventTimestamp: input.eventTimestamp || new Date().toISOString(),
        eventId: `evt_${store.length + 1}`,
        source: input.source,
        eventType: input.eventType,
        payload: input.payload || {},
        sourceRecordId: input.sourceRecordId,
        createdAt: new Date().toISOString(),
        ...(input.dealId ? { dealId: input.dealId } : {}),
      };
      store.push(event);
      return { event, deduplicated: false };
    }),
    findBySourceRecordId: jest.fn(async (sri: string) => {
      return store.find(e => e.sourceRecordId === sri) || null;
    }),
  };
  return { deps, store };
}

describe('resolveIdentity', () => {
  it('normalises email and derives domain', () => {
    const r = resolveIdentity(baseInput({ identity: { email: 'Jane@Acme.com' } }));
    expect(r.contactId).toBe('jane@acme.com');
    expect(r.email).toBe('jane@acme.com');
    expect(r.domain).toBe('acme.com');
    expect(r.isProvisional).toBe(false);
  });

  it('does NOT derive domain for free-email providers', () => {
    const r = resolveIdentity(baseInput({ identity: { email: 'x@gmail.com' } }));
    expect(r.domain).toBe(null);
  });

  it('supplied domain wins over derived', () => {
    const r = resolveIdentity(
      baseInput({ identity: { email: 'jane@acme.com', domain: 'acme-corp.com' } })
    );
    expect(r.domain).toBe('acme-corp.com');
  });

  it('provisional contactId when no email', () => {
    const r = resolveIdentity(
      baseInput({
        identity: { domain: 'acme.com', firstName: 'Jane' },
        sourceRecordId: 'lead_form_123',
      })
    );
    expect(r.isProvisional).toBe(true);
    expect(r.contactId).toBe('nocontact:lead_form_123');
    expect(r.email).toBe(null);
    expect(r.domain).toBe('acme.com');
  });

  it('throws when both email and sourceRecordId are missing', () => {
    expect(() =>
      resolveIdentity({
        source: 'manual',
        sourceRecordId: '',
        identity: {},
        eventType: 'contact.created',
      })
    ).toThrow(/no email/);
  });
});

describe('mergeFields', () => {
  it('fills null/empty existing fields from incoming', () => {
    const out = mergeFields(
      { firstName: null, lastName: 'Smith', company: '' } as any,
      { firstName: 'Jane', company: 'Acme' } as any,
      { source: 'lead_form' }
    );
    expect(out.firstName).toBe('Jane');
    expect(out.company).toBe('Acme');
    expect(out.lastName).toBe('Smith');
  });

  it('stripe source wins for payment fields', () => {
    const out = mergeFields(
      { subscriptionType: 'free', mrr: 0 } as any,
      { subscriptionType: 'pro', mrr: 49 } as any,
      { source: 'stripe' }
    );
    expect(out.subscriptionType).toBe('pro');
    expect(out.mrr).toBe(49);
  });

  it('stripe does NOT overwrite human-editable non-payment fields', () => {
    const out = mergeFields(
      { firstName: 'Jane', subscriptionType: 'free' } as any,
      { firstName: 'Janet', subscriptionType: 'pro' } as any,
      { source: 'stripe' }
    );
    expect(out.firstName).toBe('Jane');
    expect(out.subscriptionType).toBe('pro');
  });

  it('lead_form source overwrites existing name/company', () => {
    const out = mergeFields(
      { firstName: 'Jane', company: 'Old Co' } as any,
      { firstName: 'Janet', company: 'New Co' } as any,
      { source: 'lead_form' }
    );
    expect(out.firstName).toBe('Janet');
    expect(out.company).toBe('New Co');
  });

  it('generic source keeps existing non-null values', () => {
    const out = mergeFields(
      { firstName: 'Jane' } as any,
      { firstName: 'Janet' } as any,
      { source: 'emma_session' }
    );
    expect(out.firstName).toBe('Jane');
  });

  it('ignores undefined values in incoming', () => {
    const out = mergeFields(
      { firstName: 'Jane' } as any,
      { firstName: undefined, lastName: 'Doe' } as any,
      { source: 'manual' }
    );
    expect(out.firstName).toBe('Jane');
    expect(out.lastName).toBe('Doe');
  });
});

describe('syncContact — happy path', () => {
  it('logs event with normalised contactId', async () => {
    const { deps: eventsDb, store } = makeStubEventsDb();
    const result = await syncContact(baseInput(), { eventsDb });

    expect(result.contactId).toBe('jane@acme.com');
    expect(result.deduplicated).toBe(false);
    expect(result.created).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0].contactId).toBe('jane@acme.com');
    expect(store[0].sourceRecordId).toBe('user_1_signup');
  });

  it('enriches payload with resolved identity and company name', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const result = await syncContact(
      baseInput({
        identity: { email: 'jane@acme.com', firstName: 'Jane', linkedin: 'in/jane' },
        companyName: 'Acme Co',
      }),
      { eventsDb }
    );
    const payload = result.event.payload as any;
    expect(payload._identity.email).toBe('jane@acme.com');
    expect(payload._identity.domain).toBe('acme.com');
    expect(payload._identity.firstName).toBe('Jane');
    expect(payload._identity.linkedin).toBe('in/jane');
    expect(payload._companyName).toBe('Acme Co');
    expect(payload._provisional).toBe(false);
    expect(payload.plan).toBe('free');
  });

  it('propagates eventTimestamp and dealId when provided', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const ts = '2026-01-01T00:00:00.000Z';
    const result = await syncContact(
      baseInput({ eventTimestamp: ts, dealId: 'deal_1' }),
      { eventsDb }
    );
    expect(result.event.eventTimestamp).toBe(ts);
    expect(result.event.dealId).toBe('deal_1');
  });
});

describe('syncContact — idempotency', () => {
  it('replayed sourceRecordId returns original, no new event', async () => {
    const { deps: eventsDb, store } = makeStubEventsDb();
    await syncContact(baseInput(), { eventsDb });
    const second = await syncContact(baseInput(), { eventsDb });
    expect(store).toHaveLength(1);
    expect(second.deduplicated).toBe(true);
    expect(second.created).toBe(false);
  });

  it('short-circuits scorer recompute on replay', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const loadSignals = jest.fn();
    await syncContact(baseInput(), { eventsDb });
    await syncContact(baseInput(), { eventsDb, loadSignals });
    expect(loadSignals).not.toHaveBeenCalled();
  });
});

describe('syncContact — identity edge cases', () => {
  it('same email, different sources → same contactId', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const r1 = await syncContact(
      baseInput({
        source: 'signup',
        sourceRecordId: 'signup_1',
        identity: { email: 'Jane@Acme.com' },
      }),
      { eventsDb }
    );
    const r2 = await syncContact(
      baseInput({
        source: 'stripe',
        sourceRecordId: 'sub_123',
        identity: { email: 'jane@acme.com' },
        eventType: 'payment.subscribed',
      }),
      { eventsDb }
    );
    expect(r1.contactId).toBe(r2.contactId);
    expect(r1.contactId).toBe('jane@acme.com');
  });

  it('domain-only creates provisional, later email is separate event', async () => {
    const { deps: eventsDb, store } = makeStubEventsDb();
    const provisional = await syncContact(
      baseInput({
        sourceRecordId: 'form_1',
        identity: { domain: 'acme.com', firstName: 'Jane' },
      }),
      { eventsDb }
    );
    expect(provisional.contactId).toBe('nocontact:form_1');
    const full = await syncContact(
      baseInput({ sourceRecordId: 'form_2', identity: { email: 'jane@acme.com' } }),
      { eventsDb }
    );
    expect(full.contactId).toBe('jane@acme.com');
    expect(store).toHaveLength(2);
  });
});

describe('syncContact — validation', () => {
  it('missing source throws', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    await expect(
      syncContact({ ...baseInput(), source: undefined as any }, { eventsDb })
    ).rejects.toThrow(/source is required/);
  });

  it('missing eventType throws', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    await expect(
      syncContact({ ...baseInput(), eventType: undefined as any }, { eventsDb })
    ).rejects.toThrow(/eventType is required/);
  });

  it('missing sourceRecordId throws', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    await expect(
      syncContact({ ...baseInput(), sourceRecordId: '' }, { eventsDb })
    ).rejects.toThrow(/sourceRecordId is required/);
  });
});

describe('syncContact — score recompute', () => {
  it('computes heat/health/lifecycle when loadSignals is wired', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const loadSignals = async (): Promise<ContactSignalBundle> => ({
      heat: {
        hasUserRecord: true,
        hasActiveSubscription: true,
        isICP: true,
        contactStatus: 'active',
      },
      health: { subscriptionState: 'active', lastUsageAt: new Date().toISOString() },
      lifecycle: { subscriptionState: 'active', email: 'jane@acme.com' },
    });
    const persistScores = jest.fn(async () => {});
    const result = await syncContact(baseInput(), {
      eventsDb,
      loadSignals,
      persistScores,
    });
    expect(result.scores.heatScore).toBeGreaterThan(0);
    expect(result.scores.healthScore).toBeGreaterThan(0);
    expect(result.scores.lifecycle).toBe('paying');
    expect(persistScores).toHaveBeenCalledWith(result.contactId, result.scores);
  });

  it('returns zeroed snapshot when loadSignals is omitted', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const result = await syncContact(baseInput(), { eventsDb });
    expect(result.scores).toEqual({
      heatScore: 0,
      healthScore: 0,
      lifecycle: 'unknown',
    });
  });

  it('uses injected clock', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const loadSignals = async (): Promise<ContactSignalBundle> => ({
      heat: { lastEngagementAt: '2025-01-01T00:00:00.000Z' },
      health: {},
      lifecycle: { email: 'x@acme.com' },
    });
    const result = await syncContact(baseInput(), {
      eventsDb,
      loadSignals,
      now: () => new Date('2025-01-02T00:00:00.000Z'),
    });
    expect(result.scores.heatScore).toBe(15);
  });
});

describe('syncContact — tenantId propagation', () => {
  it('passes tenantId through to logEvent', async () => {
    const { deps: eventsDb, store } = makeStubEventsDb();
    await syncContact(
      baseInput({ tenantId: 'tenant-abc', sourceRecordId: 'su_1' }),
      { eventsDb, autoEnroll: async () => undefined }
    );
    expect(eventsDb.logEvent).toHaveBeenCalledTimes(1);
    expect((eventsDb.logEvent as jest.Mock).mock.calls[0][0].tenantId).toBe(
      'tenant-abc'
    );
    // Note: the stub doesn't persist tenantId onto the stored event, so just
    // assert the logEvent input — that's what the real contactEventsDb uses.
    expect(store).toHaveLength(1);
  });
});

describe('syncContact — signup auto-enroll hook', () => {
  it('fires autoEnroll on new signup events', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const autoEnroll = jest.fn(async () => undefined);
    await syncContact(baseInput({ sourceRecordId: 'signup_fresh' }), {
      eventsDb,
      autoEnroll,
    });
    expect(autoEnroll).toHaveBeenCalledTimes(1);
    const arg = autoEnroll.mock.calls[0][0] as any;
    expect(arg.input.source).toBe('signup');
    expect(arg.input.eventType).toBe('contact.created');
    expect(arg.result.deduplicated).toBe(false);
  });

  it('does NOT fire autoEnroll on non-signup events', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const autoEnroll = jest.fn(async () => undefined);
    await syncContact(
      baseInput({
        source: 'stripe',
        eventType: 'payment.subscribed',
        sourceRecordId: 'stripe_1',
      }),
      { eventsDb, autoEnroll }
    );
    expect(autoEnroll).not.toHaveBeenCalled();
  });

  it('does NOT fire autoEnroll on a deduplicated (replayed) signup', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const autoEnroll = jest.fn(async () => undefined);
    await syncContact(baseInput({ sourceRecordId: 'signup_dup' }), {
      eventsDb,
      autoEnroll,
    });
    await syncContact(baseInput({ sourceRecordId: 'signup_dup' }), {
      eventsDb,
      autoEnroll,
    });
    expect(autoEnroll).toHaveBeenCalledTimes(1);
  });

  it('swallows autoEnroll errors — signup never fails', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const autoEnroll = jest.fn(async () => {
      throw new Error('enroll blew up');
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await syncContact(baseInput({ sourceRecordId: 'signup_err' }), {
      eventsDb,
      autoEnroll,
    });
    expect(res.contactId).toBe('jane@acme.com');
    expect(res.deduplicated).toBe(false);
    errSpy.mockRestore();
  });
});

describe('syncContact — contactExists flag', () => {
  it('marks created=false when contact pre-existed', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const result = await syncContact(baseInput(), {
      eventsDb,
      contactExists: async () => true,
    });
    expect(result.created).toBe(false);
  });

  it('marks created=true when contact is new', async () => {
    const { deps: eventsDb } = makeStubEventsDb();
    const result = await syncContact(baseInput(), {
      eventsDb,
      contactExists: async () => false,
    });
    expect(result.created).toBe(true);
  });
});
