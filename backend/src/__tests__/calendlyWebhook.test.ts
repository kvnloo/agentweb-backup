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
const mockSetLeadFields = jest.fn();
const mockClaimLeadStepOnce = jest.fn();
const mockGetLeadListById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  crmDb: {
    createLeadList: (...a: any[]) => mockCreateLeadList(...a),
    getLeadByEmail: (...a: any[]) => mockGetLeadByEmail(...a),
    createLead: (...a: any[]) => mockCreateLead(...a),
    updateLead: (...a: any[]) => mockUpdateLead(...a),
    setLeadFields: (...a: any[]) => mockSetLeadFields(...a),
    claimLeadStepOnce: (...a: any[]) => mockClaimLeadStepOnce(...a),
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

// asyncJobQueue (ENG-524 fast-follow): defaults to 'enqueued' so every existing test
// below exercises the same inline-processing path it always did — the queue is a
// crash-safety net, not a behavior change to the common case. Queue-specific behavior
// (duplicate/unavailable) gets its own describe block further down.
const mockEnqueueJob = jest.fn();
const mockMarkJobComplete = jest.fn();
const mockMarkJobFailed = jest.fn();
const mockRegisterProcessor = jest.fn();
const mockStartHeartbeat = jest.fn((..._args: any[]) => jest.fn());
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: (...a: any[]) => mockEnqueueJob(...a),
  markJobComplete: (...a: any[]) => mockMarkJobComplete(...a),
  markJobFailed: (...a: any[]) => mockMarkJobFailed(...a),
  registerProcessor: (...a: any[]) => mockRegisterProcessor(...a),
  startHeartbeat: (...a: any[]) => mockStartHeartbeat(...a),
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
    mockSetLeadFields.mockResolvedValue(undefined);
    mockClaimLeadStepOnce.mockResolvedValue(true);
    mockAutoSyncLead.mockResolvedValue(undefined);
    mockCreateLeadList.mockResolvedValue({ listId: 'list-auto-created' });
    mockUpdateAccountConfig.mockResolvedValue(undefined);
    mockEnqueueJob.mockResolvedValue('enqueued');
    mockMarkJobComplete.mockResolvedValue(undefined);
    mockMarkJobFailed.mockResolvedValue(undefined);
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

  describe('async job queue integration (ENG-524 fast-follow, Greptile P1)', () => {
    it('enqueues before processing, with the resolved userId/accountId and the invitee URI as the dedupe key', async () => {
      const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-9/invitees/inv-9' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockEnqueueJob).toHaveBeenCalledWith(
        'calendly_webhook',
        'https://api.calendly.com/scheduled_events/evt-9/invitees/inv-9',
        expect.objectContaining({ userId: USER_ID, accountId: mockAccount.account_id, email: 'lead@example.com' }),
        { claimImmediately: true },
      );
    });

    it('marks the job complete after successful processing when it was actually enqueued', async () => {
      const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-10/invitees/inv-10' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockMarkJobComplete).toHaveBeenCalledWith('calendly_webhook', 'https://api.calendly.com/scheduled_events/evt-10/invitees/inv-10');
    });

    // Greptile P1 on #2291: without a heartbeat, inline processing slower than
    // the poller's stale threshold is indistinguishable from an abandoned claim.
    it('starts a heartbeat for the claim while processing, and stops it once processing settles', async () => {
      const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-30/invitees/inv-30' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockStartHeartbeat).toHaveBeenCalledWith('calendly_webhook', 'https://api.calendly.com/scheduled_events/evt-30/invitees/inv-30');
      const stopFn = mockStartHeartbeat.mock.results[0].value;
      expect(stopFn).toHaveBeenCalled();
    });

    it('does not start a heartbeat when the queue is unavailable (nothing was claimed)', async () => {
      mockEnqueueJob.mockResolvedValue('unavailable');
      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockStartHeartbeat).not.toHaveBeenCalled();
    });

    it('skips processing entirely when enqueueJob reports a duplicate', async () => {
      mockEnqueueJob.mockResolvedValue('duplicate');
      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
      expect(mockCreateLead).not.toHaveBeenCalled();
      expect(mockMarkJobComplete).not.toHaveBeenCalled();
    });

    it('retries the enqueue once when the first attempt reports unavailable, and processes durably if the retry succeeds', async () => {
      mockEnqueueJob.mockResolvedValueOnce('unavailable').mockResolvedValueOnce('enqueued');
      const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-31/invitees/inv-31' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
      expect(mockStartHeartbeat).toHaveBeenCalledWith('calendly_webhook', 'https://api.calendly.com/scheduled_events/evt-31/invitees/inv-31');
      expect(mockMarkJobComplete).toHaveBeenCalledWith('calendly_webhook', 'https://api.calendly.com/scheduled_events/evt-31/invitees/inv-31');
    });

    // Greptile P1 on #2291 (round 10/11): acking 200 immediately, THEN processing
    // fire-and-forget, meant a crash in that exact window silently lost the
    // booking's attribution/CRM-forward with nothing left to recover from once
    // there's also no durable queue row — the identical gap this entire feature
    // exists to close, just reopened for the "queue unavailable" branch. When the
    // queue is genuinely unavailable (even after the retry above), processing now
    // happens BEFORE the ack, so nothing is ever silently lost regardless of what
    // happens immediately after the response.
    it('processes synchronously (before acking) when the queue is unavailable even after retrying, and still returns 200 on success', async () => {
      mockEnqueueJob.mockResolvedValue('unavailable');
      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      // By the time postSigned's promise resolves, processing has ALREADY
      // happened — no flushPromises needed to observe it, since this path is
      // synchronous now (unlike the 'enqueued' fire-and-forget path above).
      expect(res.status).toBe(200);
      expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
      expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
      // No durable record was ever created for this delivery, so there's nothing
      // to mark complete or heartbeat — there's no row to keep fresh.
      expect(mockMarkJobComplete).not.toHaveBeenCalled();
      expect(mockStartHeartbeat).not.toHaveBeenCalled();
    });

    it('responds 500 (not a false 200) when the queue is unavailable and synchronous processing also fails, so Calendly can retry the delivery', async () => {
      mockEnqueueJob.mockResolvedValue('unavailable');
      // Outside any inner try/catch in processCalendlyWebhookJob (the owner lookup
      // that gates the whole function), so this always throws.
      mockGetUserById.mockRejectedValue(new Error('dynamo down'));
      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(500);
      // Still no durable row to update either way — this delivery's only path to
      // recovery now is Calendly redelivering after the non-200, which our
      // processing is already safe to run again (idempotent per-step/per-eventId).
      expect(mockMarkJobFailed).not.toHaveBeenCalled();
      expect(mockMarkJobComplete).not.toHaveBeenCalled();
    });

    it('marks the job failed (for the poller to retry) when processing throws and the job was enqueued', async () => {
      const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-11/invitees/inv-11' });

      // Outside any inner try/catch in processCalendlyWebhookJob (the owner lookup
      // that gates the whole function), so this always throws regardless of the
      // per-leg failure-aggregation covered below.
      mockGetUserById.mockRejectedValue(new Error('dynamo down'));

      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockMarkJobFailed).toHaveBeenCalledWith(
        'calendly_webhook',
        'https://api.calendly.com/scheduled_events/evt-11/invitees/inv-11',
        expect.any(Error),
      );
    });

    // Greptile P1 on #2291: each leg (CAPI, CRM-forward, HubSpot/Attio sync, lead
    // alert) used to catch its own errors and only log them, so processCalendlyWebhookJob
    // always resolved cleanly even when a leg genuinely failed — the caller saw success,
    // called markJobComplete, and the poller (which never retries 'completed' jobs) lost
    // that attribution/sync/alert forever. These verify a real failure in ANY leg now
    // surfaces as a thrown error, while an "expected skip" (no Meta pixel connected)
    // correctly does not.
    describe('leg-failure aggregation (Greptile P1 on #2291)', () => {
      it('marks the job failed when the CAPI leg genuinely fails, even though CRM-forward succeeds', async () => {
        mockSendCapiLeadEvent.mockRejectedValue(new Error('meta API down'));
        const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-20/invitees/inv-20' });

        const res = await postSigned(body);
        expect(res.status).toBe(200);
        await flushPromises();

        expect(mockCreateLead).toHaveBeenCalled(); // CRM-forward still ran and succeeded
        expect(mockMarkJobFailed).toHaveBeenCalledWith(
          'calendly_webhook',
          'https://api.calendly.com/scheduled_events/evt-20/invitees/inv-20',
          expect.any(Error),
        );
        expect(mockMarkJobComplete).not.toHaveBeenCalled();
      });

      // Greptile P1 on #2291 (round 3): sendCapiLeadEvent returns { success: false }
      // rather than throwing on a Meta-side failure — a different shape than the
      // thrown-error case above, and one the original failure-aggregation missed
      // entirely since it only looked at the catch block.
      it('marks the job failed when CAPI returns success:false (a soft failure, not a thrown error)', async () => {
        mockSendCapiLeadEvent.mockResolvedValue({ success: false, error: 'invalid pixel' });
        const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-25/invitees/inv-25' });

        const res = await postSigned(body);
        expect(res.status).toBe(200);
        await flushPromises();

        expect(mockMarkJobFailed).toHaveBeenCalledWith(
          'calendly_webhook',
          'https://api.calendly.com/scheduled_events/evt-25/invitees/inv-25',
          expect.any(Error),
        );
        expect(mockMarkJobComplete).not.toHaveBeenCalled();
      });

      it('marks the job failed when the CRM-forward leg genuinely fails, even though CAPI succeeds', async () => {
        mockGetLeadByEmail.mockRejectedValue(new Error('dynamo throttled'));
        const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-21/invitees/inv-21' });

        const res = await postSigned(body);
        expect(res.status).toBe(200);
        await flushPromises();

        expect(mockSendCapiLeadEvent).toHaveBeenCalled(); // CAPI leg still ran and succeeded
        expect(mockMarkJobFailed).toHaveBeenCalledWith(
          'calendly_webhook',
          'https://api.calendly.com/scheduled_events/evt-21/invitees/inv-21',
          expect.any(Error),
        );
        expect(mockMarkJobComplete).not.toHaveBeenCalled();
      });

      it('marks the job failed when the HubSpot sync fails, and still attempts the Attio sync', async () => {
        mockAutoSyncLead.mockImplementation((_userId, _listId, _lead, platform: string) =>
          platform === 'hubspot' ? Promise.reject(new Error('hubspot down')) : Promise.resolve(undefined),
        );
        const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-22/invitees/inv-22' });

        const res = await postSigned(body);
        expect(res.status).toBe(200);
        await flushPromises();

        expect(mockAutoSyncLead).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'hubspot', expect.anything());
        expect(mockAutoSyncLead).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'attio', expect.anything());
        expect(mockMarkJobFailed).toHaveBeenCalledWith(
          'calendly_webhook',
          'https://api.calendly.com/scheduled_events/evt-22/invitees/inv-22',
          expect.any(Error),
        );
      });

      it('marks the job failed when the lead alert fails', async () => {
        // 'list-1' is the id the shared getLeadListById mock resolves as an existing,
        // alert-configured list (see beforeEach) — needed so the alert branch is reached.
        const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
        mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });
        mockNotifyLeadListOwnerIfConfigured.mockRejectedValue(new Error('email service down'));
        const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-23/invitees/inv-23' });

        const res = await postSigned(body);
        expect(res.status).toBe(200);
        await flushPromises();

        expect(mockMarkJobFailed).toHaveBeenCalledWith(
          'calendly_webhook',
          'https://api.calendly.com/scheduled_events/evt-23/invitees/inv-23',
          expect.any(Error),
        );
      });

      it('marks the job complete (not failed) when Meta pixel is unresolved — an expected skip, not a failure', async () => {
        mockResolveMetaPixelForUser.mockResolvedValue({ unresolved: true, reason: 'No Meta ad account connected' });
        const body = makePayload({ email: 'lead@example.com', uri: 'https://api.calendly.com/scheduled_events/evt-24/invitees/inv-24' });

        const res = await postSigned(body);
        expect(res.status).toBe(200);
        await flushPromises();

        expect(mockMarkJobComplete).toHaveBeenCalledWith('calendly_webhook', 'https://api.calendly.com/scheduled_events/evt-24/invitees/inv-24');
        expect(mockMarkJobFailed).not.toHaveBeenCalled();
      });
    });
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
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', expect.objectContaining({ leadId: 'lead-new' }), 'hubspot', 'created');
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', expect.objectContaining({ leadId: 'lead-new' }), 'attio', 'created');
      // Each downstream step succeeded, so each writes its own completion marker via
      // crmDb.setLeadFields's atomic `system` sub-key SET, keyed by (step, booking
      // URI) — not customFields, and not a scalar shared across every booking this
      // lead ever gets (Greptile P1 on #2291, round 12) — this is what lets a later
      // retry recognize exactly which steps are already done for THIS booking
      // specifically, without a different booking's completion overwriting it.
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-new', {
        system: { [`hubspotSynced::${body.payload.uri}`]: { status: 'done' } },
      });
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-new', {
        system: { [`attioSynced::${body.payload.uri}`]: { status: 'done' } },
      });
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-new', {
        system: { [`alertSynced::${body.payload.uri}`]: { status: 'done' } },
      });
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
      // Greptile P1 on #2291 (round 9): only lastBookedAt/lastBookingUri are written —
      // NOT a full customFields snapshot including 'foo' — because crmDb.setLeadFields
      // SETs individual customFields sub-keys (`customFields.lastBookedAt = :v`) rather
      // than replacing the whole map, so a concurrent booking's own write to a
      // different key on this same lead can never be clobbered by this one.
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-existing', {
        customFields: { lastBookedAt: expect.any(String), lastBookingUri: expect.any(String) },
      });
      // The lead object passed downstream must still reflect what's ACTUALLY in the DB
      // (foo preserved, lastBookedAt/lastBookingUri now present) — built in-memory from
      // the pre-update snapshot plus exactly what was just written.
      expect(mockAutoSyncLead).toHaveBeenCalledWith(
        USER_ID,
        'list-1',
        expect.objectContaining({
          leadId: 'lead-existing',
          customFields: expect.objectContaining({ foo: 'bar', lastBookedAt: expect.any(String), lastBookingUri: expect.any(String) }),
        }),
        'hubspot',
        'updated',
      );
      expect(mockAutoSyncLead).toHaveBeenCalledWith(
        USER_ID,
        'list-1',
        expect.objectContaining({
          leadId: 'lead-existing',
          customFields: expect.objectContaining({ foo: 'bar', lastBookedAt: expect.any(String), lastBookingUri: expect.any(String) }),
        }),
        'attio',
        'updated',
      );
    });

    it('does not clobber concurrent state when a downstream step writes its own completion marker for an updated lead', async () => {
      const existingLead = { leadId: 'lead-existing', email: 'lead@example.com', customFields: { foo: 'bar' } };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      // Greptile P1 on #2291 (round 9 + round 12): the FIRST downstream marker
      // write used to re-serialize a full in-memory customFields snapshot under a
      // SCALAR key shared by every booking this lead ever gets, so a DIFFERENT
      // booking for this same lead completing concurrently would overwrite it.
      // Asserting the marker call's system payload contains ONLY the one
      // (step, booking URI) key being marked — not foo, not lastBookedAt, and
      // namespaced by this exact booking's URI — proves the write is a targeted
      // document-path SET that cannot touch any other key OR collide with a
      // different booking's own marker for the same step.
      const markerCall = mockSetLeadFields.mock.calls.find(
        (call) => call[2]?.system?.[`hubspotSynced::${body.payload.uri}`]?.status === 'done',
      );
      expect(markerCall).toBeDefined();
      expect(markerCall![2].system).toEqual({ [`hubspotSynced::${body.payload.uri}`]: { status: 'done' } });
    });

    // Greptile P1 (agentweb#2291): CAPI already dedupes redeliveries via Meta's own event_id
    // collapsing (see file header comment), but nothing protected the CRM-forward leg — a
    // redelivery of the same invitee.created event (e.g. our 200 response didn't reach
    // Calendly) would re-run updateLead, re-sync to HubSpot/Attio, and re-fire a customer
    // alert for a booking already fully processed.
    it('skips CRM-forward re-processing for a redelivery of an already fully-processed booking (matches lastBookingUri + every per-step marker)', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      const existingLead = {
        leadId: 'lead-existing',
        email: 'lead@example.com',
        customFields: { lastBookingUri: uri },
        system: {
          [`hubspotSynced::${uri}`]: { status: 'done' },
          [`attioSynced::${uri}`]: { status: 'done' },
          [`alertSynced::${uri}`]: { status: 'done' },
        },
      };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      // Default makePayload() uri is exactly 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1'.
      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLead).not.toHaveBeenCalled();
      expect(mockUpdateLead).not.toHaveBeenCalled();
      expect(mockSetLeadFields).not.toHaveBeenCalled();
      expect(mockAutoSyncLead).not.toHaveBeenCalled();
      expect(mockNotifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();
    });

    it('skips CRM-forward re-processing for a redelivery of the very first booking (matches bookingUri + every per-step marker, pre-update)', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      const existingLead = {
        leadId: 'lead-existing',
        email: 'lead@example.com',
        customFields: { bookingUri: uri },
        system: {
          [`hubspotSynced::${uri}`]: { status: 'done' },
          [`attioSynced::${uri}`]: { status: 'done' },
          [`alertSynced::${uri}`]: { status: 'done' },
        },
      };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLead).not.toHaveBeenCalled();
      expect(mockUpdateLead).not.toHaveBeenCalled();
      expect(mockSetLeadFields).not.toHaveBeenCalled();
      expect(mockAutoSyncLead).not.toHaveBeenCalled();
    });

    // Greptile P1 on #2291 (round 2): the lead mutation is idempotent (never repeated
    // once recorded), but the downstream steps are a SEPARATE question — a queue retry
    // after, say, a HubSpot outage must still re-attempt the sync even though the lead
    // record itself already reflects this booking from the failed first attempt.
    it('reuses the existing lead without re-updating it, but still retries the downstream sync/alert, when the lead was recorded but sync did not complete', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      const existingLead = {
        leadId: 'lead-existing',
        email: 'lead@example.com',
        customFields: { lastBookingUri: uri }, // recorded, but no syncCompletedUri — first attempt's downstream step failed
      };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockCreateLead).not.toHaveBeenCalled();
      // The lastBookedAt/lastBookingUri write must NOT repeat — the lead is reused as-is.
      expect(mockSetLeadFields).not.toHaveBeenCalledWith('list-1', 'lead-existing', expect.objectContaining({
        customFields: expect.objectContaining({ lastBookedAt: expect.anything() }),
      }));
      // But the downstream steps DO get retried.
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', existingLead, 'hubspot', 'updated');
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', existingLead, 'attio', 'updated');
      // And once each succeeds, its own marker gets written so a further retry
      // would correctly skip exactly that step.
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-existing', {
        system: { [`hubspotSynced::${uri}`]: { status: 'done' } },
      });
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-existing', {
        system: { [`attioSynced::${uri}`]: { status: 'done' } },
      });
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-existing', {
        system: { [`alertSynced::${uri}`]: { status: 'done' } },
      });
    });

    it('does not write a step\'s completion marker when that step still fails on retry, but does write the others that succeeded', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      const existingLead = {
        leadId: 'lead-existing',
        email: 'lead@example.com',
        customFields: { lastBookingUri: uri },
      };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });
      mockAutoSyncLead.mockImplementation((_userId, _listId, _lead, platform: string) =>
        platform === 'hubspot' ? Promise.reject(new Error('still down')) : Promise.resolve(undefined),
      );

      const body = makePayload({ email: 'lead@example.com', uri });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockSetLeadFields).not.toHaveBeenCalledWith('list-1', 'lead-existing', expect.objectContaining({
        system: expect.objectContaining({ [`hubspotSynced::${uri}`]: { status: 'done' } }),
      }));
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-existing', {
        system: { [`attioSynced::${uri}`]: { status: 'done' } },
      });
      expect(mockSetLeadFields).toHaveBeenCalledWith('list-1', 'lead-existing', {
        system: { [`alertSynced::${uri}`]: { status: 'done' } },
      });
      expect(mockMarkJobFailed).toHaveBeenCalledWith('calendly_webhook', uri, expect.any(Error));
    });

    // Greptile P1 on #2291 (round 3): a single combined completion marker meant that
    // if the alert succeeded but a LATER step (a sync) failed, the marker never got
    // set, and a retry — driven purely by that marker being unset — re-ran EVERYTHING,
    // including the alert that had already succeeded, sending the customer a second,
    // duplicate notification for the same booking.
    it('does not resend an already-successful alert when retrying a sync that failed alongside it', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      const existingLead = {
        leadId: 'lead-existing',
        email: 'lead@example.com',
        customFields: { lastBookingUri: uri },
        // alert already succeeded on the prior attempt; neither sync marker is set.
        system: { [`alertSynced::${uri}`]: { status: 'done' } },
      };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const body = makePayload({ email: 'lead@example.com', uri });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', existingLead, 'hubspot', 'updated');
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, 'list-1', existingLead, 'attio', 'updated');
      expect(mockNotifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();
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

    // Greptile P1 on #2291 (round 9 + round 12): two DIFFERENT bookings for the
    // SAME lead (matched by email) can be processed by two separate job
    // invocations that both read the lead before either has written anything
    // back — the classic concurrent-update race. Every setLeadFields call this
    // file's mocks record carries exactly the sub-key(s) that ONE booking's own
    // step owns; none ever repeats another booking's URI. That's true for BOTH
    // reasons this session hardened against: each write is a targeted
    // document-path SET rather than a full-map snapshot replace (round 9), AND
    // each step-marker's KEY ITSELF is namespaced by booking URI (round 12) —
    // so a different booking's completion can never even share the same key,
    // let alone overwrite it.
    it('two different bookings for the same lead never carry each other\'s data in their setLeadFields writes', async () => {
      const uriA = 'https://api.calendly.com/scheduled_events/evt-A/invitees/inv-A';
      const uriB = 'https://api.calendly.com/scheduled_events/evt-B/invitees/inv-B';
      // Both bookings' job invocations read this SAME pristine snapshot — never
      // mutated in place by the code under test — modeling two concurrent reads
      // that raced ahead of either one's write.
      const existingLead = { leadId: 'lead-shared', email: 'lead@example.com', customFields: {}, system: {} };
      mockGetLeadByEmail.mockResolvedValue(existingLead);
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });

      const resA = await postSigned(makePayload({ email: 'lead@example.com', uri: uriA }));
      expect(resA.status).toBe(200);
      await flushPromises();

      const resB = await postSigned(makePayload({ email: 'lead@example.com', uri: uriB }));
      expect(resB.status).toBe(200);
      await flushPromises();

      expect(mockSetLeadFields.mock.calls.length).toBeGreaterThan(0);
      for (const call of mockSetLeadFields.mock.calls) {
        const payload = call[2].customFields ?? call[2].system;
        const keys = Object.keys(payload);
        // The only multi-key write is the sibling lastBookedAt+lastBookingUri
        // pair for a single booking (customFields); every system step-marker
        // write is exactly one key.
        expect(keys.length === 1 || (keys.length === 2 && keys.includes('lastBookedAt') && keys.includes('lastBookingUri'))).toBe(true);
      }

      const serializedCalls = mockSetLeadFields.mock.calls.map((c) => JSON.stringify(c[2].customFields ?? c[2].system));
      const bookingACalls = serializedCalls.filter((s) => s.includes(uriA));
      const bookingBCalls = serializedCalls.filter((s) => s.includes(uriB));
      expect(bookingACalls.length).toBeGreaterThan(0);
      expect(bookingBCalls.length).toBeGreaterThan(0);
      // No call's payload ever names both bookings' URIs — proof no single write
      // could have clobbered the other booking's data even if it landed last.
      for (const serialized of serializedCalls) {
        expect(serialized.includes(uriA) && serialized.includes(uriB)).toBe(false);
      }
    });

    // Greptile P1 on #2291 (round 15): a stale-reclamation race in the async job
    // queue can, in the worst case, let two instances both start processing the
    // SAME booking concurrently. Both would pass the "not yet done" marker check,
    // so without a real mutex both would fire the actual side effect. Simulating
    // "lost the claim" via claimLeadStepOnce returning false proves the guarded
    // work is never even attempted when another run already holds it.
    it('does not call the external sync/alert when claimLeadStepOnce reports the step is already claimed by a concurrent run', async () => {
      mockClaimLeadStepOnce.mockResolvedValue(false);

      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockAutoSyncLead).not.toHaveBeenCalled();
      expect(mockNotifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();
      expect(mockSetLeadFields).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
        system: expect.anything(),
      }));
      // Losing a claim to a concurrent run is not a failure — nothing to retry.
      expect(mockMarkJobFailed).not.toHaveBeenCalled();
    });

    it('claims each step independently — losing the HubSpot claim does not block the Attio or alert steps from claiming and running', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      const accountWithList = { ...mockAccount, config: { ...mockAccount.config, booking_lead_list_id: 'list-1' } };
      mockGetAccountByCalendlyUserUri.mockResolvedValue({ userId: USER_ID, account: accountWithList });
      mockClaimLeadStepOnce.mockImplementation((_listId: string, _leadId: string, key: string) =>
        Promise.resolve(!key.startsWith('hubspotSynced::')),
      );

      const body = makePayload({ email: 'lead@example.com', uri });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockAutoSyncLead).not.toHaveBeenCalledWith(USER_ID, expect.anything(), expect.anything(), 'hubspot', expect.anything());
      expect(mockAutoSyncLead).toHaveBeenCalledWith(USER_ID, expect.anything(), expect.anything(), 'attio', expect.anything());
      expect(mockNotifyLeadListOwnerIfConfigured).toHaveBeenCalled();
    });

    it('releases the claim (so a future retry can re-attempt) when the guarded work fails after claiming it', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      mockAutoSyncLead.mockImplementation((_userId: string, _listId: string, _lead: any, platform: string) =>
        platform === 'hubspot' ? Promise.reject(new Error('hubspot down')) : Promise.resolve(undefined),
      );

      const body = makePayload({ email: 'lead@example.com', uri });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(mockClaimLeadStepOnce).toHaveBeenCalledWith(expect.anything(), expect.anything(), `hubspotSynced::${uri}`);
      expect(mockSetLeadFields).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        removeSystemKeys: [`hubspotSynced::${uri}`],
      });
      // The step never got marked "done" for this failed attempt.
      expect(mockSetLeadFields).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        system: { [`hubspotSynced::${uri}`]: { status: 'done' } },
      });
      expect(mockMarkJobFailed).toHaveBeenCalledWith('calendly_webhook', uri, expect.any(Error));
    });

    // Greptile P1 on #2291 (round 17): the release write above is itself best-effort.
    // If it fails too, the previous version just swallowed the error and moved on,
    // wedging the claim 'in_progress' forever — every future retry's claim attempt
    // would silently lose and skip the step, completing the job without ever
    // delivering the failed sync/alert. Retried once as the fast path; the real
    // backstop is claimLeadStepOnce's own staleness window (tested directly in
    // crm.db.test.ts), not infinite retries here.
    it('retries the claim release once, and logs loudly (does not silently swallow) if release fails twice', async () => {
      const uri = 'https://api.calendly.com/scheduled_events/evt-1/invitees/inv-1';
      mockAutoSyncLead.mockImplementation((_userId: string, _listId: string, _lead: any, platform: string) =>
        platform === 'hubspot' ? Promise.reject(new Error('hubspot down')) : Promise.resolve(undefined),
      );
      mockSetLeadFields.mockImplementation((_listId: string, _leadId: string, fields: any) => {
        if (fields.removeSystemKeys) return Promise.reject(new Error('dynamo down'));
        return Promise.resolve(undefined);
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const body = makePayload({ email: 'lead@example.com', uri });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      const releaseCalls = mockSetLeadFields.mock.calls.filter((c) => c[2]?.removeSystemKeys?.[0] === `hubspotSynced::${uri}`);
      expect(releaseCalls.length).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to release hubspot claim'),
        expect.anything(),
      );
      // The original sync failure is still what fails the job — the release
      // failure doesn't replace or hide it.
      expect(mockMarkJobFailed).toHaveBeenCalledWith('calendly_webhook', uri, expect.objectContaining({ message: expect.stringContaining('hubspot down') }));

      errorSpy.mockRestore();
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

    // ENG-924 groundwork: the real event_memberships shape for 2+ hosts has never been
    // observed live (only assumed to be "more entries, same per-entry shape" as the
    // verified single-host payload). Logging it the first time it actually happens in
    // production is cheap insurance against that assumption being wrong, without needing
    // a live multi-host test setup that isn't available right now.
    it('logs the raw payload when a delivery has more than one event_membership', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const body = multiHostPayload();
      body.payload.scheduled_event.event_memberships = [
        { user: HOST_A_URI, user_email: 'host-a@example.com', user_name: 'Host A' },
        { user: HOST_B_URI, user_email: 'host-b@example.com', user_name: 'Host B' },
      ];
      const res = await postSigned(body, HOST_A_KEY);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Multi-host event detected (2 members)'),
        expect.stringContaining(HOST_A_URI),
      );
      logSpy.mockRestore();
    });

    it('does not log a multi-host notice for an ordinary single-host delivery', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const body = makePayload({ email: 'lead@example.com' });
      const res = await postSigned(body);

      expect(res.status).toBe(200);
      await flushPromises();

      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Multi-host event detected'), expect.anything());
      logSpy.mockRestore();
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
        expect.objectContaining({ leadId: 'lead-existing' }),
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
