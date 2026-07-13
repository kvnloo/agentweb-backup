import axios from 'axios';
import {
  OutlookService,
  OutlookNotConnectedError,
  OutlookTokenRevokedError,
  OutlookSendNotAuthorizedError,
} from '../services/outlookService';
import { getAccountById, updateAccountTokens } from '../services/connectedAccountsDb';
import { getOutlookConfig } from '../config/integrations';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getOutlookConfig: jest.fn(),
}));

// axios's typed mocks require a full AxiosResponse; these stubs only carry what the
// service reads, so widen the mock rather than pad every fixture.
const mockAxios = axios as unknown as { post: jest.Mock; get: jest.Mock };
const mockGetAccount = getAccountById as jest.Mock;
const mockUpdateTokens = updateAccountTokens as jest.Mock;
const mockGetConfig = getOutlookConfig as jest.Mock;

const CONFIG = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3001/api/oauth/outlook/callback',
  scopes: ['https://graph.microsoft.com/Mail.Send', 'offline_access'],
  authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  profileUrl: 'https://graph.microsoft.com/v1.0/me',
  sendMailUrl: 'https://graph.microsoft.com/v1.0/me/sendMail',
};

const account = (over: any = {}) => ({
  account_id: 'habeb@baldwin.com',
  platform: 'outlook',
  config: {
    account_type: 'outlook',
    email: 'habeb@baldwin.com',
    access_token: 'access-current',
    refresh_token: 'refresh-current',
    token_expires_at: Date.now() + 60 * 60 * 1000, // an hour out — not expiring
    granted_scopes: ['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.Read'],
    ...over,
  },
});

let service: OutlookService;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfig.mockResolvedValue(CONFIG);
  service = new OutlookService();
});

describe('OutlookService — not connected', () => {
  it('throws OutlookNotConnectedError when the account does not exist', async () => {
    mockGetAccount.mockResolvedValue(null);
    await expect(
      service.sendEmail('u1', 'missing', { to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(OutlookNotConnectedError);
  });
});

describe('OutlookService — refresh token ROTATION (the Microsoft-specific trap)', () => {
  it('persists the NEW refresh_token that Microsoft returns on refresh', async () => {
    mockGetAccount.mockResolvedValue(
      account({ token_expires_at: Date.now() - 1000 }), // expired -> must refresh
    );
    mockAxios.post.mockResolvedValueOnce({
      data: {
        access_token: 'access-NEW',
        refresh_token: 'refresh-ROTATED', // Microsoft rotates; Google does not
        expires_in: 3600,
      },
    });
    mockAxios.post.mockResolvedValueOnce({ status: 202, data: {} }); // sendMail

    await service.sendEmail('u1', 'habeb@baldwin.com', { to: 'a@b.com', subject: 's', body: 'b' });

    expect(mockUpdateTokens).toHaveBeenCalledWith(
      'u1',
      'outlook',
      expect.objectContaining({
        access_token: 'access-NEW',
        refresh_token: 'refresh-ROTATED', // <-- if this regresses, the connection dies after one refresh
      }),
      'habeb@baldwin.com',
    );
  });

  it('keeps the existing refresh_token when Microsoft omits it from the response', async () => {
    mockGetAccount.mockResolvedValue(account({ token_expires_at: Date.now() - 1000 }));
    mockAxios.post.mockResolvedValueOnce({
      data: { access_token: 'access-NEW', expires_in: 3600 }, // no refresh_token
    });
    mockAxios.post.mockResolvedValueOnce({ status: 202, data: {} });

    await service.sendEmail('u1', 'habeb@baldwin.com', { to: 'a@b.com', subject: 's', body: 'b' });

    expect(mockUpdateTokens).toHaveBeenCalledWith(
      'u1',
      'outlook',
      expect.objectContaining({ refresh_token: 'refresh-current' }),
      'habeb@baldwin.com',
    );
  });

  it('does NOT refresh when the token is still valid', async () => {
    mockGetAccount.mockResolvedValue(account()); // expires in an hour
    mockAxios.post.mockResolvedValueOnce({ status: 202, data: {} }); // only the sendMail call

    await service.sendEmail('u1', 'habeb@baldwin.com', { to: 'a@b.com', subject: 's', body: 'b' });

    expect(mockUpdateTokens).not.toHaveBeenCalled();
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
    expect(mockAxios.post).toHaveBeenCalledWith(CONFIG.sendMailUrl, expect.anything(), expect.anything());
  });

  it('throws OutlookTokenRevokedError when the refresh token is rejected', async () => {
    mockGetAccount.mockResolvedValue(account({ token_expires_at: Date.now() - 1000 }));
    mockAxios.post.mockRejectedValueOnce({
      response: { status: 400, data: { error: 'invalid_grant' } },
    });

    await expect(
      service.sendEmail('u1', 'habeb@baldwin.com', { to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(OutlookTokenRevokedError);
  });

  it('throws OutlookTokenRevokedError when the stored account has no refresh token at all', async () => {
    mockGetAccount.mockResolvedValue(
      account({ token_expires_at: Date.now() - 1000, refresh_token: undefined }),
    );

    await expect(
      service.sendEmail('u1', 'habeb@baldwin.com', { to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(OutlookTokenRevokedError);
    expect(mockAxios.post).not.toHaveBeenCalled();
  });
});

describe('OutlookService — sendEmail', () => {
  it('refuses to send when Mail.Send was not granted', async () => {
    mockGetAccount.mockResolvedValue(account({ granted_scopes: ['https://graph.microsoft.com/Mail.Read'] }));
    await expect(
      service.sendEmail('u1', 'habeb@baldwin.com', { to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(OutlookSendNotAuthorizedError);
    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  it('POSTs a Graph sendMail payload with a bearer token', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.post.mockResolvedValueOnce({ status: 202, data: {} });

    await service.sendEmail('u1', 'habeb@baldwin.com', {
      to: 'lead@contractor.com',
      subject: 'Surety bonds',
      body: '<p>hello</p>',
      isHtml: true,
    });

    const [url, payload, opts] = mockAxios.post.mock.calls[0];
    expect(url).toBe(CONFIG.sendMailUrl);
    expect(payload).toMatchObject({
      message: {
        subject: 'Surety bonds',
        body: { contentType: 'HTML', content: '<p>hello</p>' },
        toRecipients: [{ emailAddress: { address: 'lead@contractor.com' } }],
      },
      saveToSentItems: true, // the whole point: it lands in the customer's Sent folder
    });
    expect((opts as any).headers.Authorization).toBe('Bearer access-current');
  });

  it('sends text/plain when isHtml is not set', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.post.mockResolvedValueOnce({ status: 202, data: {} });

    await service.sendEmail('u1', 'habeb@baldwin.com', { to: 'a@b.com', subject: 's', body: 'plain' });

    const [, payload] = mockAxios.post.mock.calls[0];
    expect((payload as any).message.body.contentType).toBe('Text');
  });

  it('supports multiple recipients, cc and bcc', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.post.mockResolvedValueOnce({ status: 202, data: {} });

    await service.sendEmail('u1', 'habeb@baldwin.com', {
      to: ['a@b.com', 'c@d.com'],
      cc: 'cc@x.com',
      bcc: ['bcc@y.com'],
      subject: 's',
      body: 'b',
    });

    const [, payload] = mockAxios.post.mock.calls[0];
    const m = (payload as any).message;
    expect(m.toRecipients).toHaveLength(2);
    expect(m.ccRecipients).toEqual([{ emailAddress: { address: 'cc@x.com' } }]);
    expect(m.bccRecipients).toEqual([{ emailAddress: { address: 'bcc@y.com' } }]);
  });

  it('returns a messageId and threadId', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.post.mockResolvedValueOnce({ status: 202, data: {} });

    const result = await service.sendEmail('u1', 'habeb@baldwin.com', {
      to: 'a@b.com',
      subject: 's',
      body: 'b',
    });

    expect(result.messageId).toBeTruthy();
    expect(result).toHaveProperty('threadId');
  });
});

describe('OutlookService — read side', () => {
  const graphMessage = {
    id: 'msg-1',
    conversationId: 'conv-1',
    subject: 'Re: bonds',
    from: { emailAddress: { address: 'lead@contractor.com', name: 'Lead' } },
    receivedDateTime: '2026-07-13T10:00:00Z',
    bodyPreview: 'sounds good',
    toRecipients: [{ emailAddress: { address: 'habeb@baldwin.com' } }],
    body: { content: '<p>sounds good</p>', contentType: 'html' },
    hasAttachments: false,
  };

  it('maps Graph messages onto EmailSummary for listEmails', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.get.mockResolvedValueOnce({ data: { value: [graphMessage] } });

    const out = await service.listEmails('u1', 'habeb@baldwin.com', 'INBOX', 10);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'msg-1',
      threadId: 'conv-1',
      subject: 'Re: bonds',
      snippet: 'sounds good',
    });
    expect(out[0].from).toContain('lead@contractor.com');
  });

  it('maps Graph messages for searchEmails', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.get.mockResolvedValueOnce({ data: { value: [graphMessage] } });

    const out = await service.searchEmails('u1', 'habeb@baldwin.com', 'bonds', 5);
    expect(out[0].id).toBe('msg-1');
  });

  it('returns full detail for getEmails', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.get.mockResolvedValueOnce({ data: graphMessage });

    const out = await service.getEmails('u1', 'habeb@baldwin.com', ['msg-1']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'msg-1', body: '<p>sounds good</p>', hasAttachments: false });
  });

  it('reports a per-message error instead of failing the whole batch', async () => {
    mockGetAccount.mockResolvedValue(account());
    mockAxios.get.mockRejectedValueOnce({ response: { status: 404 } });

    const out = await service.getEmails('u1', 'habeb@baldwin.com', ['gone']);
    expect(out[0]).toMatchObject({ id: 'gone' });
    expect((out[0] as any).error).toBeTruthy();
  });
});
