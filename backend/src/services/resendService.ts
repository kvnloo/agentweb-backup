import { Resend } from 'resend';
import { getSecret } from '../utils/secretsManager';

class ResendService {
  private resend: Resend | null = null;
  private apiKey: string | null = null;
  private readonly MAX_RETRIES = 3;
  private readonly BASE_DELAY = 1000; // 1 second base delay

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
           error?.message?.includes('rate_limit_exceeded') ||
           error?.message?.includes('Too many requests');
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T | null> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        
        if (this.isRateLimitError(error) && attempt < this.MAX_RETRIES) {
          const delay = this.BASE_DELAY * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`${operationName} failed with rate limit (attempt ${attempt}/${this.MAX_RETRIES}), retrying in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          console.error(`${operationName} failed on attempt ${attempt}:`, error);
          break;
        }
      }
    }
    
    console.error(`${operationName} failed after ${this.MAX_RETRIES} attempts:`, lastError);
    return null;
  }

  async sendEmail({
    from,
    to,
    subject,
    html,
    text
  }: {
    from: string;
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
  }) {
    await this.initializeResend();
    
    if (!this.resend) {
      console.error('Resend service not initialized');
      return;
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

    const recipient = Array.isArray(to) ? to.join(', ') : to;
    console.log(`Sending Resend email to: ${recipient}`);

    // Add 500ms delay before attempting to send to minimize rate limit hits
    console.log(`Waiting 500ms before sending email to ${recipient}...`);
    await this.sleep(500);

    const result = await this.retryWithBackoff(
      async () => {
        const { data, error } = await this.resend!.emails.send(emailOptions);
        
        if (error) {
          throw new Error(`Resend API error: ${JSON.stringify(error)}`);
        }
        
        return data;
      },
      `Email send to ${recipient}`
    );

    if (result) {
      console.log('Resend email sent successfully:', result);
    } else {
      console.error(`Failed to send email to ${recipient} after ${this.MAX_RETRIES} attempts`);
    }

    return result;
  }

}

export const resendService = new ResendService();
