import { EmmaEmailService } from '../services/emmaEmailService';
import { EMMA_EMAIL_ADDRESS } from '../config';

// Mock dependencies
jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    sendEmail: jest.fn(),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    getChatSessionRecord: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    updateSessionEmailMetadata: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    addMessageToSession: jest.fn(),
  },
}));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
  modelUnavailableBody: jest.fn((err: { requestedModel: string }) => ({ error: `refused: ${err.requestedModel}` })),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('claude-sonnet-4-20250514'),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: jest.fn(),
  },
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

jest.mock('axios', () => ({
  default: { get: jest.fn() },
  get: jest.fn(),
}));

import { resendService } from '../services/resendService';
import { chatbotDb } from '../services/chatbotService';
import { generateSessionResponse } from '../controllers/agentModeController';
import { userDb } from '../services/db';
import { uploadFileToS3 } from '../utils/s3Utils';
import axios from 'axios';

// ENG-2652: processInboundEmail only acts on a sender Resend authenticated (DKIM or DMARC pass);
// every fixture of a genuine user's email carries that verdict, as Resend reports it.
const AUTHENTICATED = { spf: 'pass', dkim: 'pass', dmarc: 'pass' };

describe('EmmaEmailService', () => {
  let service: EmmaEmailService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EmmaEmailService();
  });

  // ─── isEmmaEmail ───────────────────────────────────────────────

  describe('isEmmaEmail', () => {
    it('returns false for empty array', () => {
      expect(service.isEmmaEmail([])).toBe(false);
    });

    it('returns false for non-emma addresses', () => {
      expect(service.isEmmaEmail(['support@agentweb.pro', 'hello@example.com'])).toBe(false);
    });

    it('returns false for similar-but-wrong addresses', () => {
      expect(service.isEmmaEmail(['emma@agentweb.pro'])).toBe(false);
      expect(service.isEmmaEmail(['emma@updates.agentweb.com'])).toBe(false);
      expect(service.isEmmaEmail(['emma2@updates.agentweb.pro'])).toBe(false);
    });

    it('returns true for exact emma address', () => {
      expect(service.isEmmaEmail(['emma@updates.agentweb.pro'])).toBe(true);
    });

    it('returns true case-insensitively', () => {
      expect(service.isEmmaEmail(['Emma@Updates.AgentWeb.Pro'])).toBe(true);
      expect(service.isEmmaEmail(['EMMA@UPDATES.AGENTWEB.PRO'])).toBe(true);
    });

    it('returns true when emma is among multiple recipients', () => {
      expect(service.isEmmaEmail(['other@example.com', 'emma@updates.agentweb.pro', 'another@test.com'])).toBe(true);
    });
  });

  // ─── isEmmaRelatedEvent ─────────────────────────────────────────

  describe('isEmmaRelatedEvent', () => {
    it('returns true when Emma is the sender (bare address)', () => {
      expect(service.isEmmaRelatedEvent('emma@updates.agentweb.pro', 'user@example.com')).toBe(true);
    });

    it('returns true when Emma is the sender (formatted address)', () => {
      expect(service.isEmmaRelatedEvent('Emma <emma@updates.agentweb.pro>', 'user@example.com')).toBe(true);
    });

    it('returns true when Emma is a recipient', () => {
      expect(service.isEmmaRelatedEvent('user@example.com', ['emma@updates.agentweb.pro'])).toBe(true);
    });

    it('returns true case-insensitively', () => {
      expect(service.isEmmaRelatedEvent('Emma@Updates.AgentWeb.Pro', 'user@example.com')).toBe(true);
    });

    it('returns false for unrelated emails', () => {
      expect(service.isEmmaRelatedEvent('sender@example.com', ['recipient@example.com'])).toBe(false);
    });

    it('handles string to-address', () => {
      expect(service.isEmmaRelatedEvent('user@example.com', 'emma@updates.agentweb.pro')).toBe(true);
    });
  });

  // ─── extractSessionId ─────────────────────────────────────────

  describe('extractSessionId', () => {
    it('returns null for empty subject', () => {
      expect(service.extractSessionId('')).toBeNull();
    });

    it('returns null for subject without ref tag', () => {
      expect(service.extractSessionId('Hello Emma, can you help?')).toBeNull();
    });

    it('returns null for malformed UUID in ref tag', () => {
      expect(service.extractSessionId('Re: Help [ref:not-a-uuid]')).toBeNull();
      expect(service.extractSessionId('Re: Help [ref:12345]')).toBeNull();
    });

    it('extracts UUID from [ref:uuid] pattern', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(service.extractSessionId(`Re: Help [ref:${uuid}]`)).toBe(uuid);
    });

    it('extracts UUID when ref tag is anywhere in subject', () => {
      const uuid = '12345678-1234-1234-1234-123456789012';
      expect(service.extractSessionId(`[ref:${uuid}] Some topic`)).toBe(uuid);
      expect(service.extractSessionId(`Topic [ref:${uuid}] extra`)).toBe(uuid);
    });

    it('extracts UUID with Re: prefix', () => {
      const uuid = 'abcdef12-3456-7890-abcd-ef1234567890';
      expect(service.extractSessionId(`Re: Re: Topic [ref:${uuid}]`)).toBe(uuid);
    });
  });

  // ─── extractMessageBody ────────────────────────────────────────

  describe('extractMessageBody', () => {
    it('returns empty string for empty content', () => {
      expect(service.extractMessageBody({})).toBe('');
    });

    it('returns empty string for undefined html and text', () => {
      expect(service.extractMessageBody({ html: undefined, text: undefined })).toBe('');
    });

    it('extracts text from HTML', () => {
      const html = '<p>Hello Emma, please help me with my website.</p>';
      const result = service.extractMessageBody({ html });
      expect(result).toContain('Hello Emma');
      expect(result).not.toContain('<p>');
    });

    it('falls back to plain text when no HTML', () => {
      const text = 'Hello Emma, plain text message.';
      expect(service.extractMessageBody({ text })).toContain('Hello Emma');
    });

    it('strips quoted lines (> prefix)', () => {
      const text = 'My reply\n> Previous message line\n> Another quoted line\nMore of my reply';
      const result = service.extractMessageBody({ text });
      expect(result).toContain('My reply');
      expect(result).toContain('More of my reply');
      expect(result).not.toContain('Previous message line');
    });

    it('strips signature blocks (-- separator)', () => {
      const text = 'My message\n-- \nJohn Doe\nCEO, Example Inc.';
      const result = service.extractMessageBody({ text });
      expect(result).toContain('My message');
      expect(result).not.toContain('John Doe');
      expect(result).not.toContain('CEO');
    });

    it('strips "On ... wrote:" blocks', () => {
      const text = 'My reply here\n\nOn Mon, Mar 1, 2026 at 10:00 AM Emma wrote:\n> Some old message';
      const result = service.extractMessageBody({ text });
      expect(result).toContain('My reply here');
      expect(result).not.toContain('Emma wrote');
    });
  });

  // ─── resolveUserId ─────────────────────────────────────────────

  describe('resolveUserId', () => {
    it('returns null for unknown email', async () => {
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue(null);
      const result = await service.resolveUserId('unknown@example.com');
      expect(result).toBeNull();
    });

    it('returns existing userId for registered user', async () => {
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'known@example.com' });
      const result = await service.resolveUserId('known@example.com');
      expect(result).toBe('user-123');
    });
  });

  // ─── buildResponseSubject ──────────────────────────────────────

  describe('buildResponseSubject', () => {
    const sessionId = '12345678-1234-1234-1234-123456789012';

    it('handles empty subject', () => {
      const result = service.buildResponseSubject('', sessionId);
      expect(result).toContain(`[ref:${sessionId}]`);
      expect(result).toContain('Re:');
    });

    it('adds Re: prefix and ref tag for new sessions', () => {
      const result = service.buildResponseSubject('Help with my website', sessionId);
      expect(result).toBe(`Re: Help with my website [ref:${sessionId}]`);
    });

    it('does not double Re: prefix', () => {
      const result = service.buildResponseSubject('Re: Help with my website', sessionId);
      expect(result).not.toMatch(/^Re: Re:/);
      expect(result).toContain(`[ref:${sessionId}]`);
    });

    // ENG-2652: the tag must name the session that answered. Echoing an inbound tag that names a
    // different session (missing, or another account's) kept the thread pointing at it.
    it('replaces a ref tag naming a different session with the answering session', () => {
      const existingRef = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const result = service.buildResponseSubject(`Re: Help [ref:${existingRef}]`, sessionId);
      expect(result).toBe(`Re: Help [ref:${sessionId}]`);
      expect(result).not.toContain(existingRef);
      expect((result.match(/\[ref:/g) || []).length).toBe(1);
    });

    it('keeps a ref tag that already names the answering session', () => {
      const result = service.buildResponseSubject(`Re: Help [ref:${sessionId}]`, sessionId);
      expect(result).toBe(`Re: Help [ref:${sessionId}]`);
    });
  });

  // ─── buildResponseEmail ────────────────────────────────────────

  describe('buildResponseEmail', () => {
    it('handles empty response', () => {
      const result = service.buildResponseEmail('', 'https://app.agentweb.pro/ishare/test');
      expect(result.html).toBeDefined();
      expect(result.text).toBeDefined();
    });

    it('includes response in HTML body', () => {
      const result = service.buildResponseEmail('<p>Here is my <strong>answer</strong>.</p>', 'https://app.agentweb.pro/ishare/test');
      expect(result.html).toContain('<p>Here is my <strong>answer</strong>.</p>');
    });

    it('includes ishare link button in HTML', () => {
      const url = 'https://app.agentweb.pro/ishare/session-123?conversable=abc';
      const result = service.buildResponseEmail('Answer', url);
      expect(result.html).toContain(url);
      expect(result.html).toContain('Continue');
    });

    it('includes plain text fallback with HTML stripped', () => {
      const url = 'https://app.agentweb.pro/ishare/session-123?conversable=abc';
      const result = service.buildResponseEmail('<p>Here is the <strong>answer</strong>.</p>', url);
      expect(result.text).toContain('Here is the answer.');
      expect(result.text).not.toContain('<p>');
      expect(result.text).toContain(url);
    });
  });

  // ─── processInboundEmail ───────────────────────────────────────

  describe('processInboundEmail', () => {
    const baseEvent = {
      emailId: 'email-001',
      from: 'user@example.com',
      to: ['emma@updates.agentweb.pro'],
      subject: 'Help with my website',
    };

    it('handles Resend API failure gracefully', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue(null);

      await expect(service.processInboundEmail(baseEvent)).rejects.toThrow();
    });

    it('handles empty body', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, html: '', text: '' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'new-session-id' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Hello! How can I help?', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('https://app.agentweb.pro/ishare/new-session-id?conversable=token');
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-001' });

      // Should still process even with empty body
      await service.processInboundEmail(baseEvent);
      expect(generateSessionResponse).toHaveBeenCalled();
    });

    it('creates new session when no ref tag in subject', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Help me please' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'new-session-id' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Sure, I can help!', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('https://app.agentweb.pro/ishare/new-session-id?conversable=token');
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-001' });

      await service.processInboundEmail(baseEvent);

      expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
        'user-123',
        undefined,
        'agent',
        'agent-mode',
        undefined,
        undefined,
        undefined,
        undefined,
        'emma-email',
        undefined
      );
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'new-session-id',
        'Help with my website\n\nHelp me please',
        'user-123',
        'claude-sonnet-4-20250514',
        undefined
      );
    });

    it('continues existing session when valid ref tag present', async () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      const eventWithRef = {
        ...baseEvent,
        subject: `Re: Help [ref:${sessionId}]`,
      };

      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Follow-up question' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-123' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Here is the follow-up answer.', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(`https://app.agentweb.pro/ishare/${sessionId}?conversable=token`);
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-002' });

      await service.processInboundEmail(eventWithRef);

      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      // Reply should NOT include subject — only body
      expect(generateSessionResponse).toHaveBeenCalledWith(
        sessionId,
        'Follow-up question',
        'user-123',
        'claude-sonnet-4-20250514',
        undefined
      );
    });

    // ENG-2648: like a Slack thread reply, an email continuing a chat runs on that chat's stored model.
    it("continues an existing session on that session's stored model, not the default", async () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Follow-up question' });
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-123', llmModel: 'openrouter/openai/gpt-6-sol' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-123', llmModel: 'openrouter/openai/gpt-6-sol' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Answer', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(`https://app.agentweb.pro/ishare/${sessionId}?conversable=token`);
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-005' });

      await service.processInboundEmail({ ...baseEvent, subject: `Re: Help [ref:${sessionId}]` });

      expect(generateSessionResponse).toHaveBeenCalledWith(sessionId, 'Follow-up question', 'user-123', 'openrouter/openai/gpt-6-sol', undefined);
      expect(chatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    // ENG-2648: the chat's stored model fell outside the owner's plan (downgrade): the sender is told, like Slack.
    it('emails the model refusal and saves it to the chat when the stored model is no longer in the plan', async () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Follow-up question' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-123', llmModel: 'openrouter/openai/gpt-6-sol' });
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-123', llmModel: 'openrouter/openai/gpt-6-sol' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (generateSessionResponse as jest.Mock).mockRejectedValue(Object.assign(new Error('model_unavailable'), { code: 'model_unavailable', requestedModel: 'openrouter/openai/gpt-6-sol' }));
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(`https://app.agentweb.pro/ishare/${sessionId}?conversable=token`);
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-006' });

      await service.processInboundEmail({ ...baseEvent, subject: `Re: Help [ref:${sessionId}]` });

      expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
      expect((resendService.sendEmail as jest.Mock).mock.calls[0][0].text).toContain('refused: openrouter/openai/gpt-6-sol');
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({ role: 'assistant', content: 'refused: openrouter/openai/gpt-6-sol', metadata: expect.objectContaining({ isErrorMessage: true }) }));
    });

    it('still rethrows any other generation error', async () => {
      const sessionId = '12345678-1234-1234-1234-123456789012';
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Hi' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-123' });
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-123' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (generateSessionResponse as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(service.processInboundEmail({ ...baseEvent, subject: `Re: Help [ref:${sessionId}]` })).rejects.toThrow('boom');
      expect(resendService.sendEmail).not.toHaveBeenCalled();
    });

    it('falls back to new session when ref tag session not found', async () => {
      const badSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const eventWithBadRef = {
        ...baseEvent,
        subject: `Re: Help [ref:${badSessionId}]`,
      };

      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'My message' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(null); // session not found
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'new-fallback-session' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Response', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('https://app.agentweb.pro/ishare/new-fallback-session?conversable=token');
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-003' });

      await service.processInboundEmail(eventWithBadRef);

      expect(chatbotDb.createChatSession).toHaveBeenCalled();
    });

    it('sends response email with correct from, subject, and inReplyTo using Message-ID header', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({
        authentication: AUTHENTICATED,
        text: 'Question',
        headers: { 'message-id': '<abc123@mail.gmail.com>' },
      });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-456', email: 'user@example.com' });
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-abc' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Answer', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('https://app.agentweb.pro/ishare/session-abc?conversable=token');
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-004' });

      await service.processInboundEmail(baseEvent);

      expect(resendService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('emma@updates.agentweb.pro'),
          to: 'user@example.com',
          subject: expect.stringContaining('[ref:session-abc]'),
          inReplyTo: '<abc123@mail.gmail.com>',
          html: expect.any(String),
          text: expect.any(String),
        })
      );
    });

    it('sends free trial email for unregistered sender instead of creating session', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Question' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue(null);
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-005' });

      await service.processInboundEmail(baseEvent);

      // Should NOT create a session
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(generateSessionResponse).not.toHaveBeenCalled();

      // Should send free trial email
      expect(resendService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          html: expect.stringContaining('agentweb.pro/build'),
        })
      );
    });

    it('updates emailMetadata on session', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Question' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-meta' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Answer', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('https://app.agentweb.pro/ishare/session-meta?conversable=token');
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-006' });

      await service.processInboundEmail(baseEvent);

      expect(chatbotDb.updateSessionEmailMetadata).toHaveBeenCalledWith(
        'session-meta',
        expect.objectContaining({
          senderEmail: 'user@example.com',
          lastInboundEmailId: 'email-001',
        })
      );
    });

    it('uploads email attachments to S3 and passes them to generateSessionResponse', async () => {
      const attachments = [
        { id: 'att-1', filename: 'report.pdf', size: 12345, content_type: 'application/pdf', download_url: 'https://resend.com/dl/att-1' },
        { id: 'att-2', filename: 'photo.png', size: 67890, content_type: 'image/png', download_url: 'https://resend.com/dl/att-2' },
      ];

      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'See attached', attachments });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-att' });
      (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('fake-file-content') });
      (uploadFileToS3 as jest.Mock)
        .mockResolvedValueOnce({ success: true, url: 'https://s3.amazonaws.com/bucket/report.pdf' })
        .mockResolvedValueOnce({ success: true, url: 'https://s3.amazonaws.com/bucket/photo.png' });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'I see your files', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('https://app.agentweb.pro/ishare/session-att?conversable=token');
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-att' });

      await service.processInboundEmail(baseEvent);

      // Should download each attachment
      expect(axios.get).toHaveBeenCalledWith('https://resend.com/dl/att-1', { responseType: 'arraybuffer' });
      expect(axios.get).toHaveBeenCalledWith('https://resend.com/dl/att-2', { responseType: 'arraybuffer' });

      // Should upload each to S3
      expect(uploadFileToS3).toHaveBeenCalledTimes(2);
      expect(uploadFileToS3).toHaveBeenCalledWith(expect.any(Buffer), 'report.pdf', 'user-123', 'application/pdf');
      expect(uploadFileToS3).toHaveBeenCalledWith(expect.any(Buffer), 'photo.png', 'user-123', 'image/png');

      // Should pass attachments to generateSessionResponse
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-att',
        expect.any(String),
        'user-123',
        'claude-sonnet-4-20250514',
        expect.arrayContaining([
          expect.objectContaining({ url: 'https://s3.amazonaws.com/bucket/report.pdf', filename: 'report.pdf' }),
          expect.objectContaining({ url: 'https://s3.amazonaws.com/bucket/photo.png', filename: 'photo.png' }),
        ])
      );
    });

    it('continues processing when attachment upload fails', async () => {
      const attachments = [
        { id: 'att-1', filename: 'broken.pdf', size: 100, content_type: 'application/pdf', download_url: 'https://resend.com/dl/broken' },
      ];

      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'See attached', attachments });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-fail' });
      (axios.get as jest.Mock).mockRejectedValue(new Error('Download failed'));
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Response without attachments', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('https://app.agentweb.pro/ishare/session-fail?conversable=token');
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-fail' });

      await service.processInboundEmail(baseEvent);

      // Should still generate response without attachments
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-fail',
        expect.any(String),
        'user-123',
        'claude-sonnet-4-20250514',
        undefined
      );
    });
  });

  // ─── ENG-2652: sender authentication and session ownership ─────

  describe('processInboundEmail — sender and session ownership (ENG-2652)', () => {
    const victimSessionId = '99999999-8888-7777-6666-555555555555';
    const attackerEvent = {
      emailId: 'email-attack',
      from: 'attacker@example.com',
      to: ['emma@updates.agentweb.pro'],
      subject: `Re: Quarterly plan [ref:${victimSessionId}]`,
    };

    function primeTurn(newSessionId: string) {
      (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: newSessionId });
      (generateSessionResponse as jest.Mock).mockResolvedValue({ content: 'Answer', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockImplementation(
        async (id: string) => `https://app.agentweb.pro/ishare/${id}?conversable=token-for-${id}`,
      );
      (chatbotDb.updateSessionEmailMetadata as jest.Mock).mockResolvedValue({});
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'sent-x' });
    }

    function everySessionIdTouched(): string[] {
      return [
        ...(generateSessionResponse as jest.Mock).mock.calls.map((c) => c[0]),
        ...(chatbotDb.createOrReuseInteractiveShare as jest.Mock).mock.calls.map((c) => c[0]),
        ...(chatbotDb.updateSessionEmailMetadata as jest.Mock).mock.calls.map((c) => c[0]),
      ];
    }

    it('never continues, links, or writes to another account\'s session named by [ref:]', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Summarise this chat' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'attacker-user', email: 'attacker@example.com' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId: victimSessionId, userId: 'victim-user' });
      primeTurn('attacker-new-session');

      await service.processInboundEmail(attackerEvent);

      expect(chatbotDb.getChatSessionRecord).toHaveBeenCalledWith(victimSessionId, true);
      expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
        'attacker-user', undefined, 'agent', 'agent-mode', undefined, undefined, undefined, undefined, 'emma-email', undefined,
      );
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'attacker-new-session', expect.any(String), 'attacker-user', expect.any(String), undefined,
      );
      expect(everySessionIdTouched()).not.toContain(victimSessionId);

      const sent = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      expect(sent.to).toBe('attacker@example.com');
      expect(sent.subject).toContain('[ref:attacker-new-session]');
      expect(`${sent.subject}${sent.html}${sent.text}`).not.toContain(victimSessionId);
      expect(sent.text).toContain('/ishare/attacker-new-session?conversable=token-for-attacker-new-session');
    });

    it('applies the owner-only rule to admins too (email has no delegate context)', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Hi' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'admin-user', email: 'admin@example.com', isAdmin: true });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId: victimSessionId, userId: 'customer-user' });
      primeTurn('admin-new-session');

      await service.processInboundEmail({ ...attackerEvent, from: 'admin@example.com' });

      expect(everySessionIdTouched()).not.toContain(victimSessionId);
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'admin-new-session', expect.any(String), 'admin-user', expect.any(String), undefined,
      );
    });

    it('still continues the sender\'s own session', async () => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication: AUTHENTICATED, text: 'Follow-up' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'victim-user', email: 'victim@example.com' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId: victimSessionId, userId: 'victim-user' });
      primeTurn('unused');

      await service.processInboundEmail({ ...attackerEvent, from: 'victim@example.com' });

      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(generateSessionResponse).toHaveBeenCalledWith(victimSessionId, 'Follow-up', 'victim-user', expect.any(String), undefined);
    });

    it.each([
      ['no verdict at all', undefined],
      ['a null verdict', null],
      ['SPF pass only (envelope sender, not the From domain)', { spf: 'pass', dkim: 'gray', dmarc: 'gray' }],
      ['DKIM and DMARC fail', { spf: 'pass', dkim: 'fail', dmarc: 'fail' }],
      ['unknown / processing_failed', { spf: 'unknown', dkim: 'processing_failed', dmarc: 'unknown' }],
    ])('ignores a sender that is not authenticated: %s', async (_label, authentication) => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication, text: 'Spoofed' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'victim-user', email: 'victim@example.com' });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ sessionId: victimSessionId, userId: 'victim-user' });

      await service.processInboundEmail({ ...attackerEvent, from: 'victim@example.com' });

      expect(userDb.getUserByEmail).not.toHaveBeenCalled();
      expect(chatbotDb.getChatSessionRecord).not.toHaveBeenCalled();
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(generateSessionResponse).not.toHaveBeenCalled();
      expect(chatbotDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
      expect(resendService.sendEmail).not.toHaveBeenCalled();
    });

    it.each([
      ['DKIM pass (From-aligned signature)', { spf: 'gray', dkim: 'pass', dmarc: 'gray' }],
      ['DMARC pass', { spf: 'pass', dkim: 'gray', dmarc: 'pass' }],
    ])('accepts an authenticated sender: %s', async (_label, authentication) => {
      (resendService.getReceivedEmailContent as jest.Mock).mockResolvedValue({ authentication, text: 'Hello' });
      (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'user-123', email: 'user@example.com' });
      primeTurn('fresh-session');

      await service.processInboundEmail({ ...attackerEvent, subject: 'Hello Emma', from: 'user@example.com' });

      expect(generateSessionResponse).toHaveBeenCalled();
      expect(resendService.sendEmail).toHaveBeenCalled();
    });
  });
});
