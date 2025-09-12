import { Resend } from 'resend';
import { getSecret } from '../utils/secretsManager';

class ResendService {
  private resend: Resend | null = null;
  private apiKey: string | null = null;

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
    try {
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

      const { data, error } = await this.resend.emails.send(emailOptions);

      if (error) {
        console.error('Resend email error:', error);
        return;
      }

      console.log('Resend email sent successfully:', data);
      return data;
    } catch (error) {
      console.error('Error sending email via Resend:', error);
      // Don't throw - just log the error
    }
  }

}

export const resendService = new ResendService();
