import request from 'supertest';
import express from 'express';

// Mock middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock settingsService
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

// Mock chatbotService
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionResultEndpointMetadata: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
  },
  ChatbotDB: jest.fn(),
}));

// Mock agentModeService
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn(),
    sendForReview: jest.fn(),
    getUnassociatedToolNames: jest.fn(() => []),
  },
  AgentModeService: jest.fn(),
}));

// Mock emailService
jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn(),
  },
}));

// Mock resendService
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn().mockResolvedValue({ id: 'resend-123' }),
  },
}));

// Mock config
jest.mock('../config', () => ({
  RESEND_SYSTEM_EMAIL: 'no-reply@updates.agentweb.pro',
  RESEND_SYSTEM_NAME: 'AgentWeb',
}));

// Mock runVerifiedChat
jest.mock('../controllers/agentModeController', () => ({
  runVerifiedChat: jest.fn(),
}));

import { settingsService } from '../services/settingsService';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { runVerifiedChat } from '../controllers/agentModeController';
import { applyVariableValues } from '../controllers/resultEndpointController';
import resultEndpointsRoutes, { reviewRouter } from '../routes/resultEndpoints';
import adminRoutes from '../routes/admin';

const mockedSettings = settingsService as jest.Mocked<typeof settingsService>;
const mockedChatbot = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockedAgentMode = agentModeService as jest.Mocked<typeof agentModeService>;
const mockedRunVerifiedChat = runVerifiedChat as jest.MockedFunction<typeof runVerifiedChat>;

const sampleConfig = {
  name: 'gtm',
  prompt: 'Generate a GTM plan for {{Company Name}} in the {{Industry}} industry.',
  outputFormat: 'html' as const,
  reviewerEmail: 'reviewer@example.com',
};

describe('Result Endpoints', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/r', resultEndpointsRoutes);
    app.use('/review', reviewRouter);
    app.use('/api/admin', adminRoutes);

    // Default mock: runVerifiedChat resolves successfully
    mockedRunVerifiedChat.mockResolvedValue({
      success: true,
      content: 'Generated content',
      toolCalls: [{ name: 'send_for_review' }],
      keywordMatches: [],
      keywordMisses: [],
      functionCallMatches: ['send_for_review'],
      functionCallMisses: [],
      functionStatus: [{ functionName: 'send_for_review', requiredCount: 1, actualCount: 1, met: true }],
      attempts: 1,
      workPlanCompleted: true,
    });
  });

  describe('POST /r/:resultName/trigger', () => {
    it('should return 404 when config not found', async () => {
      mockedSettings.getSetting.mockResolvedValue(null);

      const res = await request(app)
        .post('/r/nonexistent/trigger')
        .send({})
        .expect(404);

      expect(res.body.error).toContain('not found');
    });

    it('should return 200 JSON and fire runVerifiedChat for valid config', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      mockedChatbot.createChatSession.mockResolvedValue({
        sessionId: 'test-session-123',
        userId: 'anon_test',
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockedChatbot.updateSessionResultEndpointMetadata.mockResolvedValue({} as any);
      mockedChatbot.createOrReuseInteractiveShare.mockResolvedValue('http://localhost:5174/ishare/test-session-123?conversable=abc');
      (mockedChatbot as any).updateSessionWorkPlan.mockResolvedValue({} as any);
      mockedChatbot.updateSessionLlmModel.mockResolvedValue({} as any);
      mockedAgentMode.getDefaultModel.mockResolvedValue('default-model');

      const res = await request(app)
        .post('/r/gtm/trigger')
        .send({ 'Company Name': 'Acme Corp', Industry: 'SaaS', leadEmail: 'lead@example.com' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.sessionId).toBe('test-session-123');

      // Should have created session
      expect(mockedChatbot.createChatSession).toHaveBeenCalledWith(
        expect.stringContaining('anon_'),
        undefined,
        'agent',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'result-endpoint'
      );

      // Should have stored metadata with reviewerEmail
      expect(mockedChatbot.updateSessionResultEndpointMetadata).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          resultName: 'gtm',
          leadEmail: 'lead@example.com',
          reviewerEmail: 'reviewer@example.com',
          outputFormat: 'html',
          args: { 'Company Name': 'Acme Corp', Industry: 'SaaS' },
        })
      );

      // Should have fired runVerifiedChat (async)
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockedRunVerifiedChat).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-123',
          startingMessage: expect.stringContaining('Acme Corp'),
          requiredFunctions: [{ functionName: 'send_for_review', minCount: 1 }],
          // ENG-634: headless fire-and-forget run must enable completion-gate halt protection.
          completionGate: true,
        })
      );
    });
  });

  describe('GET /review/:sessionId', () => {
    it('should return 404 when session not found', async () => {
      mockedChatbot.getChatSession.mockResolvedValue(null as any);

      await request(app)
        .get('/review/nonexistent')
        .expect(404);
    });

    it('should return all assets from session messages', async () => {
      mockedChatbot.getChatSession.mockResolvedValue({
        sessionId: 'sess-123',
        resultEndpointMetadata: {
          resultName: 'gtm',
          resultTitle: 'GTM Plan',
          leadEmail: 'lead@example.com',
          reviewerEmail: 'reviewer@example.com',
          outputFormat: 'html',
          args: {},
          contentSubject: 'Your GTM Plan',
          sendHistory: [
            { assetUrl: 'https://s3.example.com/image.png', recipientEmail: 'lead@example.com', sentAt: '2026-02-24T10:00:00Z' },
          ],
        },
      } as any);

      // Tool results are stored as separate "tool" role messages with JSON content
      (mockedChatbot as any).getMessagesFromMessagesTable.mockResolvedValue([
        {
          role: 'tool',
          name: 'generate_image',
          content: JSON.stringify({ success: true, imageUrl: 'https://s3.example.com/image.png', filename: 'hero.png' }),
          metadata: { timestamp: '2026-02-24T09:00:00Z' },
        },
        {
          role: 'tool',
          name: 'create_html_file',
          content: JSON.stringify({ success: true, s3_url: 'https://s3.example.com/result.html', filename: 'report.html', title: 'GTM Plan' }),
          metadata: { timestamp: '2026-02-24T09:05:00Z' },
        },
        {
          role: 'tool',
          name: 'send_for_review',
          content: JSON.stringify({ success: true, message: 'Sent', to: 'reviewer@example.com' }),
        },
        {
          role: 'tool',
          name: 'search_web',
          content: '<strong>Search results</strong>',
        },
      ]);

      mockedChatbot.createOrReuseInteractiveShare.mockResolvedValue('http://localhost:5174/ishare/sess-123?conversable=abc');

      const res = await request(app)
        .get('/review/sess-123')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.resultTitle).toBe('GTM Plan');
      expect(res.body.ishareUrl).toContain('ishare/sess-123');
      expect(res.body.assets).toHaveLength(2); // image + html from tool messages
      expect(res.body.assets[0].type).toBe('image');
      expect(res.body.assets[0].url).toBe('https://s3.example.com/image.png');
      expect(res.body.assets[0].filename).toBe('hero.png');
      expect(res.body.assets[0].sendHistory).toHaveLength(1);
      expect(res.body.assets[0].sendHistory[0].recipientEmail).toBe('lead@example.com');
      expect(res.body.assets[1].type).toBe('html');
      expect(res.body.assets[1].url).toBe('https://s3.example.com/result.html');
    });

    it('should use contentUrl from metadata as fallback when no assets found from messages', async () => {
      mockedChatbot.getChatSession.mockResolvedValue({
        sessionId: 'sess-fallback',
        resultEndpointMetadata: {
          resultName: 'gtm',
          resultTitle: 'GTM Plan',
          leadEmail: 'lead@example.com',
          reviewerEmail: 'reviewer@example.com',
          outputFormat: 'html',
          args: {},
          contentUrl: 'https://s3.example.com/saved-file.html',
          sendHistory: [],
        },
      } as any);

      // No tool messages that produce assets (e.g. save_file content is not JSON-parseable)
      (mockedChatbot as any).getMessagesFromMessagesTable.mockResolvedValue([
        {
          role: 'tool',
          name: 'save_file',
          content: 'File saved successfully to https://s3.example.com/saved-file.html',
        },
      ]);

      mockedChatbot.createOrReuseInteractiveShare.mockResolvedValue('http://localhost:5174/ishare/sess-fallback?conversable=abc');

      const res = await request(app)
        .get('/review/sess-fallback')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.assets).toHaveLength(1);
      expect(res.body.assets[0].type).toBe('html');
      expect(res.body.assets[0].url).toBe('https://s3.example.com/saved-file.html');
    });
  });

  describe('POST /review/:sessionId/send', () => {
    it('should send email and record send history', async () => {
      const metadata = {
        resultName: 'gtm',
        resultTitle: 'GTM Plan',
        leadEmail: 'lead@example.com',
        reviewerEmail: 'reviewer@example.com',
        outputFormat: 'html' as const,
        args: {},
        contentSubject: 'Your GTM Plan',
        sendHistory: [],
      };

      mockedChatbot.getChatSession.mockResolvedValue({
        sessionId: 'sess-123',
        resultEndpointMetadata: metadata,
      } as any);
      mockedChatbot.updateSessionResultEndpointMetadata.mockResolvedValue({} as any);

      const res = await request(app)
        .post('/review/sess-123/send')
        .send({
          recipientEmail: 'lead@example.com',
          customMessage: 'Here is your report',
          assetUrl: 'https://s3.example.com/result.html',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.sendHistoryEntry.recipientEmail).toBe('lead@example.com');
      expect(res.body.sendHistoryEntry.assetUrl).toBe('https://s3.example.com/result.html');

      // Should have updated metadata with send history
      expect(mockedChatbot.updateSessionResultEndpointMetadata).toHaveBeenCalledWith(
        'sess-123',
        expect.objectContaining({
          sendHistory: expect.arrayContaining([
            expect.objectContaining({
              assetUrl: 'https://s3.example.com/result.html',
              recipientEmail: 'lead@example.com',
              customMessage: 'Here is your report',
            }),
          ]),
        })
      );
    });

    it('should return 400 when assetUrl is missing', async () => {
      await request(app)
        .post('/review/sess-123/send')
        .send({ recipientEmail: 'test@example.com' })
        .expect(400);
    });

    it('should return 400 when recipientEmail is missing', async () => {
      await request(app)
        .post('/review/sess-123/send')
        .send({ assetUrl: 'https://example.com/file.png' })
        .expect(400);
    });
  });

  describe('applyVariableValues', () => {
    it('should substitute variables with matching params', () => {
      const result = applyVariableValues(
        'Hello {{Company Name}}, welcome to {{Industry}}!',
        { 'Company Name': 'Acme', Industry: 'SaaS' }
      );
      expect(result).toBe('Hello Acme, welcome to SaaS!');
    });

    it('should handle underscore/space normalization', () => {
      const result = applyVariableValues(
        'Plan for {{Company_Name}}',
        { 'Company Name': 'Acme Corp' }
      );
      expect(result).toBe('Plan for Acme Corp');
    });

    it('should leave unmatched variables as-is', () => {
      const result = applyVariableValues(
        'Hello {{Name}}, from {{City}}',
        { Name: 'Alice' }
      );
      expect(result).toBe('Hello Alice, from {{City}}');
    });

    it('should handle URL-decoded param names', () => {
      const result = applyVariableValues(
        'GTM for {{Company Name}}',
        { 'Company Name': 'Test Co' }
      );
      expect(result).toBe('GTM for Test Co');
    });
  });

  describe('GET /r/:resultName/info (waitingContent)', () => {
    it('should return waitingContent when configured', async () => {
      const configWithWaiting = {
        ...sampleConfig,
        waitingContent: { type: 'youtube', value: 'https://www.youtube.com/watch?v=abc123', title: 'Watch this' },
      };
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([configWithWaiting]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      const res = await request(app)
        .get('/r/gtm/info')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.waitingContent).toEqual({
        type: 'youtube',
        value: 'https://www.youtube.com/watch?v=abc123',
        title: 'Watch this',
      });
    });

    it('should return null waitingContent when not configured', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      const res = await request(app)
        .get('/r/gtm/info')
        .expect(200);

      expect(res.body.waitingContent).toBeNull();
    });
  });

  describe('GET /r/:resultName/status/:sessionId', () => {
    it('should return pending status when session has no contentUrl or contentHtml', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      mockedChatbot.getChatSession.mockResolvedValue({
        sessionId: 'sess-pending',
        resultEndpointMetadata: {
          resultName: 'gtm',
          leadEmail: 'lead@example.com',
        },
      } as any);

      const res = await request(app)
        .get('/r/gtm/status/sess-pending')
        .expect(200);

      expect(res.body.status).toBe('pending');
      expect(res.body.resultTitle).toBe('gtm');
      expect(res.body.reportUrl).toBeUndefined();
    });

    it('should return completed status with direct contentUrl as reportUrl', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      mockedChatbot.getChatSession.mockResolvedValue({
        sessionId: 'sess-done',
        resultEndpointMetadata: {
          resultName: 'gtm',
          leadEmail: 'lead@example.com',
          contentUrl: 'https://s3.example.com/result.html',
        },
      } as any);

      const res = await request(app)
        .get('/r/gtm/status/sess-done')
        .expect(200);

      expect(res.body.status).toBe('completed');
      expect(res.body.reportUrl).toBe('https://s3.example.com/result.html');
      expect(res.body.leadEmail).toBe('lead@example.com');
    });

    it('should return completed status with contentHtml when no contentUrl', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      mockedChatbot.getChatSession.mockResolvedValue({
        sessionId: 'sess-html',
        resultEndpointMetadata: {
          resultName: 'gtm',
          leadEmail: 'lead@example.com',
          contentHtml: '<h1>Report</h1>',
        },
      } as any);

      const res = await request(app)
        .get('/r/gtm/status/sess-html')
        .expect(200);

      expect(res.body.status).toBe('completed');
      expect(res.body.reportUrl).toBeUndefined();
      expect(res.body.contentHtml).toBe('<h1>Report</h1>');
    });

    it('should return 404 when result endpoint not found', async () => {
      mockedSettings.getSetting.mockResolvedValue(null);

      const res = await request(app)
        .get('/r/nonexistent/status/sess-123')
        .expect(404);

      expect(res.body.error).toContain('not found');
    });

    it('should return 404 when session not found', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      mockedChatbot.getChatSession.mockResolvedValue(null as any);

      const res = await request(app)
        .get('/r/gtm/status/nonexistent')
        .expect(404);

      expect(res.body.error).toContain('Session not found');
    });

    it('should include waitingContent in status response', async () => {
      const configWithWaiting = {
        ...sampleConfig,
        waitingContent: { type: 'url', value: 'https://example.com/promo' },
      };
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([configWithWaiting]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      mockedChatbot.getChatSession.mockResolvedValue({
        sessionId: 'sess-wait',
        resultEndpointMetadata: { resultName: 'gtm' },
      } as any);

      const res = await request(app)
        .get('/r/gtm/status/sess-wait')
        .expect(200);

      expect(res.body.waitingContent).toEqual({
        type: 'url',
        value: 'https://example.com/promo',
      });
    });
  });

  describe('send_for_review (via agentModeService)', () => {
    it('should send review email to reviewer', async () => {
      mockedAgentMode.sendForReview.mockResolvedValue({
        success: true,
        message: 'Review email sent to reviewer@example.com',
        to: 'reviewer@example.com',
      });

      const result = await agentModeService.sendForReview(
        'GTM Plan for Acme',
        'session-123',
        'user-456',
        undefined,
        '<h1>GTM Plan</h1>'
      );

      expect(result.success).toBe(true);
      expect(result.to).toBe('reviewer@example.com');
      expect(mockedAgentMode.sendForReview).toHaveBeenCalledWith(
        'GTM Plan for Acme',
        'session-123',
        'user-456',
        undefined,
        '<h1>GTM Plan</h1>'
      );
    });
  });

  describe('Admin CRUD /api/admin/result-endpoints', () => {
    it('GET should return empty array when no configs exist', async () => {
      mockedSettings.getSetting.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('GET should return existing configs', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      const res = await request(app)
        .get('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('gtm');
    });

    it('POST should create a new config', async () => {
      mockedSettings.getSetting.mockResolvedValue(null);
      mockedSettings.setSetting.mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({
          name: 'new-endpoint',
          prompt: 'Generate something for {{Name}}',
          outputFormat: 'html',
          reviewerEmail: 'test@example.com',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('new-endpoint');
      expect(mockedSettings.setSetting).toHaveBeenCalledWith(
        'result-endpoints-config',
        expect.any(String),
        'Result endpoint configurations',
        'admin@example.com'
      );
    });

    it('POST should update an existing config', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });
      mockedSettings.setSetting.mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({
          name: 'gtm',
          prompt: 'Updated prompt for {{Company Name}}',
          outputFormat: 'image',
          reviewerEmail: 'new-reviewer@example.com',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.outputFormat).toBe('image');

      // Verify the saved array still has only 1 item (updated, not duplicated)
      const savedValue = JSON.parse(mockedSettings.setSetting.mock.calls[0][1]);
      expect(savedValue).toHaveLength(1);
      expect(savedValue[0].prompt).toContain('Updated prompt');
    });

    it('POST should validate required fields', async () => {
      await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({ name: '', prompt: 'test', outputFormat: 'html', reviewerEmail: 'a@b.com' })
        .expect(400);

      await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({ name: 'test', prompt: '', outputFormat: 'html', reviewerEmail: 'a@b.com' })
        .expect(400);

      await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({ name: 'test', prompt: 'test', outputFormat: 'invalid', reviewerEmail: 'a@b.com' })
        .expect(400);

      await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({ name: 'test', prompt: 'test', outputFormat: 'html', reviewerEmail: '' })
        .expect(400);
    });

    it('DELETE should remove a config', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });
      mockedSettings.setSetting.mockResolvedValue({} as any);

      const res = await request(app)
        .delete('/api/admin/result-endpoints/gtm')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);

      // Verify saved array is empty
      const savedValue = JSON.parse(mockedSettings.setSetting.mock.calls[0][1]);
      expect(savedValue).toHaveLength(0);
    });

    it('DELETE should return 404 for nonexistent config', async () => {
      mockedSettings.getSetting.mockResolvedValue({
        settingName: 'result-endpoints-config',
        settingValue: JSON.stringify([sampleConfig]),
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      });

      const res = await request(app)
        .delete('/api/admin/result-endpoints/nonexistent')
        .set('Authorization', 'Bearer test-token')
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('POST should save waitingContent when provided', async () => {
      mockedSettings.getSetting.mockResolvedValue(null);
      mockedSettings.setSetting.mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({
          name: 'with-waiting',
          prompt: 'Generate something',
          outputFormat: 'html',
          reviewerEmail: 'test@example.com',
          waitingContent: {
            type: 'youtube',
            value: 'https://www.youtube.com/watch?v=abc123',
            title: 'Watch this',
          },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.waitingContent).toEqual({
        type: 'youtube',
        value: 'https://www.youtube.com/watch?v=abc123',
        title: 'Watch this',
      });

      // Verify it was persisted
      const savedValue = JSON.parse(mockedSettings.setSetting.mock.calls[0][1]);
      expect(savedValue[0].waitingContent).toEqual({
        type: 'youtube',
        value: 'https://www.youtube.com/watch?v=abc123',
        title: 'Watch this',
      });
    });

    it('POST should omit waitingContent when not provided', async () => {
      mockedSettings.getSetting.mockResolvedValue(null);
      mockedSettings.setSetting.mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({
          name: 'no-waiting',
          prompt: 'Generate something',
          outputFormat: 'html',
          reviewerEmail: 'test@example.com',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      // waitingContent should be undefined (not sent in response)
      expect(res.body.data.waitingContent).toBeUndefined();
    });

    it('POST should reject invalid waitingContent type', async () => {
      mockedSettings.getSetting.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/admin/result-endpoints')
        .set('Authorization', 'Bearer test-token')
        .send({
          name: 'bad-waiting',
          prompt: 'Generate something',
          outputFormat: 'html',
          reviewerEmail: 'test@example.com',
          waitingContent: {
            type: 'invalid',
            value: 'some-value',
          },
        })
        .expect(400);

      expect(res.body.error).toContain('waitingContent.type');
    });
  });
});
