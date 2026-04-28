/**
 * Tests for GmailService
 * Covers: token refresh, searchEmails, getEmail, listEmails
 * Edge cases: token expiry, revocation, quota (429 + 1 retry), large HTML body,
 *             concurrent refresh lock, multipart email parsing
 */

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockUpdateAccountTokens = jest.fn().mockResolvedValue(undefined);
const mockGetAccountById = jest.fn();

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountById: (...args: any[]) => mockGetAccountById(...args),
  updateAccountTokens: (...args: any[]) => mockUpdateAccountTokens(...args),
}));

// googleapis mock
const mockMessagesList = jest.fn();
const mockMessagesGet = jest.fn();
const mockMessagesSend = jest.fn();
const mockGmailUsers = {
  messages: {
    list: mockMessagesList,
    get: mockMessagesGet,
    send: mockMessagesSend,
  },
};
const mockGmailInstance = { users: mockGmailUsers };

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        refreshAccessToken: jest.fn().mockResolvedValue({
          credentials: {
            access_token: 'new-access-token',
            expiry_date: Date.now() + 3600000,
          },
        }),
      })),
    },
    gmail: jest.fn().mockReturnValue(mockGmailInstance),
  },
}));

jest.mock('../config/integrations', () => ({
  getGmailConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/gmail/callback',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  }),
}));

// emailProviderService not needed in gmailService tests (gmailService is tested directly)
jest.mock('../services/emailProviderService', () => ({}));

import { GmailService, GmailNotConnectedError, GmailTokenRevokedError, GmailQuotaError, GmailBodyTooLargeError, GmailSendNotAuthorizedError } from '../services/gmailService';

// ── Fixtures ───────────────────────────────────────────────────────────────
const ACCOUNT_ID = 'test@gmail.com';

const VALID_ACCOUNT = {
  platform: 'gmail' as const,
  account_id: ACCOUNT_ID,
  account_name: 'Test User',
  userId: 'user-123',
  config: {
    account_type: 'gmail' as const,
    email: ACCOUNT_ID,
    access_token: 'valid-access-token',
    refresh_token: 'valid-refresh-token',
    token_expires_at: Date.now() + 10 * 60 * 1000, // 10 min from now — valid
    granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Account with both read and send scopes
const VALID_ACCOUNT_WITH_SEND = {
  ...VALID_ACCOUNT,
  config: {
    ...VALID_ACCOUNT.config,
    granted_scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },
};

const EXPIRING_ACCOUNT = {
  ...VALID_ACCOUNT,
  config: {
    ...VALID_ACCOUNT.config,
    token_expires_at: Date.now() + 2 * 60 * 1000, // 2 min — within 5-min buffer, needs refresh
  },
};

const EXPIRED_NO_REFRESH = {
  ...VALID_ACCOUNT,
  config: {
    ...VALID_ACCOUNT.config,
    token_expires_at: Date.now() - 1000, // already expired
    refresh_token: undefined,
  },
};

// Minimal Gmail message list response
const mockListResponse = {
  data: {
    messages: [
      { id: 'msg-001', threadId: 'thread-001' },
      { id: 'msg-002', threadId: 'thread-002' },
    ],
    resultSizeEstimate: 2,
  },
};

// Minimal Gmail message detail (plain text)
const makeMessageDetail = (bodyText: string, mimeType = 'text/plain') => ({
  data: {
    id: 'msg-001',
    threadId: 'thread-001',
    payload: {
      mimeType,
      headers: [
        { name: 'Subject', value: 'Test Subject' },
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'test@gmail.com' },
        { name: 'Date', value: 'Mon, 1 Jan 2024 10:00:00 +0000' },
      ],
      body: {
        size: Buffer.byteLength(bodyText),
        data: Buffer.from(bodyText).toString('base64url'),
      },
      parts: [],
    },
    snippet: 'Test snippet',
  },
});

/**
 * Build a mock multipart batch response for metadata fetches.
 * Each entry in `messages` becomes one part in the response.
 */
const makeBatchMetaResponse = (messages: Array<{ id: string; threadId: string }>) => {
  const boundary = 'test_batch_boundary';
  const parts = messages.map(msg => {
    const body = JSON.stringify({
      id: msg.id,
      threadId: msg.threadId,
      snippet: 'Test snippet',
      payload: {
        headers: [
          { name: 'Subject', value: 'Test Subject' },
          { name: 'From', value: 'sender@example.com' },
          { name: 'Date', value: 'Mon, 1 Jan 2024 10:00:00 +0000' },
        ],
      },
    });
    return [
      `--${boundary}`,
      'Content-Type: application/http',
      '',
      'HTTP/1.1 200 OK',
      'Content-Type: application/json',
      '',
      body,
    ].join('\r\n');
  });
  const responseText = parts.join('\r\n') + `\r\n--${boundary}--`;
  return {
    status: 200,
    headers: { get: (h: string) => h === 'content-type' ? `multipart/mixed; boundary=${boundary}` : null },
    text: async () => responseText,
  };
};

// ── Tests ──────────────────────────────────────────────────────────────────
describe('GmailService', () => {
  let service: GmailService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GmailService();
  });

  // ── Not connected ────────────────────────────────────────────────────────
  describe('GmailNotConnectedError', () => {
    it('throws GmailNotConnectedError when no gmail account connected', async () => {
      mockGetAccountById.mockResolvedValue(null);
      await expect(service.searchEmails('user-123', ACCOUNT_ID, 'test')).rejects.toThrow(GmailNotConnectedError);
    });
  });

  // ── Token refresh ────────────────────────────────────────────────────────
  describe('token refresh', () => {
    it('uses existing token when not expiring soon', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT);
      mockMessagesList.mockResolvedValue(mockListResponse);
      mockMessagesGet.mockResolvedValue(makeMessageDetail('hello'));

      await service.searchEmails('user-123', ACCOUNT_ID, 'test');
      expect(mockUpdateAccountTokens).not.toHaveBeenCalled();
    });

    it('refreshes token when expiring within 5-min buffer', async () => {
      mockGetAccountById.mockResolvedValue(EXPIRING_ACCOUNT);
      mockMessagesList.mockResolvedValue(mockListResponse);
      mockMessagesGet.mockResolvedValue(makeMessageDetail('hello'));

      await service.searchEmails('user-123', ACCOUNT_ID, 'test');
      expect(mockUpdateAccountTokens).toHaveBeenCalledWith(
        'user-123',
        'gmail',
        expect.objectContaining({ access_token: 'new-access-token' }),
        ACCOUNT_ID
      );
    });

    it('throws GmailTokenRevokedError when no refresh_token and token expired', async () => {
      mockGetAccountById.mockResolvedValue(EXPIRED_NO_REFRESH);
      await expect(service.searchEmails('user-123', ACCOUNT_ID, 'test')).rejects.toThrow(GmailTokenRevokedError);
    });

    it('throws GmailTokenRevokedError on invalid_grant from Google', async () => {
      mockGetAccountById.mockResolvedValue(EXPIRING_ACCOUNT);
      const { google } = require('googleapis');
      google.auth.OAuth2.mockImplementationOnce(() => ({
        setCredentials: jest.fn(),
        refreshAccessToken: jest.fn().mockRejectedValue(
          Object.assign(new Error('invalid_grant'), { message: 'invalid_grant' })
        ),
      }));

      await expect(service.searchEmails('user-123', ACCOUNT_ID, 'test')).rejects.toThrow(GmailTokenRevokedError);
    });
  });

  // ── searchEmails ─────────────────────────────────────────────────────────
  describe('searchEmails', () => {
    beforeEach(() => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT);
    });

    it('returns list of email summaries via batch metadata fetch', async () => {
      mockMessagesList.mockResolvedValue(mockListResponse);
      global.fetch = jest.fn().mockResolvedValue(makeBatchMetaResponse(mockListResponse.data.messages));

      const results = await service.searchEmails('user-123', ACCOUNT_ID, 'from:alice@example.com');
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ id: 'msg-001', subject: 'Test Subject', from: 'sender@example.com' });
      expect(global.fetch).toHaveBeenCalledTimes(1); // single batch call
    });

    it('returns empty array when no messages found', async () => {
      mockMessagesList.mockResolvedValue({ data: { messages: [], resultSizeEstimate: 0 } });
      const results = await service.searchEmails('user-123', ACCOUNT_ID, 'nothing');
      expect(results).toEqual([]);
    });

    it('retries once on 429 quota error from list then returns results', async () => {
      const quotaError = Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
      mockMessagesList
        .mockRejectedValueOnce(quotaError)
        .mockResolvedValueOnce(mockListResponse);
      global.fetch = jest.fn().mockResolvedValue(makeBatchMetaResponse(mockListResponse.data.messages));

      const results = await service.searchEmails('user-123', ACCOUNT_ID, 'test');
      expect(mockMessagesList).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
    });

    it('throws GmailQuotaError if 429 persists after one retry', async () => {
      const quotaError = Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
      mockMessagesList.mockRejectedValue(quotaError);

      await expect(service.searchEmails('user-123', ACCOUNT_ID, 'test')).rejects.toThrow(GmailQuotaError);
      expect(mockMessagesList).toHaveBeenCalledTimes(2);
    });
  });

  // ── getEmail ─────────────────────────────────────────────────────────────
  describe('getEmail', () => {
    beforeEach(() => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT);
    });

    it('returns full email content for plain text message', async () => {
      mockMessagesGet.mockResolvedValue(makeMessageDetail('Hello, world!'));

      const email = await service.getEmail('user-123', ACCOUNT_ID, 'msg-001');
      expect(email.subject).toBe('Test Subject');
      expect(email.from).toBe('sender@example.com');
      expect(email.body).toBe('Hello, world!');
      expect(email.hasAttachments).toBe(false);
    });

    it('truncates plain text body at 8000 chars', async () => {
      const longBody = 'x'.repeat(9000);
      mockMessagesGet.mockResolvedValue(makeMessageDetail(longBody));

      const email = await service.getEmail('user-123', ACCOUNT_ID, 'msg-001');
      expect(email.body.length).toBeLessThanOrEqual(8000 + 50); // allow for truncation notice
      expect(email.body).toContain('[truncated]');
    });

    it('throws GmailBodyTooLargeError for HTML-only body > 50KB', async () => {
      const largeHtml = '<html>' + '<p>content</p>'.repeat(4000) + '</html>'; // ~60KB
      const detail = makeMessageDetail(largeHtml, 'text/html');
      mockMessagesGet.mockResolvedValue(detail);

      await expect(service.getEmail('user-123', ACCOUNT_ID, 'msg-001')).rejects.toThrow(GmailBodyTooLargeError);
    });

    it('retries once on 429 then returns email', async () => {
      const quotaError = Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
      mockMessagesGet
        .mockRejectedValueOnce(quotaError)
        .mockResolvedValueOnce(makeMessageDetail('body'));

      const email = await service.getEmail('user-123', ACCOUNT_ID, 'msg-001');
      expect(mockMessagesGet).toHaveBeenCalledTimes(2);
      expect(email.body).toBe('body');
    });

    it('throws GmailQuotaError if 429 persists after retry', async () => {
      const quotaError = Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
      mockMessagesGet.mockRejectedValue(quotaError);

      await expect(service.getEmail('user-123', ACCOUNT_ID, 'msg-001')).rejects.toThrow(GmailQuotaError);
    });
  });

  // ── getEmails (batch) ─────────────────────────────────────────────────────
  describe('getEmails', () => {
    beforeEach(() => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT);
    });

    it('returns empty array for empty input', async () => {
      const results = await service.getEmails('user-123', ACCOUNT_ID, []);
      expect(results).toEqual([]);
    });

    it('fetches multiple emails via batch API and returns results in order', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: {
          get: (h: string) => h === 'content-type' ? 'multipart/mixed; boundary=batch_boundary_xyz' : null,
        },
        text: async () => {
          const makeMessageJson = (id: string, subject: string) => JSON.stringify({
            id,
            threadId: `thread-${id}`,
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'Subject', value: subject },
                { name: 'From', value: 'sender@example.com' },
                { name: 'To', value: 'test@gmail.com' },
                { name: 'Date', value: 'Mon, 1 Jan 2024 10:00:00 +0000' },
              ],
              body: { size: 5, data: Buffer.from('hello').toString('base64url') },
              parts: [],
            },
            snippet: 'hello snippet',
          });

          return [
            '--batch_boundary_xyz',
            'Content-Type: application/http',
            'Content-ID: response-item1',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            makeMessageJson('msg-001', 'Subject One'),
            '--batch_boundary_xyz',
            'Content-Type: application/http',
            'Content-ID: response-item2',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            makeMessageJson('msg-002', 'Subject Two'),
            '--batch_boundary_xyz--',
          ].join('\r\n');
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const results = await service.getEmails('user-123', ACCOUNT_ID, ['msg-001', 'msg-002']);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ id: 'msg-001', subject: 'Subject One', body: 'hello' });
      expect(results[1]).toMatchObject({ id: 'msg-002', subject: 'Subject Two', body: 'hello' });
    });

    it('returns error entry for failed messages without failing the batch', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: {
          get: (h: string) => h === 'content-type' ? 'multipart/mixed; boundary=batch_boundary_xyz' : null,
        },
        text: async () => {
          const goodJson = JSON.stringify({
            id: 'msg-001',
            threadId: 'thread-001',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'Subject', value: 'Good Email' },
                { name: 'From', value: 'sender@example.com' },
                { name: 'To', value: 'test@gmail.com' },
                { name: 'Date', value: 'Mon, 1 Jan 2024 10:00:00 +0000' },
              ],
              body: { size: 2, data: Buffer.from('hi').toString('base64url') },
              parts: [],
            },
            snippet: 'hi',
          });
          const badJson = JSON.stringify({ error: { code: 404, message: 'Not Found' } });

          return [
            '--batch_boundary_xyz',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 200 OK',
            '',
            goodJson,
            '--batch_boundary_xyz',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 404 Not Found',
            '',
            badJson,
            '--batch_boundary_xyz--',
          ].join('\r\n');
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const results = await service.getEmails('user-123', ACCOUNT_ID, ['msg-001', 'msg-999']);
      expect(results[0]).toMatchObject({ id: 'msg-001', body: 'hi' });
      expect(results[1]).toMatchObject({ id: 'msg-999', error: expect.stringContaining('Not Found') });
    });

    it('throws GmailQuotaError if batch request returns 429 twice', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 429,
        headers: { get: () => null },
        text: async () => '',
      });

      await expect(service.getEmails('user-123', ACCOUNT_ID, ['msg-001'])).rejects.toThrow(GmailQuotaError);
      expect(global.fetch).toHaveBeenCalledTimes(2); // initial + 1 retry
    });
  });

  // ── listEmails ────────────────────────────────────────────────────────────
  describe('listEmails', () => {
    beforeEach(() => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT);
    });

    it('lists emails from INBOX by default via batch metadata fetch', async () => {
      mockMessagesList.mockResolvedValue(mockListResponse);
      global.fetch = jest.fn().mockResolvedValue(makeBatchMetaResponse(mockListResponse.data.messages));

      const results = await service.listEmails('user-123', ACCOUNT_ID);
      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'me', labelIds: ['INBOX'], maxResults: 20 })
      );
      expect(results).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledTimes(1); // single batch call
    });

    it('accepts custom folder', async () => {
      mockMessagesList.mockResolvedValue(mockListResponse);
      global.fetch = jest.fn().mockResolvedValue(makeBatchMetaResponse(mockListResponse.data.messages));

      await service.listEmails('user-123', ACCOUNT_ID, 'SENT', 5);
      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({ labelIds: ['SENT'], maxResults: 5 })
      );
    });
  });

  // ── sendEmail ─────────────────────────────────────────────────────────────
  describe('sendEmail', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      service = new GmailService();
    });

    it('throws GmailSendNotAuthorizedError when send scope is not granted', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT); // only has gmail.readonly
      await expect(
        service.sendEmail('user-123', ACCOUNT_ID, { to: 'bob@example.com', subject: 'Hi', body: 'Hello' })
      ).rejects.toThrow(GmailSendNotAuthorizedError);
    });

    it('throws GmailNotConnectedError when account is not found', async () => {
      mockGetAccountById.mockResolvedValue(null);
      await expect(
        service.sendEmail('user-123', ACCOUNT_ID, { to: 'bob@example.com', subject: 'Hi', body: 'Hello' })
      ).rejects.toThrow(GmailNotConnectedError);
    });

    it('sends a plain-text email and returns messageId + threadId', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT_WITH_SEND);
      mockMessagesSend.mockResolvedValueOnce({ data: { id: 'sent-001', threadId: 'thread-001' } });

      const result = await service.sendEmail('user-123', ACCOUNT_ID, {
        to: 'bob@example.com',
        subject: 'Hello Bob',
        body: 'Just checking in.',
      });

      expect(result).toEqual({ messageId: 'sent-001', threadId: 'thread-001' });
      expect(mockMessagesSend).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          requestBody: expect.objectContaining({ raw: expect.any(String) }),
        })
      );
    });

    it('sends to multiple recipients with CC and BCC', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT_WITH_SEND);
      mockMessagesSend.mockResolvedValueOnce({ data: { id: 'sent-002', threadId: 'thread-002' } });

      await service.sendEmail('user-123', ACCOUNT_ID, {
        to: ['alice@example.com', 'bob@example.com'],
        subject: 'Team update',
        body: 'See attached.',
        cc: 'charlie@example.com',
        bcc: 'boss@example.com',
      });

      const sentArg = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(sentArg.requestBody.raw, 'base64').toString('utf-8');
      expect(decoded).toContain('alice@example.com, bob@example.com');
      expect(decoded).toContain('Cc: charlie@example.com');
      expect(decoded).toContain('Bcc: boss@example.com');
    });

    it('sends a reply in the correct thread with In-Reply-To header', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT_WITH_SEND);
      // Mock fetching the original message
      mockMessagesGet.mockResolvedValueOnce({
        data: {
          threadId: 'thread-original',
          payload: {
            headers: [
              { name: 'Message-ID', value: '<original-msg-id@mail.gmail.com>' },
              { name: 'References', value: '' },
            ],
          },
        },
      });
      mockMessagesSend.mockResolvedValueOnce({ data: { id: 'sent-003', threadId: 'thread-original' } });

      const result = await service.sendEmail('user-123', ACCOUNT_ID, {
        to: 'alice@example.com',
        subject: 'Re: Hello',
        body: 'Thanks!',
        replyToMessageId: 'orig-001',
      });

      expect(result.threadId).toBe('thread-original');
      const sentArg = mockMessagesSend.mock.calls[0][0];
      expect(sentArg.requestBody.threadId).toBe('thread-original');
      const decoded = Buffer.from(sentArg.requestBody.raw, 'base64').toString('utf-8');
      expect(decoded).toContain('In-Reply-To: <original-msg-id@mail.gmail.com>');
    });

    it('encodes non-ASCII characters in subject using RFC 2047 encoded-word format', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT_WITH_SEND);
      mockMessagesSend.mockResolvedValueOnce({ data: { id: 'sent-uni', threadId: 'thread-uni' } });

      await service.sendEmail('user-123', ACCOUNT_ID, {
        to: 'alice@example.com',
        subject: 'CMO Dinner — The New CMO Mandate: Marketing in the Agentic Era',
        body: 'Details inside.',
      });

      const sentArg = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(sentArg.requestBody.raw, 'base64').toString('utf-8');
      // Subject must use RFC 2047 encoded-word, not raw unicode escape sequences
      expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=/);
      expect(decoded).not.toContain('Subject: CMO Dinner —');
    });

    it('leaves ASCII-only subjects unencoded', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT_WITH_SEND);
      mockMessagesSend.mockResolvedValueOnce({ data: { id: 'sent-ascii', threadId: 'thread-ascii' } });

      await service.sendEmail('user-123', ACCOUNT_ID, {
        to: 'alice@example.com',
        subject: 'Hello World',
        body: 'Plain ASCII subject.',
      });

      const sentArg = mockMessagesSend.mock.calls[0][0];
      const decoded = Buffer.from(sentArg.requestBody.raw, 'base64').toString('utf-8');
      expect(decoded).toContain('Subject: Hello World');
    });

    it('throws GmailQuotaError on 429 from messages.send (after retry)', async () => {
      mockGetAccountById.mockResolvedValue(VALID_ACCOUNT_WITH_SEND);
      const quotaErr = Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
      mockMessagesSend.mockRejectedValue(quotaErr);

      await expect(
        service.sendEmail('user-123', ACCOUNT_ID, { to: 'bob@example.com', subject: 'Hi', body: 'Hello' })
      ).rejects.toThrow(GmailQuotaError);
      expect(mockMessagesSend).toHaveBeenCalledTimes(2); // initial + 1 retry
    });
  });
});
