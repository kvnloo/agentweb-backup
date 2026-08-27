/**
 * Tests for the shared Attio OAuth webhook handler
 * POST /api/webhooks/attio (ENG-1380 webhook follow-up)
 *
 * Covers:
 *  - Fire-and-forget (immediate 200 response)
 *  - X-Hook-Secret handshake echo
 *  - Signature verification (HMAC-SHA256, Attio-Signature header)
 *  - Multi-tenant workspace resolution (unknown workspace → no processing)
 *  - Dedup via Idempotency-Key
 *  - Demux across every list bound to the matched workspace, respecting webhookEnabled
 *  - record.* routed to applyAttioPersonEvent, list-entry.* routed to AttioAdapter
 *
 * applyAttioPersonEvent's and AttioAdapter.applyListEntryWebhookEvent's own
 * internal logic (echo-suppression, field mapping, etc.) is covered by their
 * own dedicated test files — this file mocks both as black boxes and only
 * asserts they're invoked correctly.
 */

import request from 'supertest';
import express from 'express';
import * as crypto from 'crypto';

// ─── Mocks (mirrors webhooks.hubspot.test.ts's proven harness) ────────────────

jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../services/webhookService', () => ({
  webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn().mockResolvedValue(false), createEvent: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() } }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/emmaEmailService', () => ({ emmaEmailService: { isEmmaRelatedEvent: jest.fn().mockReturnValue(false) } }));
jest.mock('../utils/leadContactStatus', () => ({ isDoNotContact: jest.fn().mockReturnValue(false) }));

const mockGetLeadListsByUserId = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: (...a: any[]) => mockGetLeadListsByUserId(...a),
    getLeadListById: jest.fn(),
  },
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() },
  tempEmailDb: { getTempEmail: jest.fn() },
}));

const mockGetUserIdByHubSpotPortalId = jest.fn();
const mockGetAccountsByAttioWorkspaceId = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getUserIdByHubSpotPortalId: (...a: any[]) => mockGetUserIdByHubSpotPortalId(...a),
  getAccountsByAttioWorkspaceId: (...a: any[]) => mockGetAccountsByAttioWorkspaceId(...a),
}));

const mockGetSyncConfig = jest.fn();
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    getConfig: (...a: any[]) => mockGetSyncConfig(...a),
  },
}));

jest.mock('../services/hubspotService', () => ({
  HubSpotService: { create: jest.fn() },
}));

const mockAttioServiceCreate = jest.fn();
jest.mock('../services/attioService', () => ({
  AttioService: {
    create: (...a: any[]) => mockAttioServiceCreate(...a),
  },
}));

const mockApplyAttioPersonEvent = jest.fn();
jest.mock('../utils/attioPersonWebhookEvent', () => ({
  applyAttioPersonEvent: (...a: any[]) => mockApplyAttioPersonEvent(...a),
}));

const mockApplyListEntryWebhookEvent = jest.fn();
jest.mock('../services/adapters/attioAdapter', () => ({
  AttioAdapter: jest.fn().mockImplementation(() => ({
    applyListEntryWebhookEvent: (...a: any[]) => mockApplyListEntryWebhookEvent(...a),
  })),
}));

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

jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientSecret: 'x' }),
  getHubSpotClientSecretForAppId: jest.fn().mockResolvedValue('x'),
  getAttioConfig: jest.fn().mockResolvedValue({ clientId: 'our-client-id' }),
}));

// ─── App setup ───────────────────────────────────────────────────────────────

import webhookRouter from '../routes/webhooks';

const app = express();
app.use('/api/webhooks/attio', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SIGNING_KEY = 'test-signing-key';

function makeSignature(body: any, key = SIGNING_KEY): string {
  return crypto.createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');
}

/** Drains the microtask queue so fire-and-forget async handlers complete before assertions. */
function flushPromises(): Promise<void> {
  return new Promise(setImmediate as unknown as (resolve: () => void) => void);
}

const WORKSPACE_ID = 'ws-abc';
const ACCOUNT_ID = 'attio-acct-1';
const USER_ID = 'user-1';
const LIST_ID = 'list-1';

const mockAccount = {
  userId: USER_ID,
  account: {
    platform: 'attio',
    account_id: ACCOUNT_ID,
    account_name: 'Test Workspace',
    config: { workspace_id: WORKSPACE_ID, webhook_signing_key: SIGNING_KEY },
  },
};

const mockList = {
  listId: LIST_ID,
  userId: USER_ID,
  externalCrmSyncConfigs: { attio: { accountId: ACCOUNT_ID } },
};

describe('POST /api/webhooks/attio — shared OAuth webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccountsByAttioWorkspaceId.mockResolvedValue([mockAccount]);
    mockAttioServiceCreate.mockResolvedValue({});
    mockGetLeadListsByUserId.mockResolvedValue([mockList]);
    mockGetSyncConfig.mockResolvedValue({ webhookEnabled: true, dealFieldMapping: [] });
    mockEnqueueJob.mockResolvedValue('enqueued');
    mockMarkJobComplete.mockResolvedValue(undefined);
    mockMarkJobFailed.mockResolvedValue(undefined);
    mockApplyAttioPersonEvent.mockResolvedValue(undefined);
    mockApplyListEntryWebhookEvent.mockResolvedValue(undefined);
  });

  it('returns 200 immediately (fire-and-forget) even before processing', async () => {
    const body = { event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, record_id: 'rec-1' } };
    const res = await request(app)
      .post('/api/webhooks/attio')
      .set('attio-signature', makeSignature(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('echoes X-Hook-Secret back for the webhook-URL verification handshake, without processing', async () => {
    const res = await request(app)
      .post('/api/webhooks/attio')
      .set('x-hook-secret', 'handshake-secret')
      .send({});
    expect(res.status).toBe(200);
    expect(res.headers['x-hook-secret']).toBe('handshake-secret');
    await flushPromises();
    expect(mockGetAccountsByAttioWorkspaceId).not.toHaveBeenCalled();
  });

  it('ignores a delivery with no workspace_id', async () => {
    const body = { event_type: 'record.updated', id: { record_id: 'rec-1' } };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body)).send(body);
    await flushPromises();
    expect(mockGetAccountsByAttioWorkspaceId).not.toHaveBeenCalled();
  });

  // Regression guard for a real bug caught live (ENG-1380): the actual Attio
  // delivery wraps events in { webhook_id, events: [...] }, with workspace_id
  // nested on each individual event's `id` — not the flat single-event shape
  // used in the other tests here (which happens to fall back to treating the
  // whole body as one event). A genuine live delivery from Attio, captured
  // via ngrok's inspector, looked exactly like this.
  it('extracts workspace_id from a real Attio delivery shape ({ webhook_id, events: [...] })', async () => {
    const body = {
      webhook_id: 'e7835cb9-f729-42d2-811e-4a9e7428d139',
      events: [
        {
          event_type: 'record.updated',
          id: { workspace_id: WORKSPACE_ID, object_id: 'obj-1', record_id: 'rec-1', attribute_id: 'attr-1' },
          actor: { type: 'workspace-member', id: 'human-1' },
        },
      ],
    };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body)).send(body);
    await flushPromises();

    expect(mockGetAccountsByAttioWorkspaceId).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(mockApplyAttioPersonEvent).toHaveBeenCalledWith(
      LIST_ID,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ event_type: 'record.updated' }),
    );
  });

  it('caps an oversized delivery at 200 events rather than processing an unbounded fan-out', async () => {
    const body = {
      webhook_id: 'wh-1',
      events: Array.from({ length: 300 }, (_, i) => ({
        event_type: 'record.updated',
        id: { workspace_id: WORKSPACE_ID, object_id: 'obj-1', record_id: `rec-${i}` },
        actor: { type: 'workspace-member', id: 'human-1' },
      })),
    };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body)).send(body);
    await flushPromises();

    expect(mockApplyAttioPersonEvent).toHaveBeenCalledTimes(200);
  });

  it('ignores a delivery for an unknown workspace (no connected account)', async () => {
    mockGetAccountsByAttioWorkspaceId.mockResolvedValue([]);
    const body = { event_type: 'record.updated', id: { workspace_id: 'unknown-ws', record_id: 'rec-1' } };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body, 'irrelevant')).send(body);
    await flushPromises();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('rejects a delivery whose signature does not verify against any candidate account', async () => {
    const body = { event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, record_id: 'rec-1' } };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body, 'wrong-key')).send(body);
    await flushPromises();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('processes a valid, correctly-signed delivery: record.* routed to applyAttioPersonEvent', async () => {
    const body = { event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, record_id: 'rec-1' } };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body)).send(body);
    await flushPromises();

    expect(mockEnqueueJob).toHaveBeenCalled();
    expect(mockApplyAttioPersonEvent).toHaveBeenCalledWith(LIST_ID, expect.objectContaining({ webhookEnabled: true }), expect.anything(), expect.objectContaining({ event_type: 'record.updated' }));
  });

  it('processes list-entry.* events by routing to AttioAdapter.applyListEntryWebhookEvent', async () => {
    const body = { event_type: 'list-entry.updated', id: { workspace_id: WORKSPACE_ID, entry_id: 'entry-1' } };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body)).send(body);
    await flushPromises();

    expect(mockApplyListEntryWebhookEvent).toHaveBeenCalledWith(
      LIST_ID,
      expect.objectContaining({ webhookEnabled: true }),
      expect.anything(),
      'entry-1',
      'list-entry.updated',
    );
  });

  it('skips lists with webhookEnabled explicitly false', async () => {
    mockGetSyncConfig.mockResolvedValue({ webhookEnabled: false, dealFieldMapping: [] });
    const body = { event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, record_id: 'rec-1' } };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body)).send(body);
    await flushPromises();
    expect(mockApplyAttioPersonEvent).not.toHaveBeenCalled();
  });

  it('demuxes across every list bound to the matched account', async () => {
    const secondList = { listId: 'list-2', userId: USER_ID, externalCrmSyncConfigs: { attio: { accountId: ACCOUNT_ID } } };
    const unrelatedList = { listId: 'list-3', userId: USER_ID, externalCrmSyncConfigs: { attio: { accountId: 'other-account' } } };
    mockGetLeadListsByUserId.mockResolvedValue([mockList, secondList, unrelatedList]);

    const body = { event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, record_id: 'rec-1' } };
    await request(app).post('/api/webhooks/attio').set('attio-signature', makeSignature(body)).send(body);
    await flushPromises();

    const processedListIds = mockApplyAttioPersonEvent.mock.calls.map((c) => c[0]);
    expect(processedListIds.sort()).toEqual(['list-1', 'list-2']); // not list-3 (different account)
  });

  it('deduplicates a redelivery via Idempotency-Key', async () => {
    const body = { event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, record_id: 'rec-1' } };
    mockEnqueueJob.mockResolvedValueOnce('duplicate');
    await request(app)
      .post('/api/webhooks/attio')
      .set('attio-signature', makeSignature(body))
      .set('idempotency-key', 'delivery-1')
      .send(body);
    await flushPromises();

    expect(mockEnqueueJob).toHaveBeenCalledWith('attio_webhook', 'delivery-1', expect.anything(), expect.anything());
    expect(mockApplyAttioPersonEvent).not.toHaveBeenCalled();
  });
});
