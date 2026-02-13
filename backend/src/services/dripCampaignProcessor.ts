import { dripCampaignDb, crmDb, userDb } from './db';
import { resendService } from './resendService';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

// Initialize Azure OpenAI client
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
});

interface EmailGenerationResult {
  html: string;
  text?: string;
}

export class DripCampaignProcessor {
  private isProcessing = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
  private readonly BATCH_SIZE = 10; // Process enrollments in batches of 10
  private readonly MAX_RETRIES = 3; // Maximum retry attempts for failed sends
  private failureCount = 0; // Track consecutive failures for circuit breaker
  private readonly CIRCUIT_BREAKER_THRESHOLD = 10; // Stop processing after 10 consecutive failures

  /**
   * Start the drip campaign processor
   */
  start() {
    if (this.processingInterval) {
      console.log('Drip campaign processor is already running');
      return;
    }

    console.log('Starting drip campaign processor...');

    // Process immediately on start
    this.processLoop().catch(error => {
      console.error('Error in initial drip campaign processing:', error);
    });

    // Then process on interval
    this.processingInterval = setInterval(() => {
      this.processLoop().catch(error => {
        console.error('Error in drip campaign processing loop:', error);
      });
    }, this.CHECK_INTERVAL_MS);

    console.log(`Drip campaign processor started (checking every ${this.CHECK_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop the drip campaign processor
   */
  stop() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
      console.log('Drip campaign processor stopped');
    }
  }

  /**
   * Main processing loop
   */
  private async processLoop() {
    if (this.isProcessing) {
      console.log('Drip campaign processor already running, skipping this cycle');
      return;
    }

    this.isProcessing = true;
    try {
      await this.processDueEnrollments();
    } catch (error) {
      console.error('Error processing drip campaigns:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process all due enrollments in parallel batches
   */
  private async processDueEnrollments() {
    const now = new Date().toISOString();

    // Check circuit breaker
    if (this.failureCount >= this.CIRCUIT_BREAKER_THRESHOLD) {
      console.error(`Circuit breaker activated: ${this.failureCount} consecutive failures. Skipping processing cycle.`);
      // Reset failure count after skipping (will try again next cycle)
      this.failureCount = 0;
      return;
    }

    // Query for active enrollments that are due
    const dueEnrollments = await dripCampaignDb.queryDueEnrollments(now);

    if (dueEnrollments.length === 0) {
      console.log('No due drip campaign enrollments found');
      return;
    }

    console.log(`Found ${dueEnrollments.length} due drip campaign enrollments`);

    // Process enrollments in parallel batches
    for (let i = 0; i < dueEnrollments.length; i += this.BATCH_SIZE) {
      const batch = dueEnrollments.slice(i, i + this.BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / this.BATCH_SIZE) + 1} (${batch.length} enrollments)`);

      // Process batch in parallel
      const results = await Promise.allSettled(
        batch.map(enrollment => this.processEnrollment(enrollment))
      );

      // Track failures for circuit breaker
      const batchFailures = results.filter(r => r.status === 'rejected').length;
      if (batchFailures > 0) {
        this.failureCount += batchFailures;
        console.warn(`Batch had ${batchFailures} failures (total consecutive failures: ${this.failureCount})`);
      } else {
        // Reset failure count on successful batch
        this.failureCount = 0;
      }

      // Log batch results
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`Failed to process enrollment ${batch[index].enrollmentId}:`, result.reason);
        }
      });
    }
  }

  /**
   * Retry helper with exponential backoff
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = this.MAX_RETRIES
  ): Promise<T | null> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000; // Exponential: 1s, 2s, 4s
          console.log(`${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
          console.error(`Error details:`, error.message || error);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error(`${operationName} failed after ${maxRetries} attempts:`, lastError);
    return null;
  }

  /**
   * Process a single enrollment
   */
  private async processEnrollment(enrollment: any) {
    try {
      // Get the campaign
      const campaign = await dripCampaignDb.getCampaign(enrollment.campaignId);
      if (!campaign) {
        console.error(`Campaign ${enrollment.campaignId} not found`);
        return;
      }

      // Check if campaign is still active
      if (campaign.status !== 'active') {
        console.log(`Campaign ${campaign.campaignId} is not active (status: ${campaign.status}), skipping`);
        return;
      }

      // Get the lead
      const lead = await crmDb.getLeadById(enrollment.listId, enrollment.leadId);
      if (!lead) {
        console.error(`Lead ${enrollment.leadId} not found`);
        return;
      }

      // Check stop conditions
      if (await this.shouldStopEnrollment(enrollment, lead, campaign)) {
        console.log(`Stopping enrollment ${enrollment.enrollmentId} due to stop conditions`);
        await this.stopEnrollment(enrollment, 'stop_condition_met');
        return;
      }

      // Get the current email step
      const currentStepIndex = enrollment.currentStep;
      if (currentStepIndex >= campaign.emails.length) {
        console.log(`Enrollment ${enrollment.enrollmentId} has completed all steps`);
        await this.completeEnrollment(enrollment);
        return;
      }

      const emailStep = campaign.emails[currentStepIndex];

      // Get current retry count from enrollment metadata
      const retryCount = enrollment.metadata?.retryCount || 0;

      // Send the email with retry logic
      const success = await this.retryWithBackoff(
        () => this.sendDripEmail(enrollment, campaign, lead, emailStep),
        `Send email to ${lead.email} (campaign: ${campaign.name}, step: ${emailStep.stepNumber})`
      );

      if (success) {
        // Reset retry count on success
        const metadata = { ...(enrollment.metadata || {}), retryCount: 0, lastError: null };

        // Move to next step
        const nextStepIndex = currentStepIndex + 1;
        let nextSendTime: string | undefined;

        if (nextStepIndex < campaign.emails.length) {
          // Calculate next send time based on next email's timing
          const nextEmail = campaign.emails[nextStepIndex];

          if (nextEmail.timingType === 'relative') {
            const delayMs = (nextEmail.delayDays || 0) * 24 * 60 * 60 * 1000 +
                           (nextEmail.delayHours || 0) * 60 * 60 * 1000;
            nextSendTime = new Date(Date.now() + delayMs).toISOString();
          } else if (nextEmail.timingType === 'absolute') {
            nextSendTime = nextEmail.sendDate;
          }
        }

        // Update enrollment with metadata
        await dripCampaignDb.updateEnrollment(enrollment.enrollmentId, {
          currentStep: nextStepIndex,
          nextSendTime,
          metadata,
          sentEmails: [
            ...(enrollment.sentEmails || []),
            {
              stepId: emailStep.stepId,
              stepNumber: emailStep.stepNumber,
              sentAt: new Date().toISOString(),
              subject: emailStep.subject,
            }
          ]
        });

        // Check if this was the last step
        if (nextStepIndex >= campaign.emails.length) {
          await this.completeEnrollment(enrollment);
        }
      } else {
        // Email send failed after all retries
        console.error(`Failed to send email after ${this.MAX_RETRIES} attempts for enrollment ${enrollment.enrollmentId}`);

        // Increment retry count and store error
        const newRetryCount = retryCount + 1;
        const metadata = {
          ...(enrollment.metadata || {}),
          retryCount: newRetryCount,
          lastError: 'Email send failed after retries',
          lastFailedAt: new Date().toISOString(),
        };

        // If exceeded max retries, stop the enrollment
        if (newRetryCount >= this.MAX_RETRIES) {
          console.error(`Enrollment ${enrollment.enrollmentId} exceeded max retries, stopping enrollment`);
          await this.stopEnrollment(enrollment, 'max_retries_exceeded');
        } else {
          // Update metadata and reschedule for next cycle
          const nextRetryDelay = Math.pow(2, newRetryCount) * 60 * 1000; // Exponential: 2min, 4min, 8min
          const nextSendTime = new Date(Date.now() + nextRetryDelay).toISOString();

          await dripCampaignDb.updateEnrollment(enrollment.enrollmentId, {
            metadata,
            nextSendTime,
          });

          console.log(`Rescheduled enrollment ${enrollment.enrollmentId} for retry in ${nextRetryDelay / 1000}s`);
        }
      }
    } catch (error) {
      console.error(`Error processing enrollment ${enrollment.enrollmentId}:`, error);
      console.error(`Stack trace:`, (error as Error).stack);
      throw error;
    }
  }

  /**
   * Send a drip email
   */
  private async sendDripEmail(
    enrollment: any,
    campaign: any,
    lead: any,
    emailStep: any
  ): Promise<boolean> {
    try {
      // Get user settings for sender info
      const user = await userDb.getUserById(enrollment.userId);
      if (!user) {
        console.error(`User ${enrollment.userId} not found`);
        return false;
      }

      // Determine sender email
      let senderEmail: string;
      let senderName: string;

      if (emailStep.senderId) {
        // Use specified sender from configs
        // This would need to be implemented similar to CRM email sending
        // For now, use user's default email domain
        const senderUsername = user.defaultSenderUsername || 'noreply';
        senderEmail = `${senderUsername}@${user.emailDomain || 'agentweb.pro'}`;
        senderName = user.fromName || user.displayName || 'AgentWeb';
      } else {
        // Use user's default sender
        const senderUsername = user.defaultSenderUsername || 'noreply';
        senderEmail = `${senderUsername}@${user.emailDomain || 'agentweb.pro'}`;
        senderName = user.fromName || user.displayName || 'AgentWeb';
      }

      // Generate email content using AI
      const emailContent = await this.generateEmailContent(emailStep, lead, user);

      // Send email via Resend with campaign tracking tags
      const from = `${senderName} <${senderEmail}>`;
      const result = await resendService.sendEmail({
        from,
        to: lead.email,
        subject: emailStep.subject,
        html: emailContent.html,
        text: emailContent.text,
        tags: {
          campaignId: campaign.campaignId,
          enrollmentId: enrollment.enrollmentId,
          stepNumber: emailStep.stepNumber.toString(),
        }
      });

      if (result) {
        console.log(`Sent drip email to ${lead.email} for campaign ${campaign.name}`);

        // Track email event in CRM
        await crmDb.createEmailEvent({
          eventId: uuidv4(),
          listId: enrollment.listId,
          leadId: lead.leadId,
          emailDomain: user.emailDomain || 'agentweb.pro',
          leadEmail: lead.email,
          eventType: 'sent',
          timestamp: new Date().toISOString(),
          metadata: {
            campaignId: campaign.campaignId,
            campaignName: campaign.name,
            enrollmentId: enrollment.enrollmentId,
            stepNumber: emailStep.stepNumber,
            subject: emailStep.subject,
          }
        });

        return true;
      } else {
        console.error(`Failed to send drip email to ${lead.email}`);
        return false;
      }
    } catch (error) {
      console.error(`Error sending drip email:`, error);
      return false;
    }
  }

  /**
   * Generate email content using AI
   */
  private async generateEmailContent(
    emailStep: any,
    lead: any,
    user: any
  ): Promise<EmailGenerationResult> {
    try {
      // Prepare context for AI
      const context = {
        leadFirstName: lead.firstName || '',
        leadLastName: lead.lastName || '',
        leadEmail: lead.email,
        leadCompany: lead.company || '',
        leadJobTitle: lead.jobTitle || '',
        leadCustomFields: lead.customFields || {},
        companyName: user.companyName || 'our company',
      };

      // Build prompt with context
      const prompt = `${emailStep.aiPrompt}

Lead Information:
- First Name: ${context.leadFirstName}
- Last Name: ${context.leadLastName}
- Email: ${context.leadEmail}
- Company: ${context.leadCompany}
- Job Title: ${context.leadJobTitle}

Please generate a personalized email body in HTML format. Use the lead's first name naturally in the email. Make it professional and engaging.

Return ONLY the HTML body content (without <html>, <head>, or <body> tags).`;

      // Generate content using Azure OpenAI
      const completion = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5-chat-2',
        messages: [
          {
            role: 'system',
            content: 'You are an expert email copywriter. Generate professional, engaging, and personalized emails.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 2000,
        temperature: 0.7,
      });

      const htmlContent = completion.choices[0]?.message?.content?.trim() || '';

      // Generate plain text version (strip HTML tags)
      const textContent = htmlContent
        .replace(/<[^>]*>/g, '')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();

      return {
        html: htmlContent,
        text: textContent,
      };
    } catch (error) {
      console.error('Error generating email content:', error);

      // Fallback to a simple template
      const firstName = lead.firstName || 'there';
      return {
        html: `<p>Hi ${firstName},</p><p>${emailStep.aiPrompt}</p>`,
        text: `Hi ${firstName},\n\n${emailStep.aiPrompt}`,
      };
    }
  }

  /**
   * Check if enrollment should be stopped based on stop conditions
   */
  private async shouldStopEnrollment(
    enrollment: any,
    lead: any,
    campaign: any
  ): Promise<boolean> {
    const stopConditions = campaign.stopConditions || {};

    // Check if lead has unsubscribed
    if (stopConditions.stopOnUnsubscribe && lead.unsubscribed) {
      return true;
    }

    // Check if lead has bounced
    if (stopConditions.stopOnBounce && lead.bounced) {
      return true;
    }

    // Check if lead has replied
    if (stopConditions.stopOnReply) {
      // Check email events for replies
      const replyEvents = await crmDb.getEmailEventsByLeadId(lead.leadId);
      const hasReplied = replyEvents.some(event =>
        event.eventType === 'replied' &&
        event.metadata?.campaignId === campaign.campaignId
      );
      if (hasReplied) {
        return true;
      }
    }

    return false;
  }

  /**
   * Stop an enrollment
   */
  private async stopEnrollment(enrollment: any, reason: string) {
    await dripCampaignDb.updateEnrollment(enrollment.enrollmentId, {
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      stoppedReason: reason,
    });

    // Update campaign stats
    const campaign = await dripCampaignDb.getCampaign(enrollment.campaignId);
    if (campaign) {
      await dripCampaignDb.updateCampaign(enrollment.campaignId, {
        stats: {
          ...campaign.stats,
          active: Math.max(0, (campaign.stats?.active || 0) - 1),
          stopped: (campaign.stats?.stopped || 0) + 1,
        }
      });
    }
  }

  /**
   * Complete an enrollment
   */
  private async completeEnrollment(enrollment: any) {
    await dripCampaignDb.updateEnrollment(enrollment.enrollmentId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });

    // Update campaign stats
    const campaign = await dripCampaignDb.getCampaign(enrollment.campaignId);
    if (campaign) {
      await dripCampaignDb.updateCampaign(enrollment.campaignId, {
        stats: {
          ...campaign.stats,
          active: Math.max(0, (campaign.stats?.active || 0) - 1),
          completed: (campaign.stats?.completed || 0) + 1,
        }
      });
    }
  }
}

// Export singleton instance
export const dripCampaignProcessor = new DripCampaignProcessor();
