import { Resend } from 'resend';
import { getSecret } from '../utils/secretsManager';
import axios from 'axios';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';
import {
  isNonProdEmailGuardActive,
  partitionRecipients,
  SUPPRESSED_MESSAGE_ID,
} from '../utils/nonProdEmailGuard';

/**
 * ENG-2652: one SPF/DKIM/DMARC verdict on a received email, as Resend's
 * GET /emails/receiving/{id} returns it. Computed by Resend's receiving mail server,
 * not read from the message headers, so a sender cannot forge it. `gray` means: SPF
 * none/softfail/neutral; DKIM unsigned or signed by a domain other than the From
 * domain; DMARC no policy or p=none.
 */
export type ReceivedEmailAuthVerdict = 'pass' | 'fail' | 'gray' | 'processing_failed' | 'unknown';

export interface ReceivedEmailAuthentication {
  spf?: ReceivedEmailAuthVerdict;
  dkim?: ReceivedEmailAuthVerdict;
  dmarc?: ReceivedEmailAuthVerdict;
}

/**
 * ENG-2840: which line an email waits in. Every email shares ONE paced queue (2 a second). One GTM report sends one email at
 * a time, so on its own it holds a single slot; but when several senders overlap (several reports at once, later several
 * outside agents each emailing many contacts) a password reset or a support reply could wait behind all of their mail.
 *
 *  - `transactional` (the default for every caller that says nothing): mail a person is waiting for. Always served first.
 *    Not bounded, exactly as before this change.
 *  - `bulk`: automated or agent-triggered mail that can wait a few seconds. Served after the transactional lane (with a guaranteed
 *    slot, see BULK_SLOT_EVERY) and bounded: a full lane rejects at once instead of growing without limit.
 */
export type EmailLane = 'transactional' | 'bulk';

/** Thrown, at once, when the bulk lane is full. Nothing was queued and nothing was sent. */
export class EmailQueueFullError extends Error {
  readonly code = 'EMAIL_QUEUE_FULL';

  constructor(
    readonly lane: EmailLane,
    readonly limit: number,
  ) {
    super(`The ${lane} email queue is full (${limit} waiting). Nothing was sent. Try again in a minute.`);
    this.name = 'EmailQueueFullError';
  }
}

/**
 * Parameters for a Resend send.
 *
 * Deliberately NOT the same shape as emailProviderService's SendEmailParams, and no longer
 * sharing its name (ENG-302). The difference is real, not cosmetic:
 *
 *  - Resend needs an explicit `from` — it relays on our behalf and we choose the identity.
 *    A mailbox provider (Gmail/Graph) has no `from`: it stamps the authenticated mailbox,
 *    so anything we passed would be silently ignored on the wire.
 *  - Resend carries `html` AND `text` (the multipart alternative); IEmailService collapses
 *    to a single `body` + `isHtml`.
 *  - `inReplyTo` here is an RFC Message-ID, and `replyTo` is an address. IEmailService's
 *    `replyToMessageId` is a provider-native message handle. Three different concepts.
 *
 * A helper that unifies these (ENG-266 Part 3) must reconcile all three, not just widen a type.
 */
interface ResendSendParams {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  inReplyTo?: string;
  replyTo?: string;
  /** ENG-2367: extra headers (e.g. List-Unsubscribe). */
  headers?: Record<string, string>;
  /** ENG-2840: the line this email waits in. Absent = `transactional`. Never sent to Resend. */
  lane?: EmailLane;
}

interface QueuedEmailSend {
  id: number;
  lane: EmailLane;
  params: ResendSendParams;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

class ResendService {
  private resend: Resend | null = null;
  private apiKey: string | null = null;
  private readonly MAX_RETRIES = 3;
  private readonly BASE_DELAY = 1000; // 1 second base delay
  private readonly MIN_SEND_INTERVAL_MS = 500; // 2 requests/sec
  /** The transactional lane (the queue every email used before lanes existed). */
  private sendQueue: QueuedEmailSend[] = [];
  /** ENG-2840: the bulk lane. Bounded: at most BULK_QUEUE_LIMIT waiting. */
  private bulkQueue: QueuedEmailSend[] = [];
  private readonly BULK_QUEUE_LIMIT = 100;
  /** While a bulk email waits, after this many transactional sends in a row the next send is a bulk one (bulk never starves). */
  private readonly BULK_SLOT_EVERY = 10;
  private transactionalStreak = 0;
  private isQueueWorkerRunning = false;
  private lastSendAt = 0;
  private queueItemId = 0;

  private async initializeResend() {
    if (this.resend) return;

    try {
      // Get Resend API key from AWS Secrets Manager
      const secretName = process.env.NODE_ENV === 'production' 
        ? 'prod/AgentWeb/Resend' 
        : 'dev/AgentWeb/Resend';
      
      this.apiKey = await getSecret(secretName);
      
      if (!this.apiKey) {
        console.error('Resend API key not found in secrets manager');
        return;
      }

      this.resend = new Resend(this.apiKey);
      console.log('Resend service initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Resend service:', error);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isRateLimitError(error: any): boolean {
    return error?.statusCode === 429 ||
           error?.status === 429 ||
           error?.message?.includes('rate_limit_exceeded') ||
           error?.message?.includes('Too many requests');
  }

  private isRetryableError(error: any): boolean {
    if (this.isRateLimitError(error)) {
      return true;
    }

    const status = error?.statusCode || error?.status || error?.response?.status;
    if (typeof status === 'number' && status >= 500) {
      return true;
    }

    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('socket hang up') ||
      message.includes('econnreset') ||
      message.includes('eai_again') ||
      message.includes('network')
    );
  }

  private shouldRetry(attempt: number, error: any): boolean {
    return attempt < this.MAX_RETRIES && this.isRetryableError(error);
  }

  private async waitForRateLimitWindow() {
    const elapsed = Date.now() - this.lastSendAt;
    const remaining = this.MIN_SEND_INTERVAL_MS - elapsed;
    if (remaining > 0) {
      await this.sleep(remaining);
    }
  }

  private toErrorWithMetadata(error: any): Error {
    const fallbackMessage = typeof error === 'string' ? error : JSON.stringify(error);
    const wrappedError: any = new Error(error?.message || fallbackMessage || 'Unknown Resend error');
    wrappedError.statusCode = error?.statusCode || error?.status;
    wrappedError.response = error?.response;
    wrappedError.code = error?.code;
    return wrappedError;
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (this.shouldRetry(attempt, error)) {
          const delay = this.BASE_DELAY * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`${operationName} failed with retryable error (attempt ${attempt}/${this.MAX_RETRIES}), retrying in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          console.error(`${operationName} failed on attempt ${attempt}:`, error);
          break;
        }
      }
    }

    // ENG-164: propagate instead of swallowing to null — callers must see failures.
    console.error(`${operationName} failed permanently after ${this.MAX_RETRIES > 1 ? 'retries' : 'one attempt'}:`, lastError);
    throw lastError;
  }

  /**
   * Like retryWithBackoff, but preserves the legacy null-on-failure contract
   * for the read/domain helpers (their callers branch on null/false/[]).
   * Send operations must NOT use this — send failures propagate (ENG-164).
   */
  private async retryWithBackoffOrNull<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T | null> {
    try {
      return await this.retryWithBackoff(operation, operationName);
    } catch {
      // Final error already logged by retryWithBackoff.
      return null;
    }
  }

  private async processSendQueue() {
    if (this.isQueueWorkerRunning) {
      return;
    }

    this.isQueueWorkerRunning = true;
    console.log('Resend queue worker started');

    try {
      while (this.queuedCount() > 0) {
        // Wait out the pacing gap BEFORE choosing the next email, so mail that arrives during the gap is considered: a
        // password reset that arrives in the 500 ms after a send goes ahead of waiting bulk mail, not behind a bulk email
        // that was already chosen. Nothing leaves the queues except here, so there is still an email to take afterwards.
        await this.waitForRateLimitWindow();
        const queueItem = this.takeNextQueued();
        if (!queueItem) {
          continue;
        }

        const recipient = Array.isArray(queueItem.params.to) ? queueItem.params.to.join(', ') : queueItem.params.to;
        console.log(`Processing Resend queue item #${queueItem.id} (lane=${queueItem.lane}) for: ${recipient} (remaining: ${this.queuedCount()})`);

        // A failed send rejects its own promise; it must never kill the queue
        // worker — later queued emails still get processed.
        try {
          const result = await this.performSend(queueItem.params);
          queueItem.resolve(result);
        } catch (error) {
          queueItem.reject(error);
        } finally {
          this.lastSendAt = Date.now();
        }
      }
    } finally {
      this.isQueueWorkerRunning = false;
      console.log('Resend queue worker idle');

      // Handle race where a new item is enqueued while worker is shutting down.
      if (this.queuedCount() > 0) {
        void this.processSendQueue();
      }
    }
  }

  private queuedCount(): number {
    return this.sendQueue.length + this.bulkQueue.length;
  }

  /**
   * ENG-2840: pick the next email. Transactional first; but while a bulk email waits, every BULK_SLOT_EVERY-th send is
   * the oldest bulk one, so a steady stream of transactional mail cannot starve bulk mail forever. The streak counts only
   * transactional sends made WHILE a bulk email waits: a bulk email that arrives behind a long transactional backlog
   * waits for BULK_SLOT_EVERY more transactional sends (not for the whole backlog), and it is never served early just
   * because transactional mail was busy before it arrived.
   */
  private takeNextQueued(): QueuedEmailSend | undefined {
    if (this.bulkQueue.length === 0) {
      this.transactionalStreak = 0;
      return this.sendQueue.shift();
    }
    if (this.sendQueue.length === 0 || this.transactionalStreak >= this.BULK_SLOT_EVERY) {
      this.transactionalStreak = 0;
      return this.bulkQueue.shift();
    }
    this.transactionalStreak += 1;
    return this.sendQueue.shift();
  }

  private enqueueSend(params: ResendSendParams): Promise<any> {
    const lane: EmailLane = params.lane === 'bulk' ? 'bulk' : 'transactional';

    // A full bulk lane refuses at once: nothing is queued, so nothing waits, and memory stays bounded.
    if (lane === 'bulk' && this.bulkQueue.length >= this.BULK_QUEUE_LIMIT) {
      console.warn(`[resend-queue] Refused a bulk email: the bulk lane is full (${this.BULK_QUEUE_LIMIT} waiting).`);
      return Promise.reject(new EmailQueueFullError('bulk', this.BULK_QUEUE_LIMIT));
    }

    return new Promise((resolve, reject) => {
      const queueItem: QueuedEmailSend = {
        id: ++this.queueItemId,
        lane,
        params,
        resolve,
        reject
      };
      (lane === 'bulk' ? this.bulkQueue : this.sendQueue).push(queueItem);
      console.log(`Queued Resend email #${queueItem.id} (lane=${lane}). Queue size: ${this.sendQueue.length} transactional, ${this.bulkQueue.length} bulk`);
      void this.processSendQueue();
    });
  }

  private async performSend({
    from,
    to,
    subject,
    html,
    text,
    cc,
    inReplyTo,
    replyTo,
    headers
  }: ResendSendParams) {
    await this.initializeResend();

    if (!this.resend) {
      // ENG-164: fail loudly — a missing/unfetchable API key must not turn
      // every send into a silent no-op.
      throw new Error('Resend service not initialized — API key unavailable from Secrets Manager');
    }

    const emailOptions: any = {
      from,
      to: Array.isArray(to) ? to : [to],
      subject
    };

    // Add content based on what's provided
    if (html) {
      emailOptions.html = html;
    }
    if (text) {
      emailOptions.text = text;
    }

    // Add CC if provided
    if (cc) {
      emailOptions.cc = Array.isArray(cc) ? cc : [cc];
    }

    // Add reply-to if provided
    if (replyTo) {
      emailOptions.replyTo = replyTo; // Resend API uses 'replyTo' (camelCase), not 'reply_to'
    }

    // Add reply headers if replying to an email
    if (headers && Object.keys(headers).length > 0) {
      emailOptions.headers = { ...headers };
    }
    if (inReplyTo) {
      emailOptions.headers = {
        ...(emailOptions.headers || {}),
        'In-Reply-To': inReplyTo
      };
    }

    const recipient = Array.isArray(to) ? to.join(', ') : to;
    console.log(`Sending Resend email to: ${recipient}`);
    if (replyTo) {
      console.log(`  Reply-To: ${replyTo}`);
    }

    const result = await this.retryWithBackoff(
      async () => {
        const { data, error } = await this.resend!.emails.send(emailOptions);
        
        if (error) {
          const resendError: any = this.toErrorWithMetadata(error);
          resendError.message = `Resend API error: ${JSON.stringify(error)}`;
          throw resendError;
        }
        
        return data;
      },
      `Email send to ${recipient}`
    );

    console.log('Resend email sent successfully:', result);
    return result;
  }

  /**
   * Send an email through the rate-limited queue.
   *
   * Failure contract (ENG-164): REJECTS on any failure — init failure,
   * non-retryable API error, or exhausted retries. Never resolves `null`
   * for a failed send; a resolved promise means Resend accepted the email.
   *
   * ENG-2840: a `lane: 'bulk'` send also rejects, at once and with `EmailQueueFullError`, when the bulk lane already has
   * its maximum number of emails waiting. Nothing was queued or sent in that case.
   */
  async sendEmail(params: ResendSendParams) {
    // ENG-1215: the single chokepoint every send funnels through — this method,
    // `sendSystemEmail` (which delegates here), and all 28 direct callers in
    // emailService. Guarding here rather than at each call site is the whole
    // point: a new sender added later is covered without anyone remembering to.
    //
    // In production this is a no-op. Everywhere else, `Dev-AW-Users` is a clone
    // of production and holds real customer addresses, so mail is suppressed
    // unless the recipient is explicitly allowlisted.
    if (isNonProdEmailGuardActive()) {
      const partition = partitionRecipients(params.to, params.cc);

      if (partition.suppressEntirely) {
        console.warn(
          `[nonprod-email-guard] Suppressed "${params.subject}" to ` +
            `${partition.blockedTo.join(', ') || '(no recipients)'}` +
            `${partition.blockedCc.length ? ` cc ${partition.blockedCc.join(', ')}` : ''}` +
            ` — NODE_ENV=${process.env.NODE_ENV || 'unset'}. ` +
            'Set NONPROD_EMAIL_ALLOWLIST to permit an address, or ' +
            'NONPROD_EMAIL_ALLOW_ALL=true for a deliberate delivery test.',
        );
        // A synthetic id, clearly labelled. `sendEmailStrict` throws without a
        // string id, and a suppressed send is a deliberate outcome rather than
        // a failure — but an audit row must never be able to pass this off as a
        // real delivery.
        return { id: SUPPRESSED_MESSAGE_ID, suppressed: true };
      }

      if (partition.blockedTo.length || partition.blockedCc.length) {
        console.warn(
          `[nonprod-email-guard] Dropped non-allowlisted recipients from ` +
            `"${params.subject}": ${[...partition.blockedTo, ...partition.blockedCc].join(', ')}`,
        );
        return this.enqueueSend({
          ...params,
          to: partition.allowedTo,
          cc: partition.allowedCc.length ? partition.allowedCc : undefined,
        });
      }
    }

    return this.enqueueSend(params);
  }

  /**
   * Send a system email using the configured system email address
   * This is a convenience method for system-generated emails
   */
  async sendSystemEmail({
    to,
    subject,
    html,
    text,
    inReplyTo,
    lane
  }: {
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    inReplyTo?: string;
    /** ENG-2840: `bulk` for automated mail that can wait a few seconds; absent = transactional. */
    lane?: EmailLane;
  }) {
    const from = `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`;
    return this.sendEmail({
      from,
      to,
      subject,
      html,
      text,
      inReplyTo,
      lane
    });
  }

  /**
   * Fetch email content for a received email
   * @param emailId The email ID from the email.received event
   * @returns Email content including html, text, and headers, or null if failed
   */
  async getReceivedEmailContent(emailId: string): Promise<{
    html?: string;
    text?: string;
    headers?: Record<string, string>;
    /** ENG-2652: Resend's SPF/DKIM/DMARC verdicts for this message (null when Resend has none). */
    authentication?: ReceivedEmailAuthentication | null;
    attachments?: Array<{
      id: string;
      filename: string;
      size: number;
      content_type: string;
      download_url: string;
    }>;
  } | null> {
    await this.initializeResend();

    if (!this.apiKey) {
      console.error('Resend API key not available');
      return null;
    }

    if (!emailId) {
      console.error('Email ID is required to fetch email content');
      return null;
    }

    // Use direct REST API call since the SDK may not have receiving API
    interface ResendEmailContent {
      html?: string;
      text?: string;
      headers?: Record<string, string>;
      authentication?: ReceivedEmailAuthentication | null;
      attachments?: Array<{
        id: string;
        filename: string;
        size: number;
        content_type: string;
        download_url: string;
      }>;
    }

    const result = await this.retryWithBackoffOrNull<ResendEmailContent>(
      async () => {
        try {
          const response = await axios.get<ResendEmailContent>(
            `https://api.resend.com/emails/receiving/${emailId}`,
            {
              headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
            }
          );

          return response.data;
        } catch (error: any) {
          if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            throw new Error(`Resend API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
          } else if (error.request) {
            // The request was made but no response was received
            throw new Error(`Resend API error: No response received - ${error.message}`);
          } else {
            // Something happened in setting up the request
            throw new Error(`Resend API error: ${error.message}`);
          }
        }
      },
      `Fetch email content for ${emailId}`
    );

    if (result) {
      // The main response includes attachments but without download_url.
      // Fetch from the separate list endpoint which includes signed download URLs.
      let attachments = result.attachments;
      const needsDownloadUrls = attachments && attachments.length > 0
        && attachments.some(a => !a.download_url);
      if ((needsDownloadUrls || !attachments || attachments.length === 0) && this.apiKey) {
        try {
          const attachResp = await axios.get<{ data: ResendEmailContent['attachments'] }>(
            `https://api.resend.com/emails/receiving/${emailId}/attachments`,
            { headers: { 'Authorization': `Bearer ${this.apiKey}` } }
          );
          if (attachResp.data?.data && attachResp.data.data.length > 0) {
            attachments = attachResp.data.data;
          }
        } catch {
          // Ignore — attachments list endpoint may not exist for all emails
        }
      }

      return {
        html: result.html || undefined,
        text: result.text || undefined,
        headers: result.headers || undefined,
        authentication: result.authentication ?? null,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      };
    }

    return null;
  }

  async getDeliveredEmailContent(emailId: string): Promise<{
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  } | null> {
    await this.initializeResend();
    
    if (!this.apiKey) {
      console.error('Resend API key not available');
      return null;
    }

    if (!emailId) {
      console.error('Email ID is required to fetch email content');
      return null;
    }

    // Use direct REST API call to get email content for delivered emails
    // For delivered emails (emails we sent), use the receiving endpoint as shown in user's example
    interface ResendEmailContent {
      html?: string;
      text?: string;
      headers?: Record<string, string>;
    }

    const result = await this.retryWithBackoffOrNull<ResendEmailContent>(
      async () => {
        try {
          // Try receiving endpoint first (as shown in user's example)
          const response = await axios.get<ResendEmailContent>(
            `https://api.resend.com/emails/receiving/${emailId}`,
            {
              headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
            }
          );
          
          return response.data;
        } catch (error: any) {
          // If receiving endpoint fails, try the regular emails endpoint
          if (error.response?.status === 404) {
            try {
              const response = await axios.get<ResendEmailContent>(
                `https://api.resend.com/emails/${emailId}`,
                {
                  headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                  },
                }
              );
              return response.data;
            } catch (fallbackError: any) {
              if (fallbackError.response) {
                throw new Error(`Resend API error: ${fallbackError.response.status} - ${JSON.stringify(fallbackError.response.data)}`);
              } else if (fallbackError.request) {
                throw new Error(`Resend API error: No response received - ${fallbackError.message}`);
              } else {
                throw new Error(`Resend API error: ${fallbackError.message}`);
              }
            }
          } else if (error.response) {
            throw new Error(`Resend API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
          } else if (error.request) {
            throw new Error(`Resend API error: No response received - ${error.message}`);
          } else {
            throw new Error(`Resend API error: ${error.message}`);
          }
        }
      },
      `Fetch delivered email content for ${emailId}`
    );

    if (result) {
      return {
        html: result.html || undefined,
        text: result.text || undefined,
        headers: result.headers || undefined,
      };
    }

    return null;
  }

  /**
   * Create a domain in Resend for email sending
   */
  async createDomain(name: string): Promise<{
    id: string;
    name: string;
    status: string;
    records: Array<{
      record: string;
      name: string;
      value: string;
      type: string;
      ttl: string;
      status: string;
      priority?: number;
    }>;
  } | null> {
    await this.initializeResend();
    if (!this.resend) {
      console.error('Resend service not initialized');
      return null;
    }

    const result = await this.retryWithBackoffOrNull(
      async () => {
        const { data, error } = await this.resend!.domains.create({ name });
        if (error) {
          const resendError: any = this.toErrorWithMetadata(error);
          resendError.message = `Resend domain create error: ${JSON.stringify(error)}`;
          throw resendError;
        }
        return data;
      },
      `Create domain ${name}`
    );

    if (result) {
      console.log(`Resend domain created: ${result.id} (${result.name})`);
      return {
        id: result.id,
        name: result.name,
        status: result.status,
        records: result.records.map(r => ({
          record: r.record,
          name: r.name,
          value: r.value,
          type: r.type,
          ttl: r.ttl,
          status: r.status,
          priority: r.priority,
        })),
      };
    }
    return null;
  }

  /**
   * Get domain details including DNS records and verification status
   */
  async getDomain(domainId: string): Promise<{
    id: string;
    name: string;
    status: string;
    records: Array<{
      record: string;
      name: string;
      value: string;
      type: string;
      ttl: string;
      status: string;
      priority?: number;
    }>;
  } | null> {
    await this.initializeResend();
    if (!this.resend) {
      console.error('Resend service not initialized');
      return null;
    }

    const result = await this.retryWithBackoffOrNull(
      async () => {
        const { data, error } = await this.resend!.domains.get(domainId);
        if (error) {
          const resendError: any = this.toErrorWithMetadata(error);
          resendError.message = `Resend domain get error: ${JSON.stringify(error)}`;
          throw resendError;
        }
        return data;
      },
      `Get domain ${domainId}`
    );

    if (result) {
      return {
        id: result.id,
        name: result.name,
        status: result.status,
        records: result.records.map(r => ({
          record: r.record,
          name: r.name,
          value: r.value,
          type: r.type,
          ttl: r.ttl,
          status: r.status,
          priority: r.priority,
        })),
      };
    }
    return null;
  }

  /**
   * Trigger domain verification in Resend
   */
  async verifyDomain(domainId: string): Promise<boolean> {
    await this.initializeResend();
    if (!this.resend) {
      console.error('Resend service not initialized');
      return false;
    }

    const result = await this.retryWithBackoffOrNull(
      async () => {
        const { data, error } = await this.resend!.domains.verify(domainId);
        if (error) {
          const resendError: any = this.toErrorWithMetadata(error);
          resendError.message = `Resend domain verify error: ${JSON.stringify(error)}`;
          throw resendError;
        }
        return data;
      },
      `Verify domain ${domainId}`
    );

    return result !== null;
  }

  /**
   * List all domains in Resend to check for duplicates
   */
  async listDomains(): Promise<Array<{ id: string; name: string; status: string }>> {
    await this.initializeResend();
    if (!this.resend) {
      console.error('Resend service not initialized');
      return [];
    }

    const result = await this.retryWithBackoffOrNull(
      async () => {
        const { data, error } = await this.resend!.domains.list();
        if (error) {
          const resendError: any = this.toErrorWithMetadata(error);
          resendError.message = `Resend domain list error: ${JSON.stringify(error)}`;
          throw resendError;
        }
        return data;
      },
      'List domains'
    );

    if (result?.data) {
      return result.data.map(d => ({ id: d.id, name: d.name, status: d.status }));
    }
    return [];
  }
}

export const resendService = new ResendService();
