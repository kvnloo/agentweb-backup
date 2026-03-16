// @ts-nocheck
import { createHmac } from 'crypto';

// Mock AWS SDK before any imports
jest.mock('aws-sdk', () => {
  const mockDocClient = {
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    batchWrite: jest.fn(),
  };
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    S3: jest.fn(() => ({
      putObject: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn(),
    })),
    config: {
      update: jest.fn(),
    },
  };
});

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
  getGCSPPrivateKey: jest.fn(() => Promise.resolve('mock-private-key')),
  secretExists: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionTitle: jest.fn(),
    addMessage: jest.fn(),
    getChatSession: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn(() => Promise.resolve('gpt-4o')),
  },
}));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn() },
  taskDb: { getTaskById: jest.fn() },
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
  },
}));

jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(),
    verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(),
    generateEventId: jest.fn(),
  },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    eventExists: jest.fn(),
    addEmailEvent: jest.fn(),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyForEmailEvent: jest.fn(),
    notifyLeadListOwnerIfConfigured: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
    getReceivedEmailContent: jest.fn(),
  },
}));

jest.mock('../services/emmaEmailService', () => ({
  emmaEmailService: {
    isEmmaRelatedEvent: jest.fn(),
    isEmmaEmail: jest.fn(),
    processInboundEmail: jest.fn(),
  },
}));

// Mock fathomWebhookService module
jest.mock('../services/fathomWebhookService', () => {
  const actual = jest.requireActual('../services/fathomWebhookService');
  return {
    ...actual,
    fathomWebhookService: {
      verifySignature: jest.fn(),
      parseMeetingPayload: jest.fn(() => ({
        title: 'Test Meeting',
        recordingId: 123,
        recordingUrl: 'https://fathom.video/recording/123',
        scheduledStart: '2026-03-16T10:00:00Z',
        recordingStart: '2026-03-16T10:00:00Z',
        recordingEnd: '2026-03-16T10:30:00Z',
        summary: 'Test summary',
        actionItems: [],
        participants: [{ name: 'Test', email: 'test@agentweb.pro', domain: 'agentweb.pro', isExternal: false }],
        transcript: [],
      })),
      createEmmaSession: jest.fn(() => Promise.resolve('session-123')),
    },
  };
});

import express from 'express';
import request from 'supertest';
import webhookRouter from '../routes/webhooks';
import { fathomWebhookService } from '../services/fathomWebhookService';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', webhookRouter);
  return app;
}

describe('POST /api/webhooks/fathom', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  it('should return 200 when signature is valid', async () => {
    (fathomWebhookService.verifySignature as jest.Mock).mockImplementation(() => {
      // no-op = verification passes
    });

    const res = await request(app)
      .post('/api/webhooks/fathom')
      .set('webhook-id', 'msg_123')
      .set('webhook-timestamp', '1234567890')
      .set('webhook-signature', 'v1,valid')
      .send({ title: 'Test Meeting', recording_id: 123 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Webhook received');
  });

  it('should return 401 when signature is invalid', async () => {
    (fathomWebhookService.verifySignature as jest.Mock).mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    const res = await request(app)
      .post('/api/webhooks/fathom')
      .set('webhook-id', 'msg_123')
      .set('webhook-timestamp', '1234567890')
      .set('webhook-signature', 'v1,bad')
      .send({ title: 'Test Meeting', recording_id: 123 });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Webhook signature verification failed');
  });

  it('should return 200 even for payloads that will fail async processing', async () => {
    (fathomWebhookService.verifySignature as jest.Mock).mockImplementation(() => {
      // passes
    });
    (fathomWebhookService.parseMeetingPayload as jest.Mock).mockImplementation(() => {
      throw new Error('Parse error');
    });

    const res = await request(app)
      .post('/api/webhooks/fathom')
      .set('webhook-id', 'msg_123')
      .set('webhook-timestamp', '1234567890')
      .set('webhook-signature', 'v1,valid')
      .send({ bad: 'payload' });

    // Still returns 200 because fire-and-forget
    expect(res.status).toBe(200);
  });

  it('should pass webhook headers to verifySignature', async () => {
    (fathomWebhookService.verifySignature as jest.Mock).mockImplementation(() => {});

    await request(app)
      .post('/api/webhooks/fathom')
      .set('webhook-id', 'msg_abc')
      .set('webhook-timestamp', '9999999999')
      .set('webhook-signature', 'v1,sig')
      .send({ title: 'Test' });

    expect(fathomWebhookService.verifySignature).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        'webhook-id': 'msg_abc',
        'webhook-timestamp': '9999999999',
        'webhook-signature': 'v1,sig',
      })
    );
  });
});
