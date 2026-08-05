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
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountByCalendlyUserUri: (...a: any[]) => mockGetAccountByCalendlyUserUri(...a),
}));

const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
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
});
