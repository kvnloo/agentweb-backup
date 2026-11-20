/**
 * ENG-3163: POST /api/agent-mode/ishare/:shareId/email-report is public (a landing
 * page calls it so a lead gets their own report). Holding a share link used to be
 * enough to make AgentWeb email any address with any link, without limit.
 *
 * These tests drive the real controller and pin:
 *   - the lead flow still works: a valid link on our site goes to the address given;
 *   - a report link that is not ours, or a recipient that is not one plain address,
 *     is refused before anything is sent;
 *   - the share token and expiry checks are unchanged;
 *   - sends are limited per link, and the refusal is a 429 with Retry-After.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn().mockReturnValue(true),
    has: jest.fn().mockReturnValue(false),
    add: jest.fn(),
  },
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  emitProgress: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  TURN_ADMISSION: { recordAdmission: true },
  checkTokenUsage: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { emailService } from '../services/emailService';
import { agentModeController } from '../controllers/agentModeController';
import { resetEmailReportLimiter, ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR } from '../utils/ishareEmailReport';

const mockGetChatSession = chatbotDb.getChatSession as jest.Mock;
const mockSendEmail = (emailService as unknown as { sendEmail: jest.Mock }).sendEmail;

const SHARE_ID = 'ishare-session-eng3163';
const TOKEN = 'tok-eng3163';
const GOOD_URL = 'https://app.agentweb.pro/ishare/ishare-session-eng3163?conversable=tok-eng3163';

const activeSession = {
  sessionId: SHARE_ID,
  userId: 'owner-user-id',
  interactiveShareMetadata: { isActive: true, token: TOKEN, sharedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00Z' },
};

function makeReq(body: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    params: { shareId: SHARE_ID },
    body: { email: 'lead@example.com', reportUrl: GOOD_URL, conversableToken: TOKEN, ...body },
    ip: '203.0.113.42',
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  return {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  } as unknown as Response & { json: jest.Mock; status: jest.Mock; setHeader: jest.Mock };
}

async function call(req: Request) {
  const res = makeRes();
  await agentModeController.emailReportToLead(req, res);
  return res;
}

describe('ENG-3163: ishare email-report', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetEmailReportLimiter();
    mockGetChatSession.mockResolvedValue(activeSession);
    mockSendEmail.mockResolvedValue(undefined);
  });

  afterAll(() => {
    resetEmailReportLimiter();
  });

  describe('the lead flow still works', () => {
    it('emails the address given, with the report link, and answers success', async () => {
      const res = await call(makeReq());

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const [to, subject, text, html] = mockSendEmail.mock.calls[0];
      expect(to).toBe('lead@example.com');
      expect(subject).toBe('Your AI Report is Ready — AgentWeb');
      expect(text).toContain(GOOD_URL);
      expect(html).toContain(`<a href="${GOOD_URL}"`);
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Report sent to lead@example.com' });
    });

    it('trims the address before sending', async () => {
      await call(makeReq({ email: '  lead@example.com  ' }));
      expect(mockSendEmail.mock.calls[0][0]).toBe('lead@example.com');
    });
  });

  describe('the report link must be ours', () => {
    it.each([
      ['another site', 'https://evil.example.com/login'],
      ['a lookalike of our domain', 'https://agentweb.pro.evil.com/x'],
      ['a javascript link', 'javascript:alert(1)'],
      ['credentials in the link', 'https://agentweb.pro@evil.com/x'],
    ])('refuses %s with 400 and sends nothing', async (_label, reportUrl) => {
      const res = await call(makeReq({ reportUrl }));
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'reportUrl must be a link on an AgentWeb site' });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('does not let markup in the link reach the email', async () => {
      await call(makeReq({ reportUrl: 'https://app.agentweb.pro/r?x="><img src=x onerror=alert(1)>' }));
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const html = mockSendEmail.mock.calls[0][3] as string;
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('onerror=alert(1)>');
    });
  });

  describe('the recipient must be one plain address', () => {
    it.each([
      ['two addresses', 'a@example.com,b@example.com'],
      ['a display name', 'Boss <boss@example.com>'],
      ['a header injection', 'a@example.com\r\nBcc: victim@example.com'],
      ['no domain dot', 'lead@example'],
    ])('refuses %s with 400 and sends nothing', async (_label, email) => {
      const res = await call(makeReq({ email }));
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'email must be a single valid address' });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('keeps the earlier required-field answers', async () => {
      const noEmail = await call(makeReq({ email: '' }));
      expect(noEmail.status).toHaveBeenCalledWith(400);
      expect(noEmail.json).toHaveBeenCalledWith({ error: 'email is required' });

      const noUrl = await call(makeReq({ reportUrl: undefined }));
      expect(noUrl.status).toHaveBeenCalledWith(400);
      expect(noUrl.json).toHaveBeenCalledWith({ error: 'reportUrl is required' });

      const noToken = await call(makeReq({ conversableToken: undefined }));
      expect(noToken.status).toHaveBeenCalledWith(401);
      expect(noToken.json).toHaveBeenCalledWith({ error: 'conversableToken is required' });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  describe('the share link checks are unchanged', () => {
    it('404 for an unknown session', async () => {
      mockGetChatSession.mockResolvedValue(null);
      const res = await call(makeReq());
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('401 for a wrong token', async () => {
      const res = await call(makeReq({ conversableToken: 'not-the-token' }));
      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('401 for an inactive share', async () => {
      mockGetChatSession.mockResolvedValue({ ...activeSession, interactiveShareMetadata: { ...activeSession.interactiveShareMetadata, isActive: false } });
      const res = await call(makeReq());
      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('410 for an expired share', async () => {
      mockGetChatSession.mockResolvedValue({ ...activeSession, interactiveShareMetadata: { ...activeSession.interactiveShareMetadata, expiresAt: '2000-01-01T00:00:00Z' } });
      const res = await call(makeReq());
      expect(res.status).toHaveBeenCalledWith(410);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('a wrong-token caller does not use up the real link\'s sends', async () => {
      for (let i = 0; i < 10; i++) await call(makeReq({ conversableToken: 'guess' }));
      const res = await call(makeReq());
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Report sent to lead@example.com' });
    });
  });

  describe('sends are limited', () => {
    it('refuses the send over the per-link cap with 429 and Retry-After, and sends no email', async () => {
      for (let i = 0; i < ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR; i++) {
        const ok = await call(makeReq({ email: `lead${i}@example.com` }));
        expect(ok.json).toHaveBeenCalledWith({ success: true, message: `Report sent to lead${i}@example.com` });
      }
      expect(mockSendEmail).toHaveBeenCalledTimes(ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR);

      const blocked = await call(makeReq({ email: 'one-too-many@example.com' }));
      expect(blocked.status).toHaveBeenCalledWith(429);
      expect(blocked.json).toHaveBeenCalledWith({ error: 'Too many report emails. Try again later.' });
      expect(blocked.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
      expect(mockSendEmail).toHaveBeenCalledTimes(ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR);
    });

    it('answers 500, not success, when the mail service fails', async () => {
      mockSendEmail.mockRejectedValue(new Error('smtp down'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await call(makeReq());
      errorSpy.mockRestore();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to send report email' });
    });
  });
});
