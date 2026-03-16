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
}));

import {
  FathomWebhookService,
  FathomMeetingPayload,
} from '../services/fathomWebhookService';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateSessionResponse } from '../controllers/agentModeController';

const WEBHOOK_SECRET = 'whsec_testSecretForTesting1234567890abc';

function generateSvixSignature(
  payload: string,
  secret: string,
  messageId: string,
  timestamp: string
): string {
  // Svix uses base64-decoded secret (after stripping "whsec_" prefix)
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const toSign = `${messageId}.${timestamp}.${payload}`;
  const signature = createHmac('sha256', secretBytes)
    .update(toSign)
    .digest('base64');
  return `v1,${signature}`;
}

const samplePayload: FathomMeetingPayload = {
  title: 'Weekly Standup',
  recording_id: 12345,
  url: 'https://fathom.video/recording/12345',
  scheduled_start_time: '2026-03-16T10:00:00Z',
  recording_start_time: '2026-03-16T10:02:00Z',
  recording_end_time: '2026-03-16T10:30:00Z',
  calendar_invitees: [
    { name: 'Harsha', email: 'harsha@agentweb.pro', domain: 'agentweb.pro', is_external: false },
    { name: 'Rui', email: 'rui@agentweb.pro', domain: 'agentweb.pro', is_external: false },
  ],
  default_summary: {
    template_name: 'Default',
    markdown_formatted: '## Summary\n\nDiscussed sprint priorities and Fathom integration.',
  },
  action_items: [
    {
      description: 'Build Fathom webhook endpoint',
      is_completed: false,
      timestamp: '00:05:23',
      assignee: { name: 'Harsha', email: 'harsha@agentweb.pro' },
    },
  ],
  transcript: [
    {
      speaker: { display_name: 'Harsha', matched_email: 'harsha@agentweb.pro' },
      text: 'Let\'s discuss the Fathom integration.',
      timestamp: '00:00:10',
    },
    {
      speaker: { display_name: 'Rui', matched_email: 'rui@agentweb.pro' },
      text: 'Sounds good, I\'ll handle the security review.',
      timestamp: '00:00:25',
    },
  ],
};

describe('FathomWebhookService', () => {
  let service: FathomWebhookService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FATHOM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    service = new FathomWebhookService();
  });

  afterEach(() => {
    delete process.env.FATHOM_WEBHOOK_SECRET;
  });

  // --- Signature verification tests ---

  describe('verifySignature', () => {
    it('should accept a valid Svix signature', () => {
      const payload = JSON.stringify(samplePayload);
      const messageId = 'msg_test123';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = generateSvixSignature(payload, WEBHOOK_SECRET, messageId, timestamp);

      const headers = {
        'webhook-id': messageId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      };

      expect(() => service.verifySignature(payload, headers)).not.toThrow();
    });

    it('should reject an invalid signature with an error', () => {
      const payload = JSON.stringify(samplePayload);
      const messageId = 'msg_test123';
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const headers = {
        'webhook-id': messageId,
        'webhook-timestamp': timestamp,
        'webhook-signature': 'v1,invalidSignatureHere',
      };

      expect(() => service.verifySignature(payload, headers)).toThrow();
    });

    it('should reject when webhook-id header is missing', () => {
      const payload = JSON.stringify(samplePayload);
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const headers = {
        'webhook-timestamp': timestamp,
        'webhook-signature': 'v1,anything',
      };

      expect(() => service.verifySignature(payload, headers)).toThrow();
    });

    it('should reject when FATHOM_WEBHOOK_SECRET is not set', () => {
      delete process.env.FATHOM_WEBHOOK_SECRET;
      const freshService = new FathomWebhookService();
      const payload = JSON.stringify(samplePayload);

      const headers = {
        'webhook-id': 'msg_test123',
        'webhook-timestamp': Math.floor(Date.now() / 1000).toString(),
        'webhook-signature': 'v1,anything',
      };

      expect(() => freshService.verifySignature(payload, headers)).toThrow(
        /FATHOM_WEBHOOK_SECRET/
      );
    });
  });

  // --- Payload parsing tests ---

  describe('parseMeetingPayload', () => {
    it('should extract title, summary, action items, and participants', () => {
      const result = service.parseMeetingPayload(samplePayload);

      expect(result.title).toBe('Weekly Standup');
      expect(result.summary).toContain('Discussed sprint priorities');
      expect(result.actionItems).toHaveLength(1);
      expect(result.actionItems[0].description).toBe('Build Fathom webhook endpoint');
      expect(result.actionItems[0].assignee?.email).toBe('harsha@agentweb.pro');
      expect(result.participants).toHaveLength(2);
      expect(result.participants[0].email).toBe('harsha@agentweb.pro');
      expect(result.recordingId).toBe(12345);
      expect(result.recordingUrl).toBe('https://fathom.video/recording/12345');
    });

    it('should handle missing optional fields gracefully', () => {
      const minimalPayload: FathomMeetingPayload = {
        title: 'Quick Call',
        recording_id: 99,
        url: 'https://fathom.video/recording/99',
        scheduled_start_time: '2026-03-16T10:00:00Z',
        recording_start_time: '2026-03-16T10:00:00Z',
        recording_end_time: '2026-03-16T10:05:00Z',
        calendar_invitees: [],
        default_summary: { template_name: 'Default', markdown_formatted: '' },
        action_items: [],
        transcript: [],
      };

      const result = service.parseMeetingPayload(minimalPayload);

      expect(result.title).toBe('Quick Call');
      expect(result.summary).toBe('');
      expect(result.actionItems).toEqual([]);
      expect(result.participants).toEqual([]);
      expect(result.transcript).toEqual([]);
    });

    it('should include full transcript data', () => {
      const result = service.parseMeetingPayload(samplePayload);

      expect(result.transcript).toHaveLength(2);
      expect(result.transcript[0].speaker).toBe('Harsha');
      expect(result.transcript[0].text).toContain('Fathom integration');
      expect(result.transcript[1].speaker).toBe('Rui');
    });
  });

  // --- Emma session creation tests ---

  describe('createEmmaSession', () => {
    const mockSessionId = 'test-session-id-1234';

    beforeEach(() => {
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
      });
      (chatbotDb.updateSessionLlmModel as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
      (chatbotDb.addMessage as jest.Mock).mockResolvedValue(undefined);
      (agentModeService.getDefaultModel as jest.Mock).mockResolvedValue('gpt-4o');
      (generateSessionResponse as jest.Mock).mockResolvedValue({
        content: 'Meeting processed successfully.',
      });
    });

    it('should create a chat session with correct portal type and session type', async () => {
      const parsed = service.parseMeetingPayload(samplePayload);
      await service.createEmmaSession(parsed, 'user-123');

      expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
        'user-123',
        undefined,
        'agent',
        'agent-mode',
        undefined,
        undefined,
        undefined,
        undefined,
        'meeting-intake',
        undefined
      );
    });

    it('should set the session title to the meeting title', async () => {
      const parsed = service.parseMeetingPayload(samplePayload);
      await service.createEmmaSession(parsed, 'user-123');

      expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith(
        mockSessionId,
        'Meeting: Weekly Standup'
      );
    });

    it('should send the meeting data as the first message', async () => {
      const parsed = service.parseMeetingPayload(samplePayload);
      await service.createEmmaSession(parsed, 'user-123');

      expect(generateSessionResponse).toHaveBeenCalledWith(
        mockSessionId,
        expect.stringContaining('Weekly Standup'),
        'user-123',
        'gpt-4o',
        undefined
      );

      // The message should include summary and action items
      const sentMessage = (generateSessionResponse as jest.Mock).mock.calls[0][1];
      expect(sentMessage).toContain('Discussed sprint priorities');
      expect(sentMessage).toContain('Build Fathom webhook endpoint');
      expect(sentMessage).toContain('harsha@agentweb.pro');
    });

    it('should return the session ID', async () => {
      const parsed = service.parseMeetingPayload(samplePayload);
      const result = await service.createEmmaSession(parsed, 'user-123');

      expect(result).toBe(mockSessionId);
    });
  });

  // --- Format message tests ---

  describe('formatMeetingMessage', () => {
    it('should format all sections into a coherent message', () => {
      const parsed = service.parseMeetingPayload(samplePayload);
      const message = service.formatMeetingMessage(parsed);

      // Should contain key sections
      expect(message).toContain('Weekly Standup');
      expect(message).toContain('Summary');
      expect(message).toContain('Discussed sprint priorities');
      expect(message).toContain('Action Items');
      expect(message).toContain('Build Fathom webhook endpoint');
      expect(message).toContain('Participants');
      expect(message).toContain('Harsha');
      expect(message).toContain('Rui');
      expect(message).toContain('Transcript');
    });

    it('should omit empty sections', () => {
      const parsed = service.parseMeetingPayload({
        title: 'Quick Call',
        recording_id: 99,
        url: 'https://fathom.video/recording/99',
        scheduled_start_time: '2026-03-16T10:00:00Z',
        recording_start_time: '2026-03-16T10:00:00Z',
        recording_end_time: '2026-03-16T10:05:00Z',
        calendar_invitees: [],
        default_summary: { template_name: 'Default', markdown_formatted: '' },
        action_items: [],
        transcript: [],
      });
      const message = service.formatMeetingMessage(parsed);

      expect(message).toContain('Quick Call');
      expect(message).not.toContain('Action Items');
      expect(message).not.toContain('Transcript');
    });
  });
});
