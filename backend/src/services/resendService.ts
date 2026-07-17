import { Resend } from 'resend';
import { getSecret } from '../utils/secretsManager';
import axios from 'axios';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';

interface SendEmailParams {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  inReplyTo?: string;
  replyTo?: string;
}

interface QueuedEmailSend {
  id: number;
  params: SendEmailParams;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

class ResendService {
  private resend: Resend | null = null;
  private apiKey: string | null = null;
  private readonly MAX_RETRIES = 3;
  private readonly BASE_DELAY = 1000; // 1 second base delay
  private readonly MIN_SEND_INTERVAL_MS = 500; // 2 requests/sec
  private sendQueue: QueuedEmailSend[] = [];
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
      while (this.sendQueue.length > 0) {
        const queueItem = this.sendQueue.shift();
        if (!queueItem) {
          continue;
        }

        await this.waitForRateLimitWindow();
        const recipient = Array.isArray(queueItem.params.to) ? queueItem.params.to.join(', ') : queueItem.params.to;
        console.log(`Processing Resend queue item #${queueItem.id} for: ${recipient} (remaining: ${this.sendQueue.length})`);

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
      if (this.sendQueue.length > 0) {
        void this.processSendQueue();
      }
    }
  }

  private enqueueSend(params: SendEmailParams): Promise<any> {
    return new Promise((resolve, reject) => {
      const queueItem: QueuedEmailSend = {
        id: ++this.queueItemId,
        params,
        resolve,
        reject
      };
      this.sendQueue.push(queueItem);
      console.log(`Queued Resend email #${queueItem.id}. Queue size: ${this.sendQueue.length}`);
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
    replyTo
  }: SendEmailParams) {
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
    if (inReplyTo) {
      emailOptions.headers = {
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
   */
  async sendEmail(params: SendEmailParams) {
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
    inReplyTo
  }: {
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    inReplyTo?: string;
  }) {
    const from = `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`;
    return this.sendEmail({
      from,
      to,
      subject,
      html,
      text,
      inReplyTo
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
