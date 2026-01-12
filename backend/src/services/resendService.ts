import { Resend } from 'resend';
import { getSecret } from '../utils/secretsManager';
import axios from 'axios';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';

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
    text,
    inReplyTo
  }: {
    from: string;
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    inReplyTo?: string;
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

    // Add reply headers if replying to an email
    if (inReplyTo) {
      emailOptions.headers = {
        'In-Reply-To': inReplyTo
      };
    }

    const recipient = Array.isArray(to) ? to.join(', ') : to;
    console.log(`Sending Resend email to: ${recipient}`);

    // Add delay before attempting to send to respect rate limit (2 per second = 500ms minimum)
    // Using 600ms to provide a safety margin and account for processing time
    const RATE_LIMIT_DELAY = 600; // 600ms = ~1.67 emails/second, safely under 2/second limit
    console.log(`Waiting ${RATE_LIMIT_DELAY}ms before sending email to ${recipient}...`);
    await this.sleep(RATE_LIMIT_DELAY);

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
    }

    const result = await this.retryWithBackoff<ResendEmailContent>(
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
      return {
        html: result.html || undefined,
        text: result.text || undefined,
        headers: result.headers || undefined,
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

    const result = await this.retryWithBackoff<ResendEmailContent>(
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

}

export const resendService = new ResendService();
