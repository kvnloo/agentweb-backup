import { google } from 'googleapis';
import { getAccountById, updateAccountTokens, GmailConfig } from './connectedAccountsDb';
import { getGmailConfig } from '../config/integrations';
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

export class GmailNotConnectedError extends EmailProviderError {
  constructor() {
    super('Gmail account not connected. Please connect your Gmail account in Settings → Connected Accounts.');
    this.name = 'GmailNotConnectedError';
  }
}

export class GmailTokenRevokedError extends EmailProviderError {
  constructor(msg = 'Gmail access was revoked. Please reconnect your Gmail account in Settings → Connected Accounts.') {
    super(msg);
    this.name = 'GmailTokenRevokedError';
  }
}

export class GmailQuotaError extends EmailProviderError {
  constructor() {
    super('Gmail quota exceeded. Please try again in a moment.');
    this.name = 'GmailQuotaError';
  }
}

export class GmailBodyTooLargeError extends EmailProviderError {
  constructor() {
    super(
      'Email body is too large (HTML content exceeds 50KB). ' +
      'Ask the user to open the email directly in Gmail, or specify which part they want — ' +
      'e.g. "just the subject and sender" or "first paragraph only".'
    );
    this.name = 'GmailBodyTooLargeError';
  }
}

export class GmailSendNotAuthorizedError extends EmailProviderError {
  constructor() {
    super(
      'Gmail send permission was not granted. Please go to Settings → Connected Accounts, ' +
      'disconnect Gmail, and reconnect to allow sending emails.'
    );
    this.name = 'GmailSendNotAuthorizedError';
  }
}

// ── Constants ─────────────────────────────────────────────────────────────

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const MAX_BODY_CHARS = 8000;
const MAX_HTML_BYTES = 50 * 1024; // 50KB threshold for HTML error
const QUOTA_RETRY_DELAY_MS = 1000;
const GMAIL_BATCH_URL = 'https://www.googleapis.com/batch/gmail/v1';
const BATCH_CHUNK_SIZE = 100; // Gmail batch API limit per request

// ── Per-user refresh lock (prevents concurrent refresh races) ──────────────

const refreshLocks = new Map<string, Promise<string>>();

// ── Email result types ─────────────────────────────────────────────────────
// These now live in emailProviderService (they are provider-neutral). Re-exported
// here so existing importers of gmailService keep working.

export type { EmailSummary, EmailDetail, EmailBatchResult } from './emailProviderService';

// ── GmailService ───────────────────────────────────────────────────────────

export class GmailService implements IEmailService {

  // ── Token management ─────────────────────────────────────────────────────

  private async getValidAccessToken(userId: string, accountId: string): Promise<string> {
    const account = await getAccountById(accountId, userId, 'gmail');
    if (!account) throw new GmailNotConnectedError();

    const config = account.config as GmailConfig;
    const isExpiringSoon = config.token_expires_at - Date.now() < TOKEN_REFRESH_BUFFER_MS;

    if (!isExpiringSoon) {
      return config.access_token;
    }

    // Token needs refresh — use per-account lock to avoid races
    const lockKey = `${userId}:${accountId}`;
    if (refreshLocks.has(lockKey)) {
      return refreshLocks.get(lockKey)!;
    }

    const refreshPromise = this.refreshToken(userId, accountId, config).finally(() => {
      refreshLocks.delete(lockKey);
    });
    refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  private async refreshToken(userId: string, accountId: string, config: GmailConfig): Promise<string> {
    if (!config.refresh_token) {
      throw new GmailTokenRevokedError('No refresh token available. Please reconnect your Gmail account.');
    }

    const gmailConfig = await getGmailConfig();
    const oauth2Client = new google.auth.OAuth2(
      gmailConfig.clientId,
      gmailConfig.clientSecret,
      gmailConfig.redirectUri
    );
    oauth2Client.setCredentials({
      refresh_token: config.refresh_token,
      access_token: config.access_token,
    });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      const newToken = credentials.access_token!;
      const expiresAt = credentials.expiry_date || Date.now() + 3600 * 1000;

      await updateAccountTokens(userId, 'gmail', {
        access_token: newToken,
        token_expires_at: expiresAt,
        // Google does not rotate refresh tokens; preserve the existing one
      }, accountId);

      return newToken;
    } catch (err: any) {
      if (
        err.message?.includes('invalid_grant') ||
        err.message?.includes('unauthorized_client') ||
        err.message?.includes('invalid_client') ||
        err.message?.includes('Token has been expired or revoked')
      ) {
        throw new GmailTokenRevokedError();
      }
      throw err; // network error — let caller handle
    }
  }

  // ── Gmail client builder ──────────────────────────────────────────────────

  private async getGmailClient(userId: string, accountId: string) {
    const token = await this.getValidAccessToken(userId, accountId);
    const gmailConfig = await getGmailConfig();
    const oauth2Client = new google.auth.OAuth2(
      gmailConfig.clientId,
      gmailConfig.clientSecret
    );
    oauth2Client.setCredentials({ access_token: token });
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  // ── Quota-aware API call wrapper (one auto-retry on 429) ──────────────────

  private async withQuotaRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.response?.status === 429) {
        await new Promise(resolve => setTimeout(resolve, QUOTA_RETRY_DELAY_MS));
        try {
          return await fn();
        } catch (retryErr: any) {
          if (retryErr?.response?.status === 429) throw new GmailQuotaError();
          throw retryErr;
        }
      }
      throw err;
    }
  }

  // ── Message parsing helpers ───────────────────────────────────────────────

  // Encode a header value per RFC 2047 so non-ASCII characters survive transit.
  // Uses UTF-8 base64 encoded-word format: =?UTF-8?B?...?=
  private encodeMimeHeader(value: string): string {
    if (/^[\x00-\x7F]*$/.test(value)) return value; // pure ASCII — no encoding needed
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
  }

  private getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
    return headers.find(h => (h.name || '').toLowerCase() === name.toLowerCase())?.value || '';
  }

  private decodeBase64Url(data: string): string {
    // Gmail uses base64url (RFC 4648): replace - with + and _ with /
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
  }

  private extractBody(payload: any): { text: string; mimeType: string; sizeBytes: number } {
    const mimeType: string = payload.mimeType || '';

    // Simple single-part message
    if (payload.body?.data) {
      const text = this.decodeBase64Url(payload.body.data);
      return { text, mimeType, sizeBytes: payload.body.size || Buffer.byteLength(text) };
    }

    // Multipart: prefer text/plain, fall back to text/html
    if (payload.parts && Array.isArray(payload.parts)) {
      const plainPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
      if (plainPart?.body?.data) {
        const text = this.decodeBase64Url(plainPart.body.data);
        return { text, mimeType: 'text/plain', sizeBytes: plainPart.body.size || Buffer.byteLength(text) };
      }
      const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
      if (htmlPart?.body?.data) {
        const text = this.decodeBase64Url(htmlPart.body.data);
        return { text, mimeType: 'text/html', sizeBytes: htmlPart.body.size || Buffer.byteLength(text) };
      }
    }

    return { text: '[No body content]', mimeType: 'text/plain', sizeBytes: 0 };
  }

  private processBody(rawText: string, mimeType: string, sizeBytes: number): string {
    // Reject large HTML bodies — caller must ask user what they want
    if (mimeType === 'text/html' && sizeBytes > MAX_HTML_BYTES) {
      throw new GmailBodyTooLargeError();
    }

    // Truncate long plain text
    if (rawText.length > MAX_BODY_CHARS) {
      return rawText.slice(0, MAX_BODY_CHARS) + '\n...[truncated]';
    }

    return rawText;
  }

  private hasAttachmentParts(payload: any): boolean {
    if (!payload.parts) return false;
    return payload.parts.some((p: any) =>
      p.filename && p.filename.length > 0 && p.mimeType !== 'text/plain' && p.mimeType !== 'text/html'
    );
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Search emails using Gmail search syntax (e.g. "from:alice@example.com subject:invoice")
   */
  async searchEmails(userId: string, accountId: string, query: string, maxResults = 10): Promise<EmailSummary[]> {
    const gmail = await this.getGmailClient(userId, accountId);

    const listData = await this.withQuotaRetry(() =>
      gmail.users.messages.list({ userId: 'me', q: query, maxResults })
    );

    const messages = listData.data.messages || [];
    if (messages.length === 0) return [];

    // Single batch request for all metadata instead of N individual calls
    const token = await this.getValidAccessToken(userId, accountId);
    return this.batchFetchSummaries(token, messages as Array<{ id: string; threadId: string }>);
  }

  /**
   * Get the full content of a specific email by ID
   */
  async getEmail(userId: string, accountId: string, messageId: string): Promise<EmailDetail> {
    const gmail = await this.getGmailClient(userId, accountId);

    const detail = await this.withQuotaRetry(() =>
      gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
    );

    const payload = detail.data.payload || {};
    const headers = (payload.headers || []) as Array<{ name?: string | null; value?: string | null }>;
    const { text, mimeType, sizeBytes } = this.extractBody(payload);
    const body = this.processBody(text, mimeType, sizeBytes); // may throw GmailBodyTooLargeError

    return {
      id: messageId,
      threadId: detail.data.threadId || '',
      subject: this.getHeader(headers, 'Subject') || '(no subject)',
      from: this.getHeader(headers, 'From'),
      to: this.getHeader(headers, 'To'),
      date: this.getHeader(headers, 'Date'),
      snippet: detail.data.snippet || '',
      body,
      hasAttachments: this.hasAttachmentParts(payload),
    };
  }

  // ── Batch helpers ─────────────────────────────────────────────────────────

  /**
   * Build a multipart/mixed body for Gmail batch API.
   * Each part is a GET request for one message.
   * format='full' fetches full message; format='metadata' fetches headers only.
   */
  private buildBatchRequestBody(
    messageIds: string[],
    boundary: string,
    format: 'full' | 'metadata' = 'full',
    metadataHeaders: string[] = []
  ): string {
    const parts = messageIds.map((id, i) => {
      let url = `/gmail/v1/users/me/messages/${id}?format=${format}`;
      if (format === 'metadata' && metadataHeaders.length > 0) {
        url += '&' + metadataHeaders.map(h => `metadataHeaders=${encodeURIComponent(h)}`).join('&');
      }
      return [
        `--${boundary}`,
        'Content-Type: application/http',
        `Content-ID: <item${i + 1}>`,
        '',
        `GET ${url}`,
        '',
      ].join('\r\n');
    });
    return parts.join('\r\n') + `\r\n--${boundary}--`;
  }

  /**
   * Parse a multipart/mixed batch response from Gmail.
   * Returns raw parsed JSON body for each part, preserving original order.
   */
  private parseBatchResponse(responseText: string, boundary: string): Array<{ status: number; body: any }> {
    const delimiter = `--${boundary}`;
    const parts = responseText.split(delimiter).slice(1); // skip preamble
    const results: Array<{ status: number; body: any }> = [];

    for (const part of parts) {
      if (part.trim() === '--' || part.trim() === '') continue;

      // Each part: MIME headers \r\n\r\n HTTP-response-line \r\n HTTP-headers \r\n\r\n JSON-body
      const innerHttpStart = part.indexOf('\r\n\r\n');
      if (innerHttpStart === -1) continue;
      const innerHttp = part.slice(innerHttpStart + 4);

      const statusLineEnd = innerHttp.indexOf('\r\n');
      const statusLine = innerHttp.slice(0, statusLineEnd); // e.g. "HTTP/1.1 200 OK"
      const statusCode = parseInt(statusLine.split(' ')[1], 10) || 500;

      const bodyStart = innerHttp.indexOf('\r\n\r\n');
      const rawBody = bodyStart !== -1 ? innerHttp.slice(bodyStart + 4).trim() : '';

      let body: any = null;
      try { body = JSON.parse(rawBody); } catch { /* malformed — leave null */ }

      results.push({ status: statusCode, body });
    }

    return results;
  }

  /**
   * Execute a single Gmail batch HTTP request, with one quota-retry on 429.
   * Returns the parsed multipart parts.
   */
  private async doBatchRequest(
    token: string,
    requestBody: string,
    boundary: string
  ): Promise<Array<{ status: number; body: any }>> {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    };

    const doFetch = () => fetch(GMAIL_BATCH_URL, { method: 'POST', headers, body: requestBody });

    let response = await doFetch();
    if (response.status === 429) {
      await new Promise(resolve => setTimeout(resolve, QUOTA_RETRY_DELAY_MS));
      response = await doFetch();
      if (response.status === 429) throw new GmailQuotaError();
    }

    const responseText = await response.text();
    const responseBoundary = response.headers.get('content-type')?.match(/boundary=([^\s;,"]+)/)?.[1] ?? '';
    return this.parseBatchResponse(responseText, responseBoundary);
  }

  /**
   * Batch-fetch metadata (Subject, From, Date) for a list of messages.
   * Uses a single HTTP request instead of N individual calls.
   * Messages that fail are silently skipped (partial results are fine for summaries).
   */
  private async batchFetchSummaries(
    token: string,
    messages: Array<{ id: string; threadId: string }>
  ): Promise<EmailSummary[]> {
    if (messages.length === 0) return [];

    const ids = messages.map(m => m.id);
    const boundary = `batch_gmail_meta_${Date.now()}`;
    const requestBody = this.buildBatchRequestBody(ids, boundary, 'metadata', ['Subject', 'From', 'Date']);
    const parts = await this.doBatchRequest(token, requestBody, boundary);

    const results: EmailSummary[] = [];
    for (let i = 0; i < messages.length; i++) {
      const part = parts[i];
      if (!part || part.status !== 200 || !part.body) continue; // skip failed
      const headers = (part.body.payload?.headers || []) as Array<{ name?: string | null; value?: string | null }>;
      results.push({
        id: messages[i].id,
        threadId: messages[i].threadId,
        subject: this.getHeader(headers, 'Subject') || '(no subject)',
        from: this.getHeader(headers, 'From'),
        date: this.getHeader(headers, 'Date'),
        snippet: part.body.snippet || '',
      });
    }
    return results;
  }

  /**
   * Fetch multiple messages in a single Gmail batch HTTP request.
   * Automatically chunks into groups of 100 (Gmail's batch limit).
   * Returns results in the same order as the input messageIds.
   */
  async getEmails(userId: string, accountId: string, messageIds: string[]): Promise<EmailBatchResult[]> {
    if (messageIds.length === 0) return [];

    const token = await this.getValidAccessToken(userId, accountId);
    const results: EmailBatchResult[] = [];

    // Process in chunks of BATCH_CHUNK_SIZE
    for (let i = 0; i < messageIds.length; i += BATCH_CHUNK_SIZE) {
      const chunk = messageIds.slice(i, i + BATCH_CHUNK_SIZE);
      const boundary = `batch_gmail_${Date.now()}_${i}`;
      const requestBody = this.buildBatchRequestBody(chunk, boundary);

      const parts = await this.doBatchRequest(token, requestBody, boundary);

      for (let j = 0; j < chunk.length; j++) {
        const id = chunk[j];
        const part = parts[j];

        if (!part || part.status !== 200 || !part.body) {
          const errMsg = part?.body?.error?.message || `Failed to fetch message (HTTP ${part?.status ?? 'unknown'})`;
          results.push({ id, error: errMsg });
          continue;
        }

        try {
          const data = part.body;
          const payload = data.payload || {};
          const headers = (payload.headers || []) as Array<{ name?: string | null; value?: string | null }>;
          const { text, mimeType, sizeBytes } = this.extractBody(payload);
          const emailBody = this.processBody(text, mimeType, sizeBytes);

          results.push({
            id,
            threadId: data.threadId || '',
            subject: this.getHeader(headers, 'Subject') || '(no subject)',
            from: this.getHeader(headers, 'From'),
            to: this.getHeader(headers, 'To'),
            date: this.getHeader(headers, 'Date'),
            snippet: data.snippet || '',
            body: emailBody,
            hasAttachments: this.hasAttachmentParts(payload),
          });
        } catch (parseErr: any) {
          // e.g. GmailBodyTooLargeError for one message — don't fail the whole batch
          results.push({ id, error: parseErr.message });
        }
      }
    }

    return results;
  }

  /**
   * List recent emails from a Gmail label/folder (default: INBOX)
   */
  async listEmails(userId: string, accountId: string, folder = 'INBOX', maxResults = 20): Promise<EmailSummary[]> {
    const gmail = await this.getGmailClient(userId, accountId);

    const listData = await this.withQuotaRetry(() =>
      gmail.users.messages.list({ userId: 'me', labelIds: [folder], maxResults })
    );

    const messages = listData.data.messages || [];
    if (messages.length === 0) return [];

    // Single batch request for all metadata instead of N individual calls
    const token = await this.getValidAccessToken(userId, accountId);
    return this.batchFetchSummaries(token, messages as Array<{ id: string; threadId: string }>);
  }

  /**
   * Send a new email or reply to an existing thread.
   * Requires gmail.send scope — throws GmailSendNotAuthorizedError if not granted.
   */
  async sendEmail(userId: string, accountId: string, params: SendEmailParams): Promise<SentEmailResult> {
    // Verify send scope was granted before touching the API
    const account = await getAccountById(accountId, userId, 'gmail');
    if (!account) throw new GmailNotConnectedError();
    const config = account.config as GmailConfig;
    const hasSendScope = (config.granted_scopes || []).some(s => s.includes('gmail.send'));
    if (!hasSendScope) throw new GmailSendNotAuthorizedError();

    const gmail = await this.getGmailClient(userId, accountId);

    // Normalise recipient lists
    const toStr = Array.isArray(params.to) ? params.to.join(', ') : params.to;
    const ccStr = params.cc ? (Array.isArray(params.cc) ? params.cc.join(', ') : params.cc) : undefined;
    const bccStr = params.bcc ? (Array.isArray(params.bcc) ? params.bcc.join(', ') : params.bcc) : undefined;

    // Thread continuation: fetch original message for threadId + reply headers
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (params.replyToMessageId) {
      const original = await this.withQuotaRetry(() =>
        gmail.users.messages.get({
          userId: 'me',
          id: params.replyToMessageId!,
          format: 'metadata',
          metadataHeaders: ['Message-ID', 'References'],
        })
      );
      threadId = original.data.threadId || undefined;
      const origHeaders = (original.data.payload?.headers || []) as Array<{ name?: string | null; value?: string | null }>;
      const origMessageId = this.getHeader(origHeaders, 'Message-ID');
      const origReferences = this.getHeader(origHeaders, 'References');
      if (origMessageId) {
        inReplyTo = origMessageId;
        references = origReferences ? `${origReferences} ${origMessageId}` : origMessageId;
      }
    }

    // Build RFC 2822 raw message
    const contentType = params.isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    const headerLines: string[] = [
      `To: ${toStr}`,
      `Subject: ${this.encodeMimeHeader(params.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: ${contentType}`,
    ];
    if (ccStr) headerLines.push(`Cc: ${ccStr}`);
    if (bccStr) headerLines.push(`Bcc: ${bccStr}`);
    if (inReplyTo) headerLines.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headerLines.push(`References: ${references}`);
    headerLines.push('', params.body);

    const rawMessage = headerLines.join('\r\n');
    const encoded = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await this.withQuotaRetry(() =>
      gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encoded,
          ...(threadId ? { threadId } : {}),
        },
      })
    );

    return {
      messageId: result.data.id || '',
      threadId: result.data.threadId || '',
    };
  }
}

export const gmailService = new GmailService();
