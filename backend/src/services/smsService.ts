import Twilio from 'twilio';
import { getTwilioCredentials } from '../utils/secretsManager';

export interface SMSMessage {
  messageSid: string;
  direction: 'outbound' | 'inbound';
  body: string;
  status: string;
  createdAt: string;
  from: string;
  to: string;
}

class SMSService {
  private client: Twilio.Twilio | null = null;
  private credentials: { accountSid: string; authToken: string } | null = null;
  private initPromise: Promise<void> | null = null;

  private async initialize(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        this.credentials = await getTwilioCredentials();
        this.client = Twilio(this.credentials.accountSid, this.credentials.authToken);
        console.log('SMS service (Twilio) initialized successfully');
      } catch (error) {
        console.warn('SMS service: failed to initialize Twilio client:', error);
        this.client = null;
      }
    })();

    return this.initPromise;
  }

  async sendSMS(from: string, to: string, body: string): Promise<{ messageSid: string; status: string }> {
    await this.initialize();

    if (!this.client) {
      throw new Error('SMS service is not configured. Check Twilio credentials in Secrets Manager.');
    }

    const message = await this.client.messages.create({ from, to, body });
    return { messageSid: message.sid, status: message.status };
  }

  async getSMSHistory(
    fromNumber: string,
    toNumber: string,
    limit: number = 20
  ): Promise<SMSMessage[]> {
    await this.initialize();

    if (!this.client) {
      throw new Error('SMS service is not configured. Check Twilio credentials in Secrets Manager.');
    }

    const cappedLimit = Math.min(limit, 50);

    // Fetch outbound (from our number to theirs) and inbound (from theirs to ours)
    const [outbound, inbound] = await Promise.all([
      this.client.messages.list({ from: fromNumber, to: toNumber, limit: cappedLimit }),
      this.client.messages.list({ from: toNumber, to: fromNumber, limit: cappedLimit }),
    ]);

    const allMessages: SMSMessage[] = [
      ...outbound.map((m) => ({
        messageSid: m.sid,
        direction: 'outbound' as const,
        body: m.body,
        status: m.status,
        createdAt: m.dateCreated.toISOString(),
        from: m.from,
        to: m.to,
      })),
      ...inbound.map((m) => ({
        messageSid: m.sid,
        direction: 'inbound' as const,
        body: m.body,
        status: m.status,
        createdAt: m.dateCreated.toISOString(),
        from: m.from,
        to: m.to,
      })),
    ];

    // Sort by date descending, return top `cappedLimit`
    allMessages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return allMessages.slice(0, cappedLimit);
  }

  isConfigured(): boolean {
    return this.client !== null;
  }
}

export const smsService = new SMSService();
