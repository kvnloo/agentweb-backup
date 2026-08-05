/**
 * Tests for the Calendly booking webhook receiver
 * POST /api/webhooks/calendly
 *
 * Covers:
 *  - Fire-and-forget (immediate 200 response, same pattern as the HubSpot receiver)
 *  - Signature verification (missing header / mismatch)
 *  - user_uri → account resolution (unknown user_uri is dropped, not errored)
 *  - Meta pixel resolution (unresolved → logged, no CAPI call, no throw)
 *  - Success: valid signature + resolvable pixel → sendCapiLeadEvent called once
 */

import request from 'supertest';
import express from 'express';
import * as crypto from 'crypto';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetAccountByCalendlyUserUri = jest.fn();
const mockUpdateAccountConfig = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountByCalendlyUserUri: (...a: any[]) => mockGetAccountByCalendlyUserUri(...a),
  updateAccountConfig: (...a: any[]) => mockUpdateAccountConfig(...a),
}));

const mockGetUserById = jest.fn();
const mockCreateLeadList = jest.fn();
const mockGetLeadByEmail = jest.fn();
const mockCreateLead = jest.fn();
const mockUpdateLead = jest.fn();
const mockGetLeadListById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  crmDb: {
    createLeadList: (...a: any[]) => mockCreateLeadList(...a),
    getLeadByEmail: (...a: any[]) => mockGetLeadByEmail(...a),
    createLead: (...a: any[]) => mockCreateLead(...a),
    updateLead: (...a: any[]) => mockUpdateLead(...a),
    getLeadListById: (...a: any[]) => mockGetLeadListById(...a),
  },
}));

const mockResolveMetaPixelForUser = jest.fn();
const mockSendCapiLeadEvent = jest.fn();
jest.mock('../services/metaService', () => ({
  metaService: {
    resolveMetaPixelForUser: (...a: any[]) => mockResolveMetaPixelForUser(...a),
    sendCapiLeadEvent: (...a: any[]) => mockSendCapiLeadEvent(...a),
  },
}));

const mockGetMetaAccountCredentials = jest.fn();
jest.mock('../services/metaAccountCredentials', () => ({
  getMetaAccountCredentials: (...a: any[]) => mockGetMetaAccountCredentials(...a),
}));

const mockAutoSyncLead = jest.fn();
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    autoSyncLead: (...a: any[]) => mockAutoSyncLead(...a),
  },
}));

const mockNotifyLeadListOwnerIfConfigured = jest.fn();
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLeadListOwnerIfConfigured: (...a: any[]) => mockNotifyLeadListOwnerIfConfigured(...a),
  },
}));

// ─── App setup ───────────────────────────────────────────────────────────────

import calendlyWebhookRouter from '../routes/calendlyWebhook';

const app = express();
app.use('/api/webhooks/calendly', express.raw({ type: 'application/json' }));
app.use('/api/webhooks/calendly', calendlyWebhookRouter);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SIGNING_KEY = 'test-signing-key-abc123';
const USER_URI = 'https://api.calendly.com/users/target-user';

function makeSignature(rawBody: string, timestamp: number, signingKey: string): string {
  const hmac = crypto.createHmac('sha256', signingKey).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

function makePayload(overrides: Partial<{ email: string; name: string; uri: string }> = {}) {
  return {
    created_at: '2026-08-05T09:48:59.000000Z',
    event: 'invitee.created',
    payload: {
      email: overrides.email ?? 'invitee@example.com',
      name: overrides.name ?? 'Test Invitee',
      first_name: null,
      last_name: null,
      created_at: '2026-08-05T09:48:59.074035Z',
      uri: overrides.uri ?? 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1',
      scheduled_event: {
        uri: 'https://api.calendly.com/scheduled_events/evt-1',
        event_memberships: [
          { user: USER_URI, user_email: 'host@example.com', user_name: 'Host' },
        ],
      },
    },
  };
}

/** Drains the microtask queue so fire-and-forget async handlers complete before assertions. */
function flushPromises(): Promise<void> {
  return new Promise(setImmediate as unknown as (resolve: () => void) => void);
}

async function postSigned(body: object, signingKey: string = SIGNING_KEY) {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = makeSignature(rawBody, timestamp, signingKey);
  return request(app)
    .post('/api/webhooks/calendly')
    .set('Content-Type', 'application/json')
    .set('calendly-webhook-signature', signature)
    .send(rawBody);
}

const USER_ID = 'user-abc';
const mockAccount = {
  platform: 'calendly',
  account_id: 'host@example.com',
  account_name: 'Host',
  config: {
    account_type: 'calendly',
    access_token: 'calendly-token',
    token_expires_at: 9999999999999,
    user_uri: USER_URI,
    organization_uri: 'https://api.calendly.com/organizations/org-1',
    booking_tracking_active: true,
    webhook_signing_key: SIGNING_KEY,
  },
};
const mockOwner = { userId: USER_ID, email: 'host@example.com' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/calendly — booking webhook receiver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: mockAccount });
    mockGetUserById.mockResolvedValue(mockOwner);
    mockResolveMetaPixelForUser.mockResolvedValue({ pixelId: 'pixel-1', accountId: 'act-1' });
    mockGetMetaAccountCredentials.mockResolvedValue({ accountId: 'act-1', accessToken: 'meta-token', accountName: 'Ad Account' });
    mockSendCapiLeadEvent.mockResolvedValue({ success: true, fbtraceId: 'trace-1' });
    mockGetLeadByEmail.mockResolvedValue(null);
    mockCreateLead.mockResolvedValue({ leadId: 'lead-1', email: 'lead@example.com' });
    mockUpdateLead.mockResolvedValue(undefined);
    mockAutoSyncLead.mockResolvedValue(undefined);
    mockCreateLeadList.mockResolvedValue({ listId: 'list-auto-created' });
    mockUpdateAccountConfig.mockResolvedValue(undefined);
    // getLeadListById serves two callers: resolveOrCreateBookingList's deterministic-ID
    // lookup (should see "not found" by default, so the fallback-create path exercises
    // naturally) and the CRM-forward leg's "fetch full list for the alert" lookup on an
    // explicit list-1 id. Keep them distinct rather than one blanket resolved value.
    mockGetLeadListById.mockImplementation((id: string) =>
      Promise.resolve(id === 'list-1' ? { listId: 'list-1', userId: USER_ID, name: 'Test List', alertEvents: ['api.lead_added', 'api.lead_updated'] } : null),
    );
    mockNotifyLeadListOwnerIfConfigured.mockResolvedValue(undefined);
  });

  it('returns 200 immediately without a signature header, and does not call CAPI', async () => {
    const body = makePayload();
    const rawBody = JSON.stringify(body);
    const res = await request(app)
      .post('/api/webhooks/calendly')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(200);
    await flushPromises();
    expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
  });

  it('returns 200 but does not call CAPI when the signature does not match', async () => {
    const body = makePayload();
    const res = await postSigned(body, 'wrong-signing-key');

    expect(res.status).toBe(200);
    await flushPromises();
    expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
  });

  it('returns 200 but does not call CAPI when no account matches the payload user_uri', async () => {
    mockGetAccountByCalendlyUserUri.mockResolvedValue(null);
    const body = makePayload();
    const res = await postSigned(body);

    expect(res.status).toBe(200);
    await flushPromises();
    expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
  });

  it('does not call CAPI (and does not throw) when the Meta pixel cannot be resolved', async () => {
    mockResolveMetaPixelForUser.mockResolvedValue({ unresolved: true, reason: 'No Meta ad account connected' });
    const body = makePayload();
    const res = await postSigned(body);

    expect(res.status).toBe(200);
    await flushPromises();
    expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
  });

  it('calls sendCapiLeadEvent with the invitee URI as eventId on a valid, resolvable delivery', async () => {
    const body = makePayload({ email: 'lead@example.com', name: 'Jane Doe', uri: 'https://api.calendly.com/scheduled_events/evt-2/invitees/inv-2' });
    const res = await postSigned(body);

    expect(res.status).toBe(200);
    await flushPromises();

    expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
    const [pixelId, accessToken, event] = mockSendCapiLeadEvent.mock.calls[0];
    expect(pixelId).toBe('pixel-1');
    expect(accessToken).toBe('meta-token');
    expect(event.eventId).toBe('https://api.calendly.com/scheduled_events/evt-2/invitees/inv-2');
    expect(event.email).toBe('lead@example.com');
  });

  it('sends "Schedule" as the CAPI event name, not the default "Lead" (PRD §6 step 3, matches ENG-522)', async () => {
    const body = makePayload({ email: 'lead@example.com' });
    const res = await postSigned(body);

    expect(res.status).toBe(200);
    await flushPromises();

    expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
    const [, , event] = mockSendCapiLeadEvent.mock.calls[0];
    expect(event.eventName).toBe('Schedule');
  });

  describe('CRM-forward', () => {
    it('uses the explicitly configured booking_lead_list_id when the list still exists, skipping fallback resolution', async () => {
      // 'list-1' is the id the shared getLeadListById mock resolves as existing (see beforeEach).
      const accountWithList = {
        ...mockAccount,
        config: { ...mockAccount.config, booking_lead_list_id: 'list-1' },
      };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLeadList).not.toHaveBeenCalled();
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
      expect(mockCreateLead).toHaveBeenCalledWith('list-1', expect.objectContaining({ email: 'lead@example.com' }));
    });

    it('falls back to resolveOrCreateBookingList when the explicitly configured list no longer exists (gap 2)', async () => {
      // 'list-deleted' isn't 'list-1', so the shared getLeadListById mock resolves it as
      // not-found — simulating a list the customer picked, then later deleted.
      const accountWithList = {
        ...mockAccount,
        config: { ...mockAccount.config, booking_lead_list_id: 'list-deleted' },
      };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });
      mockCreateLeadList.mockResolvedValue({ listId: 'list-fresh' });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockGetLeadListById).toHaveBeenCalledWith('list-deleted');
      expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
      expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
        USER_ID, 'calendly', mockAccount.account_id, { booking_lead_list_id: 'list-fresh' },
      );
      expect(mockCreateLead).toHaveBeenCalledWith('list-fresh', expect.objectContaining({ email: 'lead@example.com' }));
    });

    // Confirmed live: crmDb.createLead's list-metadata update has no attribute_exists
    // guard, so writing a lead against a deleted listId partially RESURRECTS a ghost
    // record there — fieldNames/leadCount/listId/updatedAt only, no userId or name.
    // A naive truthiness check on getLeadListById's result is fooled by this ghost
    // and never falls back. Must check ownership (userId), not just existence.
    it('falls back to resolveOrCreateBookingList when the configured list is a userId-less ghost record', async () => {
      const accountWithList = {
        ...mockAccount,
        config: { ...mockAccount.config, booking_lead_list_id: 'list-ghost' },
      };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });
      mockGetLeadListById.mockImplementation((id: string) => {
        if (id === 'list-1') return Promise.resolve({ listId: 'list-1', userId: USER_ID, name: 'Test List', alertEvents: ['api.lead_added', 'api.lead_updated'] });
        if (id === 'list-ghost') return Promise.resolve({ listId: 'list-ghost', fieldNames: [], leadCount: 1, updatedAt: '2026-01-01T00:00:00Z' }); // no userId, no name
        return Promise.resolve(null);
      });
      mockCreateLeadList.mockResolvedValue({ listId: 'list-fresh' });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
      expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
        USER_ID, 'calendly', mockAccount.account_id, { booking_lead_list_id: 'list-fresh' },
      );
      expect(mockCreateLead).toHaveBeenCalledWith('list-fresh', expect.objectContaining({ email: 'lead@example.com' }));
    });

    it('falls back to resolveOrCreateBookingList and persists the result when no list is configured', async () => {
      mockCreateLeadList.mockResolvedValue({ listId: 'list-auto-created' });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
      expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
        USER_ID, 'calendly', mockAccount.account_id, { booking_lead_list_id: 'list-auto-created' },
      );
      expect(mockCreateLead).toHaveBeenCalledWith('list-auto-created', expect.objectContaining({ email: 'lead@example.com' }));
    });

    it('creates a new lead and auto-syncs as "created" when no existing lead matches the email', async () => {
      mockGetLeadByEmail.mockResolvedValue(null);
      mockCreateLead.mockResolvedValue({ leadId: 'lead-new', email: 'lead@example.com' });
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLead).toHaveBeenCalledTimes(1);
      expect(mockUpdateLead).not.toHaveBeenCalled();
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', expect.objectContaining({ leadId: 'lead-new' }), 'hubspot', 'created');
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', expect.objectContaining({ leadId: 'lead-new' }), 'attio', 'created');
    });

    it('updates the existing lead and auto-syncs as "updated" when a lead with that email already exists', async () => {
      const existingLead = { leadId: 'lead-existing', email: 'lead@example.com', customFields: { foo: 'bar' } };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLead).not.toHaveBeenCalled();
      expect(mockUpdateLead).toHaveBeenCalledWith('list-1', 'lead-existing', expect.objectContaining({
        customFields: expect.objectContaining({ foo: 'bar' }),
      }));
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', existingLead, 'hubspot', 'updated');
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', existingLead, 'attio', 'updated');
    });

    it('still sends the CAPI event when the CRM-forward leg throws', async () => {
      mockGetLeadListById.mockRejectedValue(new Error('crm down'));
      mockCreateLeadList.mockRejectedValue(new Error('crm down'));

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
    });

    it('still runs CRM-forward when the Meta pixel cannot be resolved', async () => {
      mockResolveMetaPixelForUser.mockResolvedValue({ unresolved: true, reason: 'No Meta ad account connected' });
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
      expect(mockCreateLead).toHaveBeenCalledTimes(1);
    });
  });

  describe('Multi-host event resolution', () => {
    // Each customer's webhook subscription is scope:'user' (calendlyAuth.ts), so when 2+
    // hosts on the same event are each independently connected to AgentWeb, Calendly sends
    // a SEPARATE delivery per subscription — same payload, but signed with THAT host's own
    // webhook_signing_key. Resolution must find the specific membership whose account's key
    // actually verifies this delivery, not just the first connected account in array order.
    const HOST_A_URI = 'https://api.calendly.com/users/host-a';
    const HOST_B_URI = 'https://api.calendly.com/users/host-b';
    const HOST_A_KEY = 'signing-key-host-a';
    const HOST_B_KEY = 'signing-key-host-b';
    const USER_ID_A = 'user-host-a';
    const USER_ID_B = 'user-host-b';

    const accountA = {
      ...mockAccount,
      account_id: 'acct-host-a',
      config: { ...mockAccount.config, user_uri: HOST_A_URI, webhook_signing_key: HOST_A_KEY },
    };
    const accountB = {
      ...mockAccount,
      account_id: 'acct-host-b',
      config: { ...mockAccount.config, user_uri: HOST_B_URI, webhook_signing_key: HOST_B_KEY },
    };
    const ownerA = { userId: USER_ID_A, email: 'host-a@example.com' };
    const ownerB = { userId: USER_ID_B, email: 'host-b@example.com' };

    function multiHostPayload() {
      return makePayload({ email: 'lead@example.com' }) as any;
    }

    beforeEach(() => {
      mockGetAccountByCalendlyUserUri.mockImplementation((uri: string) => {
        if (uri === HOST_A_URI) return Promise.resolve({ userId: USER_ID_A, account: accountA });
        if (uri === HOST_B_URI) return Promise.resolve({ userId: USER_ID_B, account: accountB });
        return Promise.resolve(null);
      });
      mockGetUserById.mockImplementation((id: string) => {
        if (id === USER_ID_A) return Promise.resolve(ownerA);
        if (id === USER_ID_B) return Promise.resolve(ownerB);
        return Promise.resolve(null);
      });
    });

    it('resolves to the SECOND host when the delivery is signed with the second (not first-listed) host\'s key', async () => {
      const body = multiHostPayload();
      body.payload.scheduled_event.event_memberships = [
        { user: HOST_A_URI, user_email: 'host-a@example.com', user_name: 'Host A' },
        { user: HOST_B_URI, user_email: 'host-b@example.com', user_name: 'Host B' },
      ];
      const res = await postSigned(body, HOST_B_KEY);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockGetUserById).toHaveBeenCalledWith(USER_ID_B);
      expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
    });

    it('resolves to the FIRST host when the delivery is signed with the first-listed host\'s key', async () => {
      const body = multiHostPayload();
      body.payload.scheduled_event.event_memberships = [
        { user: HOST_A_URI, user_email: 'host-a@example.com', user_name: 'Host A' },
        { user: HOST_B_URI, user_email: 'host-b@example.com', user_name: 'Host B' },
      ];
      const res = await postSigned(body, HOST_A_KEY);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockGetUserById).toHaveBeenCalledWith(USER_ID_A);
      expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
    });

    it('resolves to the one connected host among several unconnected members, regardless of position', async () => {
      const body = multiHostPayload();
      body.payload.scheduled_event.event_memberships = [
        { user: 'https://api.calendly.com/users/unconnected-1', user_email: 'x@example.com', user_name: 'X' },
        { user: HOST_B_URI, user_email: 'host-b@example.com', user_name: 'Host B' },
        { user: 'https://api.calendly.com/users/unconnected-2', user_email: 'y@example.com', user_name: 'Y' },
      ];
      const res = await postSigned(body, HOST_B_KEY);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockGetUserById).toHaveBeenCalledWith(USER_ID_B);
      expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
    });

    it('drops the delivery when the signature matches none of the connected hosts\' keys', async () => {
      const body = multiHostPayload();
      body.payload.scheduled_event.event_memberships = [
        { user: HOST_A_URI, user_email: 'host-a@example.com', user_name: 'Host A' },
        { user: HOST_B_URI, user_email: 'host-b@example.com', user_name: 'Host B' },
      ];
      const res = await postSigned(body, 'some-unrelated-key');

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockGetUserById).not.toHaveBeenCalled();
      expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
    });
  });

  describe('Lead-added/updated alert (gap 4)', () => {
    it('fires an api.lead_added alert when a new lead is created', async () => {
      mockGetLeadByEmail.mockResolvedValue(null);
      const createdLead = { leadId: 'lead-new', email: 'lead@example.com' };
      mockCreateLead.mockResolvedValue(createdLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockNotifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
        expect.objectContaining({ listId: 'list-1' }),
        createdLead,
        'api.lead_added',
        expect.any(Object),
        expect.any(String),
      );
    });

    it('fires an api.lead_updated alert when an existing lead is updated', async () => {
      const existingLead = { leadId: 'lead-existing', email: 'lead@example.com', customFields: {} };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockNotifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
        expect.objectContaining({ listId: 'list-1' }),
        existingLead,
        'api.lead_updated',
        expect.any(Object),
        expect.any(String),
      );
    });

    it('does not throw and still completes the CRM-forward leg when the alert call fails', async () => {
      mockNotifyLeadListOwnerIfConfigured.mockRejectedValue(new Error('email service down'));
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLead).toHaveBeenCalledTimes(1);
      expect(mockAutoSyncLead).toHaveBeenCalled();
    });
  });
});
