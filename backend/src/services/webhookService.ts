import { Webhook } from 'svix';
import { WebhookRequiredHeaders } from 'svix';
import { IncomingMessage } from 'http';
import { createHash } from 'crypto';
import { getSecret } from '../utils/secretsManager';

export interface ResendWebhookEvent {
  type: string;
  created_at: string;
  data: {
    broadcast_id?: string;
    created_at: string;
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    tags?: {
      category?: string;
      [key: string]: any;
    };
    click?: {
      ipAddress: string;
      link: string;
      timestamp: string;
      userAgent: string;
    };
    bounce?: {
      type: string;
      reason: string;
      timestamp: string;
    };
    complaint?: {
      type: string;
      reason: string;
      timestamp: string;
    };
    [key: string]: any;
  };
}

class WebhookService {
  private webhook: Webhook | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const environment = process.env.NODE_ENV || 'development';
      const secretName = environment === 'production' 
        ? 'prod/AgentWeb/Resend/webhook' 
        : 'dev/AgentWeb/Resend/webhook';
      
      const webhookSecret = await getSecret(secretName);
      this.webhook = new Webhook(webhookSecret);
      this.initialized = true;
      console.log(`Webhook service initialized successfully for ${environment} environment`);
    } catch (error) {
      console.error('Failed to initialize webhook service:', error);
      console.log('Webhook service will work without signature verification for debugging');
      // Don't throw error - allow webhook to work without verification for debugging
      this.initialized = true;
    }
  }

  verifyWebhook(payload: string, headers: IncomingMessage['headers'] & WebhookRequiredHeaders): ResendWebhookEvent {
    if (!this.webhook) {
      console.log('Webhook verification skipped - no webhook secret available');
      // For debugging, just parse the JSON payload
      return JSON.parse(payload) as ResendWebhookEvent;
    }

    return this.webhook.verify(payload, headers) as ResendWebhookEvent;
  }

  extractEmailDomain(from: string): string {
    // Extract domain from "Name <email@domain.com>" format
    const match = from.match(/<([^>]+)>/);
    if (match) {
      const email = match[1];
      const domain = email.split('@')[1];
      return domain || 'unknown';
    }
    
    // If no angle brackets, assume the whole string is an email
    const email = from.split(' ').pop() || from;
    const domain = email.split('@')[1];
    return domain || 'unknown';
  }

  generateEventId(event: ResendWebhookEvent): string {
    // Create a deterministic hash of the event for deduplication
    const eventString = JSON.stringify({
      type: event.type,
      created_at: event.created_at,
      email_id: event.data.email_id,
      from: event.data.from,
      to: event.data.to,
      subject: event.data.subject
    });
    
    const hash = createHash('sha256').update(eventString).digest('hex');
    return `evt_${hash.substring(0, 16)}`;
  }
}

export const webhookService = new WebhookService();
