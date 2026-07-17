import axios from 'axios';
import { getAccountById, updateAccountTokens, OutlookConfig } from './connectedAccountsDb';
import { getOutlookConfig } from '../config/integrations';
import { EmailProviderError } from './emailProviderService';
import type {
  IEmailService,
  SendEmailParams,
  SentEmailResult,
  EmailSummary,
  EmailDetail,
  EmailBatchResult,
} from './emailProviderService';

// ── Custom Errors ──────────────────────────────────────────────────────────

export class OutlookNotConnectedError extends EmailProviderError {
  constructor() {
    super('Outlook account not connected. Please connect your Microsoft 365 mailbox in Settings → Connected Accounts.');
    this.name = 'OutlookNotConnectedError';
  }
}

export class OutlookTokenRevokedError extends EmailProviderError {
  constructor() {
    super('Outlook access was revoked or expired. Please reconnect your Microsoft 365 mailbox in Settings → Connected Accounts.');
    this.name = 'OutlookTokenRevokedError';
  }
}

export class OutlookSendNotAuthorizedError extends EmailProviderError {
  constructor() {
    super('This Outlook account was connected without send permission. Reconnect it and grant Mail.Send.');
    this.name = 'OutlookSendNotAuthorizedError';
  }
}

export class OutlookQuotaError extends EmailProviderError {
  constructor(message = 'Microsoft Graph is throttling this mailbox. Try again shortly.') {
    super(message);
    this.name = 'OutlookQuotaError';
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const MAIL_SEND_SCOPE = 'Mail.Send';

// Per-account refresh lock — prevents two concurrent sends both refreshing and
// racing to persist a rotated refresh token (which would invalidate one of them).
const refreshLocks = new Map<string, Promise<string>>();

const toRecipients = (addresses?: string | string[]) => {
  if (!addresses) return undefined;
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list.filter(Boolean).map((address) => ({ emailAddress: { address } }));
};

const graphError = (error: any): Error => {
  const status = error?.response?.status;
  if (status === 401) return new OutlookTokenRevokedError();
  if (status === 429 || status === 503) return new OutlookQuotaError();
  const detail = error?.response?.data?.error?.message || error?.message || 'Unknown Graph error';
  return new Error(`Microsoft Graph request failed: ${detail}`);
};

// ── OutlookService ─────────────────────────────────────────────────────────

export class OutlookService implements IEmailService {

  // ── Token management ─────────────────────────────────────────────────────

  private async getValidAccessToken(userId: string, accountId: string): Promise<string> {
    const account = await getAccountById(accountId, userId, 'outlook');
    if (!account) throw new OutlookNotConnectedError();

    const config = account.config as OutlookConfig;
    const isExpiringSoon = config.token_expires_at - Date.now() < TOKEN_REFRESH_BUFFER_MS;

    if (!isExpiringSoon) {
      return config.access_token;
    }

    const lockKey = `${userId}:${accountId}`;
    const existing = refreshLocks.get(lockKey);
    if (existing) return existing;

    const refresh = this.refreshToken(userId, accountId, config).finally(() => {
      refreshLocks.delete(lockKey);
    });
    refreshLocks.set(lockKey, refresh);
    return refresh;
  }

  /**
   * Exchange the refresh token for a new access token.
   *
   * CRITICAL: Microsoft ROTATES refresh tokens. Every refresh may return a *new*
   * refresh_token, and the old one stops working. Google does not do this, so the
   * Gmail equivalent of this method does not persist it — copying that behaviour
   * here would kill the connection after the first refresh.
   */
  private async refreshToken(userId: string, accountId: string, config: OutlookConfig): Promise<string> {
    const oauth = await getOutlookConfig();

    // offline_access should always grant one, but an account stored without it can
    // never refresh — surface that as "reconnect" rather than a confusing 400.
    if (!config.refresh_token) {
      throw new OutlookTokenRevokedError();
    }

    const form = new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: config.refresh_token,
      scope: oauth.scopes.join(' '),
    });

    let data: any;
    try {
      const response = await axios.post(oauth.tokenUrl, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      data = response.data;
    } catch (error: any) {
      const code = error?.response?.data?.error;
      if (code === 'invalid_grant' || error?.response?.status === 400) {
        throw new OutlookTokenRevokedError();
      }
      throw graphError(error);
    }

    if (!data?.access_token) {
      throw new OutlookTokenRevokedError();
    }

    await updateAccountTokens(
      userId,
      'outlook',
      {
        access_token: data.access_token,
        // Persist the rotated token. Fall back to the current one when Microsoft
        // reuses it rather than issuing a fresh one.
        refresh_token: data.refresh_token || config.refresh_token,
        token_expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      },
      accountId,
    );

    return data.access_token;
  }

  private async authHeader(userId: string, accountId: string) {
    const token = await this.getValidAccessToken(userId, accountId);
    return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  }

  private async assertCanSend(userId: string, accountId: string): Promise<void> {
    const account = await getAccountById(accountId, userId, 'outlook');
    if (!account) throw new OutlookNotConnectedError();
    const config = account.config as OutlookConfig;
    const granted = config.granted_scopes || [];
    const canSend = granted.some((s) => s.includes(MAIL_SEND_SCOPE));
    if (!canSend) throw new OutlookSendNotAuthorizedError();
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendEmail(userId: string, accountId: string, params: SendEmailParams): Promise<SentEmailResult> {
    await this.assertCanSend(userId, accountId);

    const oauth = await getOutlookConfig();
    const auth = await this.authHeader(userId, accountId);

    const message: any = {
      subject: params.subject,
      body: {
        contentType: params.isHtml ? 'HTML' : 'Text',
        content: params.body,
      },
      toRecipients: toRecipients(params.to),
    };

    const cc = toRecipients(params.cc);
    if (cc) message.ccRecipients = cc;
    const bcc = toRecipients(params.bcc);
    if (bcc) message.bccRecipients = bcc;

    try {
      await axios.post(
        oauth.sendMailUrl,
        {
          message,
          // The reason this integration exists: the mail lands in the customer's
          // own Sent Items, not just on the wire.
          saveToSentItems: true,
        },
        auth,
      );
    } catch (error: any) {
      throw graphError(error);
    }

    // Graph's sendMail returns 202 Accepted with an empty body — it does not hand
    // back a message id. Callers only use this for correlation, so synthesize one.
    return {
      messageId: `outlook-${accountId}-${Date.now()}`,
      threadId: '',
    };
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  private toSummary(m: any): EmailSummary {
    const fromAddr = m?.from?.emailAddress?.address || '';
    const fromName = m?.from?.emailAddress?.name || '';
    return {
      id: m.id,
      threadId: m.conversationId || '',
      subject: m.subject || '',
      from: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
      date: m.receivedDateTime || '',
      snippet: m.bodyPreview || '',
    };
  }

  private toDetail(m: any): EmailDetail {
    return {
      ...this.toSummary(m),
      to: (m.toRecipients || [])
        .map((r: any) => r?.emailAddress?.address)
        .filter(Boolean)
        .join(', '),
      body: m?.body?.content || '',
      hasAttachments: !!m.hasAttachments,
    };
  }

  async listEmails(userId: string, accountId: string, folder = 'INBOX', maxResults = 20): Promise<EmailSummary[]> {
    const auth = await this.authHeader(userId, accountId);
    // Graph names the inbox 'Inbox'; accept the Gmail-style 'INBOX' the tool layer sends.
    const mailFolder = folder.toUpperCase() === 'INBOX' ? 'Inbox' : folder;
    const url = `${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(mailFolder)}/messages?$top=${maxResults}&$orderby=receivedDateTime desc`;

    try {
      const { data } = await axios.get<any>(url, auth);
      return (data?.value || []).map((m: any) => this.toSummary(m));
    } catch (error: any) {
      throw graphError(error);
    }
  }

  async searchEmails(userId: string, accountId: string, query: string, maxResults = 10): Promise<EmailSummary[]> {
    const auth = await this.authHeader(userId, accountId);
    const url = `${GRAPH_BASE}/me/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}`;

    try {
      const { data } = await axios.get<any>(url, auth);
      return (data?.value || []).map((m: any) => this.toSummary(m));
    } catch (error: any) {
      throw graphError(error);
    }
  }

  /**
   * Recent Inbox messages since a cursor — the read side of the ENG-266 Part 3
   * bounce/complaint monitor. Stays transport-only and generic: NDR
   * classification is the cron job's job, not this service's.
   */
  async listRecentInboxMessages(
    userId: string,
    accountId: string,
    sinceISO: string,
    maxResults = 50,
  ): Promise<Array<{ id: string; subject: string; receivedDateTime: string; from: string; body: string }>> {
    const auth = await this.authHeader(userId, accountId);
    const url =
      `${GRAPH_BASE}/me/mailFolders('Inbox')/messages` +
      `?$filter=receivedDateTime ge ${encodeURIComponent(sinceISO)}` +
      `&$select=id,subject,receivedDateTime,from,body` +
      `&$orderby=receivedDateTime asc` +
      `&$top=${maxResults}`;

    try {
      const { data } = await axios.get<any>(url, auth);
      return (data?.value || []).map((m: any) => {
        const fromAddr = m?.from?.emailAddress?.address || '';
        const fromName = m?.from?.emailAddress?.name || '';
        return {
          id: m.id,
          subject: m.subject || '',
          receivedDateTime: m.receivedDateTime || '',
          from: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
          body: m?.body?.content || '',
        };
      });
    } catch (error: any) {
      throw graphError(error);
    }
  }

  async getEmails(userId: string, accountId: string, messageIds: string[]): Promise<EmailBatchResult[]> {
    const auth = await this.authHeader(userId, accountId);

    // Graph has a $batch endpoint, but at the volumes this is used for the added
    // complexity is not worth it. Fetch individually and degrade per message.
    return Promise.all(
      messageIds.map(async (id): Promise<EmailBatchResult> => {
        try {
          const { data } = await axios.get<any>(`${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}`, auth);
          return this.toDetail(data);
        } catch (error: any) {
          return { id, error: graphError(error).message };
        }
      }),
    );
  }
}

export const outlookService = new OutlookService();
