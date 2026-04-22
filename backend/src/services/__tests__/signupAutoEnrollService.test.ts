import {
  enrollSignupIntoFoundersList,
  FOUNDERS_USERID,
  FOUNDERS_SIGNUPS_LIST_NAME,
} from '../signupAutoEnrollService';
import type { AutoEnrollDeps } from '../signupAutoEnrollService';
import type { SyncInput, SyncResult } from '../contactSyncService';

function makeCrmDbStub(opts: { existingLists?: any[]; existingLead?: any } = {}) {
  const lists: any[] = opts.existingLists ? [...opts.existingLists] : [];
  const leads: any[] = [];

  const getLeadListsByUserId = jest.fn(async (userId: string) =>
    lists.filter(l => l.userId === userId)
  );
  const createLeadList = jest.fn(
    async (
      userId: string,
      name: string,
      _description?: string,
      _alertEvents?: string[],
      _listSenderId?: string | null,
      _autoDraftEnabled?: boolean,
      _autoDraftInstruction?: string,
      _autoSendEnabled?: boolean,
      _statusConfig?: any,
      listType?: string,
      isSystemManaged?: boolean
    ) => {
      const listId = `list_${lists.length + 1}`;
      const item = { listId, userId, name, listType, isSystemManaged: !!isSystemManaged };
      lists.push(item);
      return item;
    }
  );
  const getLeadByEmail = jest.fn(async (listId: string, email: string) => {
    if (opts.existingLead && opts.existingLead.listId === listId && opts.existingLead.email === email) {
      return opts.existingLead;
    }
    return leads.find(l => l.listId === listId && l.email === email) || null;
  });
  const createLead = jest.fn(async (listId: string, data: any) => {
    const lead = {
      listId,
      leadId: `lead_${leads.length + 1}`,
      ...data,
    };
    leads.push(lead);
    return lead;
  });

  // The real crmDb.createLeadList returns the full LeadList row shape (15+
  // fields). Stubbing that in full for every test would be noisy; we only care
  // about listId/userId/name/listType/isSystemManaged here, so cast through
  // unknown to the declared dep shape.
  const deps = {
    crmDb: { getLeadListsByUserId, createLeadList, getLeadByEmail, createLead },
    logger: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
  } as unknown as AutoEnrollDeps;

  return {
    deps,
    lists,
    leads,
    mocks: { getLeadListsByUserId, createLeadList, getLeadByEmail, createLead },
  };
}

function makeSignupCtx(overrides: Partial<SyncInput> = {}): {
  input: SyncInput;
  result: SyncResult;
} {
  const input: SyncInput = {
    source: 'signup',
    sourceRecordId: 'user-u_1',
    identity: {
      email: 'new@example.com',
      firstName: 'New',
      lastName: 'User',
    },
    eventType: 'contact.created',
    payload: {},
    ...overrides,
  };
  const result: SyncResult = {
    contactId: (input.identity.email || '').toLowerCase(),
    created: true,
    deduplicated: false,
    event: {
      contactId: (input.identity.email || '').toLowerCase(),
      eventTimestamp: '2026-04-13T00:00:00Z',
      eventId: 'evt_1',
      source: input.source,
      eventType: input.eventType,
      payload: {},
      sourceRecordId: input.sourceRecordId,
      createdAt: '2026-04-13T00:00:00Z',
    },
    scores: { heatScore: 0, healthScore: 0, lifecycle: 'unknown' },
  };
  return { input, result };
}

describe('enrollSignupIntoFoundersList', () => {
  it('creates the founders signups list on first signup, then enrols the lead', async () => {
    const { deps, mocks, lists, leads } = makeCrmDbStub();
    const outcome = await enrollSignupIntoFoundersList(makeSignupCtx(), deps);

    expect(outcome.enrolled).toBe(true);
    expect(outcome.reason).toBe('created');
    expect(mocks.createLeadList).toHaveBeenCalledTimes(1);
    expect(mocks.createLeadList).toHaveBeenCalledWith(
      FOUNDERS_USERID,
      FOUNDERS_SIGNUPS_LIST_NAME,
      expect.any(String),
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      'sales',
      true // isSystemManaged
    );
    expect(lists).toHaveLength(1);
    expect(lists[0].isSystemManaged).toBe(true);
    expect(leads).toHaveLength(1);
    expect(leads[0].email).toBe('new@example.com');
    expect(leads[0].tenantId).toBe(FOUNDERS_USERID);
    expect(leads[0].lifecycle).toBe('signed_up');
  });

  it('reuses existing founders signups list — does not create a duplicate', async () => {
    const existing = {
      listId: 'list_existing',
      userId: FOUNDERS_USERID,
      name: FOUNDERS_SIGNUPS_LIST_NAME,
    };
    const { deps, mocks, lists } = makeCrmDbStub({ existingLists: [existing] });
    const outcome = await enrollSignupIntoFoundersList(makeSignupCtx(), deps);

    expect(outcome.enrolled).toBe(true);
    expect(outcome.listId).toBe('list_existing');
    expect(mocks.createLeadList).not.toHaveBeenCalled();
    expect(lists).toHaveLength(1);
  });

  it('is idempotent — second signup with same email does not duplicate the lead', async () => {
    const existing = {
      listId: 'list_existing',
      userId: FOUNDERS_USERID,
      name: FOUNDERS_SIGNUPS_LIST_NAME,
    };
    const existingLead = {
      listId: 'list_existing',
      leadId: 'lead_already',
      email: 'returning@example.com',
    };
    const { deps, mocks, leads } = makeCrmDbStub({
      existingLists: [existing],
      existingLead,
    });

    const outcome = await enrollSignupIntoFoundersList(
      makeSignupCtx({ identity: { email: 'returning@example.com' } }),
      deps
    );

    expect(outcome.enrolled).toBe(false);
    expect(outcome.reason).toBe('already_in_list');
    expect(outcome.leadId).toBe('lead_already');
    expect(mocks.createLead).not.toHaveBeenCalled();
    expect(leads).toHaveLength(0);
  });

  it('skips non-signup events', async () => {
    const { deps, mocks } = makeCrmDbStub();
    const ctx = makeSignupCtx({
      source: 'stripe',
      eventType: 'payment.subscribed',
    });
    const outcome = await enrollSignupIntoFoundersList(ctx, deps);
    expect(outcome.enrolled).toBe(false);
    expect(outcome.reason).toBe('not_signup');
    expect(mocks.getLeadListsByUserId).not.toHaveBeenCalled();
  });

  it('skips deduplicated events (replay)', async () => {
    const { deps, mocks } = makeCrmDbStub();
    const ctx = makeSignupCtx();
    ctx.result.deduplicated = true;
    const outcome = await enrollSignupIntoFoundersList(ctx, deps);
    expect(outcome.enrolled).toBe(false);
    expect(outcome.reason).toBe('deduplicated_event');
    expect(mocks.getLeadListsByUserId).not.toHaveBeenCalled();
  });

  it('skips tenant-scoped signups (does NOT spill into founders list)', async () => {
    const { deps, mocks } = makeCrmDbStub();
    const ctx = makeSignupCtx({ tenantId: 'some-other-tenant-userid' });
    const outcome = await enrollSignupIntoFoundersList(ctx, deps);
    expect(outcome.enrolled).toBe(false);
    expect(outcome.reason).toBe('not_platform_scope');
    expect(mocks.getLeadListsByUserId).not.toHaveBeenCalled();
  });

  it('accepts tenantId === FOUNDERS_USERID as platform-scoped', async () => {
    const { deps } = makeCrmDbStub();
    const ctx = makeSignupCtx({ tenantId: FOUNDERS_USERID });
    const outcome = await enrollSignupIntoFoundersList(ctx, deps);
    expect(outcome.enrolled).toBe(true);
  });

  it('skips when email is missing', async () => {
    const { deps, mocks } = makeCrmDbStub();
    const ctx = makeSignupCtx({ identity: { email: '' } });
    const outcome = await enrollSignupIntoFoundersList(ctx, deps);
    expect(outcome.enrolled).toBe(false);
    expect(outcome.reason).toBe('no_email');
    expect(mocks.getLeadListsByUserId).not.toHaveBeenCalled();
  });

  it('swallows crmDb errors and returns reason=error', async () => {
    const deps = {
      crmDb: {
        getLeadListsByUserId: jest.fn(async () => {
          throw new Error('dynamo down');
        }),
        createLeadList: jest.fn(),
        getLeadByEmail: jest.fn(),
        createLead: jest.fn(),
      },
      logger: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
    };
    const outcome = await enrollSignupIntoFoundersList(
      makeSignupCtx(),
      deps as unknown as AutoEnrollDeps
    );
    expect(outcome.enrolled).toBe(false);
    expect(outcome.reason).toBe('error');
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('flattens attribution from payload.attribution into lead.customFields', async () => {
    const { deps, mocks } = makeCrmDbStub();
    const outcome = await enrollSignupIntoFoundersList(
      makeSignupCtx({
        payload: {
          signupDate: '2026-04-21T22:19:08Z',
          signupSource: 'password',
          userId: 'u_1',
          attribution: {
            timestamp: '2026-04-21T22:19:08Z',
            sessionId: 'sess_test',
            utm: { source: 'meta', medium: 'cpc', campaign: 'launch' },
            clickIds: { fbclid: 'fb_abc' },
            referrer: 'https://facebook.com/',
            landingUrl: 'http://app.example.com/register?utm_source=meta',
          },
        },
      }),
      deps
    );
    expect(outcome.enrolled).toBe(true);
    expect(outcome.reason).toBe('created');
    expect(mocks.createLead).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        email: 'new@example.com',
        lifecycle: 'signed_up',
        customFields: expect.objectContaining({
          utm_source: 'meta',
          utm_medium: 'cpc',
          utm_campaign: 'launch',
          fbclid: 'fb_abc',
          referrer: 'https://facebook.com/',
          landing_url: 'http://app.example.com/register?utm_source=meta',
        }),
      })
    );
  });

  it('omits customFields when payload has no attribution blob', async () => {
    const { deps, mocks } = makeCrmDbStub();
    await enrollSignupIntoFoundersList(makeSignupCtx({ payload: { userId: 'u_1' } }), deps);
    const createLeadArg = mocks.createLead.mock.calls[0][1];
    expect(createLeadArg.customFields).toBeUndefined();
  });

  it('partial attribution (utm.source only) passes through, missing keys are not written', async () => {
    const { deps, mocks } = makeCrmDbStub();
    await enrollSignupIntoFoundersList(
      makeSignupCtx({
        payload: {
          attribution: { timestamp: 't', sessionId: 's', utm: { source: 'google' } },
        },
      }),
      deps
    );
    const createLeadArg = mocks.createLead.mock.calls[0][1];
    expect(createLeadArg.customFields).toEqual({ utm_source: 'google' });
  });
});
