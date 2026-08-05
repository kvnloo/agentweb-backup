import dotenv from 'dotenv';

import { resendService } from './resendService';
import { deriveBlockedByCost } from './tokenUsageService';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';
import { chatbotDb } from './chatbotService';
import { userDb } from './db';
import { reportContainsCrossAccountData, messagesReferenceCrossAccountTool, resolveAuthorizedReportRecipients } from './scheduledReportAccess';
import { settingsService } from './settingsService';
import { Citation, CitationRenderFormat, renderCitationMarkers, stripCitationMarkers } from '../utils/citations';

// ENG-351: resolve {{cite:N}} markers in Emma's text to inline source attributions, using the
// citation metadata on the session's last assistant message. Email has no chip renderer, so this
// gives recipients the source of each figure inline. Use `format: 'markdown'` for bodies rendered
// through marked() (the source becomes a clickable link); keep the default `'text'` — "(Source)" —
// for HTML-escaped or truncated previews, where a markdown link would show as escaped literal text.
// Falls back to plain stripping if the session/citation lookup fails or the session has none, so a
// raw marker never reaches an inbox.
async function resolveEmmaCitationsForEmail(
  text: string,
  sessionId?: string,
  format: CitationRenderFormat = 'text',
): Promise<string> {
  if (!text || typeof text !== 'string') return text;
  if (!sessionId) return stripCitationMarkers(text);
  try {
    const session = await chatbotDb.getChatSession(sessionId);
    const msgs = session?.messages;
    let citations: Citation[] | undefined;
    if (Array.isArray(msgs)) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m: any = msgs[i];
        if (m?.role === 'assistant' && Array.isArray(m?.metadata?.citations)) {
          citations = m.metadata.citations;
          break;
        }
      }
    }
    return renderCitationMarkers(text, citations, format);
  } catch {
    return stripCitationMarkers(text);
  }
}

dotenv.config();

// ENG-164: the nodemailer Gmail SMTP transporter is gone. Every email leaves
// through resendService; this is the default system sender for emails that
// don't carry a customer-configured sender.
const SYSTEM_FROM = `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`;
const SUPPORT_REPLY_TO = 'support@agentweb.pro';

// Env var ONCALL_EMAIL_LIST takes highest priority for oncall alerts.
async function getAlertEmails(settingKey: string, fallback: string[]): Promise<string[]> {
  if (settingKey === 'oncall_emails' && process.env.ONCALL_EMAIL_LIST) {
    return process.env.ONCALL_EMAIL_LIST.split(',').filter(Boolean);
  }
  return settingsService.getJsonArraySetting(settingKey, fallback);
}

export const emailService = {
  // Escape HTML content to make it safe for emails
  escapeHtml(html: string): string {
    if (!html) return '';

    return html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  async sendEmail(to: string | string[], subject: string, text: string, html: string, cc?: string | string[]) {
    try {
      await resendService.sendEmail({
        from: SYSTEM_FROM,
        to,
        cc,
        subject,
        text,
        html,
        replyTo: SUPPORT_REPLY_TO
      });
      const toList = Array.isArray(to) ? to.join(', ') : to;
      const ccList = cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : '';
      console.log('Email sent successfully to:', toList, cc ? `CC: ${ccList}` : '');
    } catch (error) {
      console.error('Error sending email:', error);
      // Don't throw - best-effort by design. Callers that need delivery
      // guarantees use sendEmailStrict.
    }
  },

  /**
   * Strict variant — throws on send failure, returns the real provider
   * messageId so the caller's audit row reflects ground truth. Use this for
   * any flow where "did this email actually leave the box?" has to be
   * answerable from the audit log (e.g. the drip executor).
   *
   * Do NOT swap callers of `sendEmail` to this blindly — most existing
   * callers (welcome emails, task execution notifications, etc.) intentionally
   * tolerate silent failure so they don't crash user-facing flows. The split
   * is on purpose: the old shape for best-effort UX notifications, this one
   * for audited, compliance-adjacent sends.
   */
  async sendEmailStrict(
    to: string | string[],
    subject: string,
    text: string,
    html: string,
    cc?: string | string[]
  ): Promise<{ messageId: string }> {
    // resendService rejects on failure (ENG-164), so a send error propagates
    // to the caller here without any extra handling.
    const result = await resendService.sendEmail({
      from: SYSTEM_FROM,
      to,
      cc,
      subject,
      text,
      html,
      replyTo: SUPPORT_REPLY_TO
    });

    const messageId = (result && typeof (result as any).id === 'string')
      ? (result as any).id
      : null;
    if (!messageId) {
      throw new Error('sendEmailStrict: Resend returned no messageId');
    }
    const toList = Array.isArray(to) ? to.join(', ') : to;
    const ccList = cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : '';
    console.log('Email sent successfully (strict) to:', toList, cc ? `CC: ${ccList}` : '', `(messageId: ${messageId})`);
    return { messageId };
  },

  async sendInvitation(email: string) {
    const mailOptions = {
      from: SYSTEM_FROM,
      replyTo: SUPPORT_REPLY_TO,
      to: email,
      subject: 'Welcome to AgentWeb - Your Invitation',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to AgentWeb!</h2>
          <p>We're excited to have you join our platform. Your waitlist application has been approved!</p>
          <p>To get started, please click the button below to create your account:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/register?email=${encodeURIComponent(email)}" 
               style="background-color: #1976d2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
              Create Your Account
            </a>
          </div>
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p>${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/register?email=${encodeURIComponent(email)}</p>
          
          <h3>Getting Started with AgentWeb</h3>
          <p>Check out these resources to help you get the most out of AgentWeb:</p>
          <ul>
            <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/changelog">Release Notes</a> - Learn about our latest features and updates</li>
            <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/guide">User Guide</a> - Detailed instructions on how to create and manage your web automation tasks</li>
          </ul>
          
          <p>If you have any questions or need assistance, please reply to this email or contact our support team at support@agentweb.pro.</p>
          
          <p>Best regards,<br>The AgentWeb Team</p>
        </div>
      `
    };

    try {
      await resendService.sendEmail(mailOptions);
      console.log('Invitation email sent successfully to:', email);
    } catch (error) {
      console.error('Error sending invitation email:', error);
      throw error;
    }
  },

  async sendWelcomeEmail(email: string, temporaryPassword?: string) {
    const isUpgrade = !temporaryPassword;

    const welcomeHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
          <p style="color: #666; margin: 5px 0;">Customer Portal</p>
        </div>
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1B2549; margin-top: 0;">Welcome to AgentWeb!</h2>
          <p style="color: #333; line-height: 1.6;">
            ${isUpgrade
        ? 'Great news! Your account has been upgraded and you now have access to our premium features.'
        : 'Your account has been created successfully. You can now access the AgentWeb Customer Portal.'
      }
          </p>
          ${isUpgrade ? `
          <p style="color: #333; line-height: 1.6;">
            Since you already have an account, you can log in directly using your existing credentials.
          </p>
          ` : ''}
          
          ${temporaryPassword ? `
          <div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
            <h3 style="color: #1B2549; margin-top: 0;">Your Login Credentials</h3>
            <p style="margin: 10px 0;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 10px 0;"><strong>Temporary Password:</strong> <code style="background: #f0f0f0; padding: 2px 6px; border-radius: 3px;">${temporaryPassword}</code></p>
          </div>
          ` : ''}
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/login" 
               style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); 
                      color: white; 
                      padding: 12px 30px; 
                      text-decoration: none; 
                      border-radius: 6px; 
                      display: inline-block;
                      font-weight: bold;">
              Sign In Now
            </a>
          </div>
          
          ${isUpgrade ? `
                 <div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
                   <h3 style="color: #1B2549; margin-top: 0;">What's New with Your Upgrade</h3>
                   <p style="margin: 10px 0; color: #333; line-height: 1.6;">
                     You now have access to our full suite of AI-powered marketing automation tools, including Emma AI Assistant, advanced content creation, Meta Ads integration, and comprehensive analytics. Transform your marketing workflow with intelligent automation and data-driven insights.
                   </p>
                 </div>
          ` : ''}
          
          <p style="color: #666; font-size: 14px; margin-top: 20px;">
            ${temporaryPassword
        ? '<strong>Important:</strong> Please change your password after your first login for security reasons. This temporary password expires in 1 month.'
        : ''
      }
          </p>
          
          <div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
            <h3 style="color: #1B2549; margin-top: 0;">Getting Started with AgentWeb</h3>
            <p style="margin: 10px 0; color: #333; line-height: 1.6;">Check out these resources to help you get the most out of AgentWeb:</p>
            <ul style="margin: 10px 0; padding-left: 20px; color: #333;">
              <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/changelog" style="color: #643B7E; text-decoration: none;">Release Notes</a> - Learn about our latest features and updates</li>
              <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/guide" style="color: #643B7E; text-decoration: none;">User Guide</a> - Detailed instructions on how to create and manage your web automation tasks</li>
            </ul>
          </div>
        </div>
        
        <div style="text-align: center; color: #666; font-size: 12px;">
          <p>If you have any questions, please contact our support team.</p>
        </div>
      </div>
    `;

    const welcomeText = `
AgentWeb Customer Portal - Welcome!

${isUpgrade
        ? 'Great news! Your account has been upgraded and you now have access to our premium features.\n\nSince you already have an account, you can log in directly using your existing credentials.'
        : 'Your account has been created successfully. You can now access the AgentWeb Customer Portal.'
      }

${temporaryPassword ? `
Your Login Credentials:
Email: ${email}
Temporary Password: ${temporaryPassword}
` : ''}

Sign in at: ${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/login

${isUpgrade ? `
What's New with Your Upgrade:
You now have access to our full suite of AI-powered marketing automation tools, including Emma AI Assistant, advanced content creation, Meta Ads integration, and comprehensive analytics. Transform your marketing workflow with intelligent automation and data-driven insights.
` : ''}

${temporaryPassword
        ? 'Important: Please change your password after your first login for security reasons. This temporary password expires in 1 month.'
        : ''
      }

Getting Started with AgentWeb:
Check out these resources to help you get the most out of AgentWeb:
- Release Notes: ${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/changelog - Learn about our latest features and updates
- User Guide: ${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/guide - Detailed instructions on how to create and manage your web automation tasks

If you have any questions, please contact our support team.

Best regards,
The AgentWeb Team
    `;

    try {
      await this.sendEmail(
        email,
        isUpgrade ? 'Welcome to AgentWeb - Your Account is Upgraded!' : 'Welcome to AgentWeb - Your Account is Ready!',
        welcomeText,
        welcomeHtml
      );
      console.log(`Welcome email sent successfully to: ${email}`);
    } catch (error) {
      console.error("Error sending welcome email:", error);
      throw error;
    }
  },

  async sendTeamIntroductionEmail(email: string, displayName?: string) {
    const firstName = displayName ? displayName.split(' ')[0] : 'there';
    const appUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
        </div>

        <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1B2549; margin-top: 0;">Hi ${firstName}, welcome to AgentWeb!</h2>

          <p style="color: #333; line-height: 1.6;">
            We're Harsha, Fangfang, and Matthew — the founders of AgentWeb. We're personally committed to making sure you get the most out of the product, and we'd love to hear what brought you here.
          </p>

          <p style="color: #333; line-height: 1.6;">
            <strong>Just reply to this email</strong> with any questions, feedback, or ideas — we read every message and will get back to you directly.
          </p>

          <div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
            <h3 style="color: #1B2549; margin-top: 0;">Need help or found an issue?</h3>
            <p style="color: #333; line-height: 1.6; margin: 0;">
              You can also chat with <strong>Emma</strong>, our AI assistant inside the app — just say "report an issue" and she'll capture the details for our team.
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${appUrl}"
               style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%);
                      color: white;
                      padding: 12px 30px;
                      text-decoration: none;
                      border-radius: 6px;
                      display: inline-block;
                      font-weight: bold;">
              Open AgentWeb
            </a>
          </div>

          <p style="color: #333; line-height: 1.6; margin-top: 20px;">
            — Harsha, Fangfang &amp; Matthew
          </p>
        </div>

        <div style="text-align: center; color: #666; font-size: 12px;">
          <p>You're receiving this because you just signed up for AgentWeb.</p>
        </div>
      </div>
    `;

    const text = `Hi ${firstName}, welcome to AgentWeb!

We're Harsha, Fangfang, and Matthew — the founders of AgentWeb. We're personally committed to making sure you get the most out of the product, and we'd love to hear what brought you here.

Just reply to this email with any questions, feedback, or ideas — we read every message and will get back to you directly.

Need help or found an issue? You can also chat with Emma, our AI assistant inside the app — just say "report an issue" and she'll capture the details for our team.

Open AgentWeb: ${appUrl}

— Harsha, Fangfang & Matthew

You're receiving this because you just signed up for AgentWeb.
`;

    await resendService.sendEmail({
      from: `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`,
      to: email,
      subject: 'A personal note from the AgentWeb founders',
      html,
      text,
      cc: 'founders@agentweb.pro',
      replyTo: 'founders@agentweb.pro',
    });
    console.log(`Team introduction email sent to: ${email}`);
  },

  async sendSubscriberWelcomeEmail(email: string, taskId: string) {
    try {
      // Import required services
      const { taskDb, userDb } = require('../services/db');

      // Get environment variables
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      // Fetch task data
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      // Fetch user data for account-level email configuration
      const user = await userDb.getUserById(task.userId);
      if (!user) {
        throw new Error(`User not found: ${task.userId}`);
      }

      const taskName = task.name || 'this task';

      const welcomeHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1B2549; margin-top: 0;">Thank you for subscribing!</h2>
            <p style="color: #333; line-height: 1.6;">
              You've successfully subscribed to updates for <strong>${this.escapeHtml(taskName)}</strong>.
            </p>
            <p style="color: #333; line-height: 1.6;">
              You'll now receive updates and notifications about this topic. We'll keep you informed about important developments.
            </p>
          </div>
          
          <div class="footer" style="margin-top: 25px; font-size: 0.9em; padding: 20px;">
            <hr>
            <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
            <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${taskId}&email=${encodeURIComponent(email)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
          </div>
        </div>
      `;

      const welcomeText = `Thank you for subscribing!

You've successfully subscribed to updates for ${taskName}.

You'll now receive updates and notifications about this topic. We'll keep you informed about important developments.

You're receiving this automated email because you're subscribed to the email updates.

Unsubscribe from future updates: ${customerFrontendUrl}/unsubscribe?taskId=${taskId}&email=${encodeURIComponent(email)}`;

      const subject = `Welcome! You've subscribed to ${taskName}`;

      // Determine email sender configuration: task-level -> account-level -> system default
      let emailSender = task.emailSender;
      let fromName = task.fromName;

      // If task doesn't have custom email sender, use account-level configuration
      if (!emailSender || !fromName) {
        if (user.emailDomain && user.defaultSenderUsername && user.fromName) {
          emailSender = `${user.defaultSenderUsername}@${user.emailDomain}`;
          fromName = user.fromName;
        }
      }

      const hasCustomSender = Boolean(emailSender && fromName);
      const from = hasCustomSender ? `${fromName} <${emailSender}>` : SYSTEM_FROM;
      const resendResult = await resendService.sendEmail({
        from,
        to: email,
        subject,
        html: welcomeHtml,
        text: welcomeText,
        ...(hasCustomSender ? {} : { replyTo: SUPPORT_REPLY_TO })
      });
      console.log(`Subscriber welcome email sent via Resend to: ${email} from: ${from}`, resendResult?.id ? `(ID: ${resendResult.id})` : '');
    } catch (error) {
      console.error("Error sending subscriber welcome email:", error);
      // Don't throw - just log the error so subscription still succeeds
    }
  },

  async sendTaskOwnershipChangeEmail(
    recipientEmail: string,
    taskName: string,
    taskId: string,
    oldOwnerEmail: string,
    newOwnerEmail: string,
    changedByEmail: string,
    siteDomain: string,
    cc?: string
  ) {
    const subject = 'Task Ownership Change Notification';
    const taskUrl = `${siteDomain}/tasks/${taskId}`;

    const text = `Task Ownership Change\n\n` +
      `The ownership of task "${taskName}" has been changed.\n\n` +
      `Previous Owner: ${oldOwnerEmail}\n` +
      `New Owner: ${newOwnerEmail}\n` +
      `Changed By: ${changedByEmail}\n\n` +
      `View task details: ${taskUrl}\n\n` +
      `Note: Only the new owner will have access to the task details page. The previous owner will see an "Access Denied" error when trying to access the task.\n\n` +
      `Best regards,\nAgentWeb Team`;

    const html = `
      <h2>Task Ownership Change</h2>
      <p>The ownership of task "${taskName}" has been changed.</p>
      <table style="border-collapse: collapse; margin: 10px 0;">
        <tr>
          <td style="padding: 5px; border: 1px solid #ddd;"><strong>Previous Owner:</strong></td>
          <td style="padding: 5px; border: 1px solid #ddd;">${oldOwnerEmail}</td>
        </tr>
        <tr>
          <td style="padding: 5px; border: 1px solid #ddd;"><strong>New Owner:</strong></td>
          <td style="padding: 5px; border: 1px solid #ddd;">${newOwnerEmail}</td>
        </tr>
        <tr>
          <td style="padding: 5px; border: 1px solid #ddd;"><strong>Changed By:</strong></td>
          <td style="padding: 5px; border: 1px solid #ddd;">${changedByEmail}</td>
        </tr>
      </table>
      <p>You can view the task details <a href="${taskUrl}">here</a>.</p>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 15px 0;">
        <p style="margin: 0; color: #666;"><strong>Important Note:</strong> Only the new owner will have access to the task details page. The previous owner will see an "Access Denied" error when trying to access the task.</p>
      </div>
      <p>Best regards,<br>AgentWeb Team</p>
    `;

    await this.sendEmail(recipientEmail, subject, text, html, cc);
  },

  async sendTaskExecutionEmail(
    toEmail: string,
    executionId: string
  ) {
    try {
      // Import required services
      const { taskDb, subscriberDb } = require('../services/db');

      // Get environment variables
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      // Fetch execution data
      const execution = await taskDb.getTaskExecutionById(executionId);
      if (!execution) {
        throw new Error(`Execution not found: ${executionId}`);
      }

      // Fetch task data
      const task = await taskDb.getTaskById(execution.taskId);
      if (!task) {
        throw new Error(`Task not found: ${execution.taskId}`);
      }

      // Fetch user data for account-level email configuration
      const { userDb } = require('../services/db');
      const user = await userDb.getUserById(task.userId);
      if (!user) {
        throw new Error(`User not found: ${task.userId}`);
      }


      // If sendHtmlReportOnly is enabled, try to find HTML content and send only that
      if (task.sendHtmlReportOnly) {
        if (!execution.result_files || execution.result_files.length === 0) {
          // No result files available, don't send email
          console.log(`sendHtmlReportOnly enabled but no result files available for task ${task.taskId}, skipping email to ${toEmail}`);
          return;
        }

        let htmlContentFromFile = '';
        let htmlContentUrl = '';

        // Look for HTML files in result_files
        for (const file of execution.result_files) {
          if ((file.is_html || file.view_type === 'html') && file.url) {
            try {
              // Import fetch
              const fetch = require('node-fetch');
              const response = await fetch(file.url);

              if (response.ok) {
                const fetchedHtmlContent = await response.text();

                if (task.sendHtmlReportOnly) {
                  // For sendHTMLReportOnly, use raw HTML content without enhancement
                  htmlContentFromFile = fetchedHtmlContent;
                } else {
                  // For regular emails, wrap with html-result div
                  htmlContentFromFile = `
                  <div class="html-result">
                    ${fetchedHtmlContent}
                  </div>
                `;
                }

                htmlContentUrl = file.url; // Capture the URL for email history
                console.log(`Successfully fetched HTML content from ${file.url}`);
                break; // Use the first HTML file found
              } else {
                console.error(`Failed to fetch HTML content from ${file.url}: ${response.statusText}`);
                // Don't set htmlContentFromFile for errors
              }
            } catch (error) {
              console.error(`Error fetching HTML content from ${file.url}:`, error);
              // Don't set htmlContentFromFile for errors
            }
            break; // Process only the first HTML file found
          }
        }

        // Only send email if we successfully found and fetched HTML content
        if (htmlContentFromFile) {
          const currentDate = new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          });

          // Create footer content
          const footerContent = `
            <div style="margin-top: 25px; font-size: 0.9em; padding: 20px; text-align: center;">
              ${!task.sendHtmlReportOnly ? `<p>Manage task and history at: <a href="${customerFrontendUrl}/tasks/${task.taskId}">${customerFrontendUrl}/tasks/${task.taskId}</a></p>` : ''}
              ${htmlContentUrl && !task.emailFriendlyHtml ? `<p><small><strong>Note:</strong> Some visuals may not display properly in the email. <a href="${htmlContentUrl}">View full report here</a> for the complete experience.</small></p>` : ''}
              <hr>
              <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
              <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${task.taskId}&email=${encodeURIComponent(toEmail)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
            </div>
          `;

          // For sendHTMLReportOnly, inject footer before closing </body> tag
          // For regular emails, inject before closing </body> tag
          const simplifiedHtml = htmlContentFromFile.replace('</body>', `${footerContent}</body>`);

          const subject = `${task.name} - ${currentDate}`;
          const text = `Task Report: ${task.name}\n\nView the HTML report in the email body.${!task.sendHtmlReportOnly ? `\n\nManage task and history at: ${customerFrontendUrl}/tasks/${task.taskId}` : ''}`;

          // Determine email sender configuration: task-level -> account-level -> system default
          let emailSender = task.emailSender;
          let fromName = task.fromName;

          // If task doesn't have custom email sender, use account-level configuration
          if (!emailSender || !fromName) {
            if (user.emailDomain && user.defaultSenderUsername && user.fromName) {
              emailSender = `${user.defaultSenderUsername}@${user.emailDomain}`;
              fromName = user.fromName;
            }
          }

          const hasCustomSender = Boolean(emailSender && fromName);
          const from = hasCustomSender ? `${fromName} <${emailSender}>` : SYSTEM_FROM;
          const resendResult = await resendService.sendEmail({
            from,
            to: toEmail,
            subject,
            html: simplifiedHtml,
            text,
            ...(hasCustomSender ? {} : { replyTo: SUPPORT_REPLY_TO })
          });
          const resendEmailId = resendResult?.id || null;
          console.log(`HTML-only task execution email sent via Resend to: ${toEmail} from: ${from}`, resendEmailId ? `(ID: ${resendEmailId})` : '');

          // Add email history to subscriber
          try {
            const sentAt = new Date().toISOString();
            await subscriberDb.addEmailHistory(execution.taskId, toEmail, {
              sentAt: sentAt,
              subject: subject,
              status: 'sent',
              taskExecutionId: executionId,
              htmlContentUrl: htmlContentUrl,
              senderType: 'resend',
              emailId: resendEmailId || undefined
            });
            console.log(`Added email history for subscriber: ${toEmail}`, resendEmailId ? `(Resend ID: ${resendEmailId})` : '');
          } catch (historyError) {
            console.error(`Failed to add email history for ${toEmail}:`, historyError);
            // Don't throw error, email was sent successfully
          }

          return;
        } else {
          // HTML content not available, don't send email
          console.log(`sendHtmlReportOnly enabled but no valid HTML content found for task ${task.taskId}, skipping email to ${toEmail}`);
          return;
        }
      }

      // Create execution start/end time strings
      const startTime = execution.startTime ? new Date(execution.startTime).toLocaleString() : 'Not available';
      const completedTime = execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'Not available';

      // Calculate execution duration if both start and end times are available
      let durationStr = '';
      if (execution.startTime && execution.completedAt) {
        const start = new Date(execution.startTime).getTime();
        const end = new Date(execution.completedAt).getTime();
        const durationMs = end - start;
        const durationMinutes = Math.floor(durationMs / 60000);
        const durationSeconds = Math.floor((durationMs % 60000) / 1000);

        if (durationMinutes > 0) {
          durationStr = `<p><strong>Duration:</strong> ${durationMinutes} minutes ${durationSeconds} seconds</p>`;
        } else {
          durationStr = `<p><strong>Duration:</strong> ${durationSeconds} seconds</p>`;
        }
      }

      // Fetch HTML content from result_files
      let htmlContentFromFile = '';
      let htmlContentUrl = '';
      if (execution.result_files && execution.result_files.length > 0) {
        for (const file of execution.result_files) {
          if ((file.is_html || file.view_type === 'html') && file.url) {
            try {
              // Import fetch
              const fetch = require('node-fetch');
              const response = await fetch(file.url);

              if (response.ok) {
                const fetchedHtmlContent = await response.text();
                htmlContentFromFile = `
                <div class="html-result">
                  <h3>HTML Result File:</h3>
                  ${fetchedHtmlContent}
                </div>
              `;
                htmlContentUrl = file.url; // Capture the URL for email history
                console.log(`Successfully fetched HTML content from ${file.url}`);
                break; // Use the first HTML file found
              } else {
                console.error(`Failed to fetch HTML content from ${file.url}: ${response.statusText}`);
                htmlContentFromFile = `
                <div class="html-result">
                  <h3>HTML Result File:</h3>
                  <p><i>Error fetching HTML content: ${response.statusText}</i></p>
                </div>
              `;
              }
            } catch (error) {
              console.error(`Error fetching HTML content from ${file.url}:`, error);
              htmlContentFromFile = `
              <div class="html-result">
                <h3>HTML Result File:</h3>
                <p><i>Error fetching HTML content</i></p>
              </div>
            `;
            }
            break; // Process only the first HTML file found, even if error
          }
        }
      }



      // Create HTML content for the email - matching agent-engine send_task_results style
      const html = `
      <html>
      <head>
        <style>
          body { font-family: sans-serif; margin: 0; padding: 0; }
          .container { padding: 0; }
          .header { font-size: 1.5em; font-weight: bold; margin-bottom: 15px; }
          .details { margin-bottom: 20px; padding: 15px; border: 1px solid #eee; border-radius: 5px; }
          .details p { margin: 5px 0; }
          .section { margin-top: 20px; }
          .section h3 { font-size: 1.2em; margin-top: 0; border-bottom: 2px solid #ecf0f1; padding-bottom: 8px; }
          pre { white-space: pre-wrap; word-wrap: break-word; padding: 15px; border-radius: 5px; font-size: 0.9em; }
          .html-result { border: 1px solid #ddd; padding: 10px; margin-top: 15px; border-radius: 5px; }
          .footer { margin-top: 25px; font-size: 0.9em; padding: 20px; }
          a { text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">Task Run Results for "${task.name}"</div>
          <div class="details">
            <p><strong>Status:</strong> ${execution.status.toUpperCase()}</p>
            <p><strong>Started:</strong> ${startTime}</p>
            <p><strong>Completed:</strong> ${completedTime}</p>
            ${execution.llmName ? `<p><strong>LLM Used:</strong> ${execution.llmName}</p>` : ''}
            ${durationStr ? `<p><strong>Duration:</strong> ${durationStr.replace(/<\/?p>|<\/?strong>/g, '')}</p>` : ''}
          </div>
          
          ${execution.result ? `
          <div class="section">
            <h3>Results Summary:</h3>
            <pre>${emailService.escapeHtml(execution.result)}</pre>
          </div>
          ` : ''}
          
          ${execution.error ? `
          <div class="section">
            <h3>Error Details:</h3>
            <pre>${emailService.escapeHtml(execution.error)}</pre>
          </div>
          ` : ''}
          
          ${htmlContentFromFile ? `
          <div class="section">
            ${htmlContentFromFile}
          </div>
          ` : ''}
          
          <div class="footer">
            ${!task.sendHtmlReportOnly ? `<p>Manage task and history at: <a href="${customerFrontendUrl}/tasks/${task.taskId}">${customerFrontendUrl}/tasks/${task.taskId}</a></p>` : ''}
            ${htmlContentUrl && !task.emailFriendlyHtml ? `<p><small><strong>Note:</strong> Some visuals may not display properly in the email. <a href="${htmlContentUrl}">View full report here</a> for the complete experience.</small></p>` : ''}
            <hr>
            <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
            <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${task.taskId}&email=${encodeURIComponent(toEmail)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
          </div>
        </div>
      </body></html>
    `;

      const subject = `AgentWeb - Task Run Results: ${task.name}`;
      const text = `Task: ${task.name}\nStatus: ${execution.status.toUpperCase()}${!task.sendHtmlReportOnly ? `\nManage task and history at: ${customerFrontendUrl}/tasks/${task.taskId}` : ''}`;

      // Determine email sender configuration: task-level -> account-level -> system default
      let emailSender = task.emailSender;
      let fromName = task.fromName;

      // If task doesn't have custom email sender, use account-level configuration
      if (!emailSender || !fromName) {
        if (user.emailDomain && user.defaultSenderUsername && user.fromName) {
          emailSender = `${user.defaultSenderUsername}@${user.emailDomain}`;
          fromName = user.fromName;
        }
      }

      const hasCustomSender = Boolean(emailSender && fromName);
      const from = hasCustomSender ? `${fromName} <${emailSender}>` : SYSTEM_FROM;
      const resendResult = await resendService.sendEmail({
        from,
        to: toEmail,
        subject,
        html,
        text,
        ...(hasCustomSender ? {} : { replyTo: SUPPORT_REPLY_TO })
      });
      const resendEmailId = resendResult?.id || null;
      console.log(`Task execution email sent via Resend to: ${toEmail} from: ${from}`, resendEmailId ? `(ID: ${resendEmailId})` : '');

      // Add email history to subscriber
      try {
        const sentAt = new Date().toISOString();
        await subscriberDb.addEmailHistory(execution.taskId, toEmail, {
          sentAt: sentAt,
          subject: subject,
          status: 'sent',
          taskExecutionId: executionId,
          htmlContentUrl: htmlContentUrl,
          senderType: 'resend',
          emailId: resendEmailId || undefined
        });
        console.log(`Added email history for subscriber: ${toEmail}`, resendEmailId ? `(Resend ID: ${resendEmailId})` : '');
      } catch (historyError) {
        console.error(`Failed to add email history for ${toEmail}:`, historyError);
        // Don't throw error, email was sent successfully
      }

    } catch (error) {
      console.error(`Error sending task execution email to ${toEmail}:`, error);
      throw error;
    }
  },

  async sendScheduledChatErrorEmail(
    toEmails: string | string[],
    scheduleName: string,
    disallowedFunctions: string[],
    scheduleId: string
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .error-section { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
            .error-section h3 { margin-top: 0; color: #856404; }
            .function-list { background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; }
            .function-list ul { margin: 0; padding-left: 20px; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
            .button:hover { background-color: #1565c0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>❌ Scheduled Chat Error</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${scheduleName}</p>
            </div>
            
            <div class="content">
              <div class="error-section">
                <h3>⚠️ Scheduled Chat Cannot Run</h3>
                <p style="margin: 0; line-height: 1.6;">
                  Your scheduled chat <strong>"${scheduleName}"</strong> was scheduled to run at <strong>${currentDate}</strong>, 
                  but it cannot execute because the following required function calls are not allowed by your subscription:
                </p>
                <div class="function-list">
                  <ul>
                    ${disallowedFunctions.map(func => `<li><strong>${func}</strong></li>`).join('')}
                  </ul>
                </div>
                <p style="margin: 10px 0 0 0; line-height: 1.6;">
                  Please contact your administrator to update your subscription type or modify the scheduled chat 
                  to only use function calls that are allowed by your current subscription.
                </p>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">
                This is an automated email from your scheduled chat. 
                <a href="${customerFrontendUrl}/agent-mode" style="color: #1976d2;">Manage your schedules</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Scheduled Chat Error: ${scheduleName}

Your scheduled chat "${scheduleName}" was scheduled to run at ${currentDate}, but it cannot execute because the following required function calls are not allowed by your subscription:

${disallowedFunctions.map(func => `- ${func}`).join('\n')}

Please contact your administrator to update your subscription type or modify the scheduled chat to only use function calls that are allowed by your current subscription.

---
This is an automated email from your scheduled chat.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `❌ Scheduled Chat Error: ${scheduleName} - Function Calls Not Allowed`;

      // Normalize to array for consistent handling
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];

      // Send ONE email to all recipients
      await this.sendEmail(emailList, subject, text, html);

      console.log(`Scheduled chat error email sent to recipients: ${emailList.join(', ')}`);

    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat error emails to ${emailList.join(', ')}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  },

  // ENG-826 (#1): sent when a scheduled chat has produced zero assistant output for
  // every automatic retry (past ZERO_ASSISTANT_MAX_REQUEUES) — i.e. it is now
  // consistently failing and will NOT be auto-retried again until its next scheduled
  // slot. Previously this state only produced a server log the owner never saw, so a
  // customer's schedule (e.g. the gemini-3.5-flash "LinkedIn Post Factory" runs in
  // ENG-826) could keep failing silently. Best-effort: never throws (a notification
  // failure must not break the run).
  async sendScheduledRunFailedEmail(
    toEmails: string | string[],
    scheduleName: string,
    scheduleId: string,
    opts: { failedAttempts: number; failureClass: 'budget' | 'transient' | 'system' }
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const { failedAttempts } = opts;
      // Escape the request-derived schedule name before it goes into HTML — a name
      // containing markup would otherwise render in the recipient's email client.
      const safeName = this.escapeHtml(scheduleName);
      // Class-specific guidance for the EXHAUSTED state. Deliberately NOT the per-run
      // in-chat message: that one promises "will be retried automatically", which would
      // contradict this email's "won't retry until the next scheduled run" framing.
      const GUIDANCE: Record<'budget' | 'transient' | 'system', string> = {
        budget: 'The run looks too large to finish in a single pass — splitting it into smaller batches (fewer items per run) should let each run complete.',
        transient: 'This looks like a temporary problem (a rate limit or a brief service hiccup). It may well recover on the next scheduled run; if it keeps happening, contact support.',
        system: 'This looks like a system error rather than a time or size limit, so retrying alone may not fix it — please contact support if it continues.',
      };
      const userMessage = GUIDANCE[opts.failureClass] || GUIDANCE.system;

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .error-section { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
            .error-section h3 { margin-top: 0; color: #856404; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>⚠️ Scheduled Chat Keeps Failing</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${safeName}</p>
            </div>
            <div class="content">
              <div class="error-section">
                <h3>Your scheduled chat has failed ${failedAttempts} times in a row</h3>
                <p style="margin: 0; line-height: 1.6;">
                  <strong>"${safeName}"</strong> last attempted to run at <strong>${currentDate}</strong> and produced no result.
                  It has now failed on every automatic retry, so it will not be retried again until its next scheduled run.
                </p>
                <p style="margin: 10px 0 0 0; line-height: 1.6;">${userMessage}</p>
              </div>
            </div>
            <div class="footer">
              <a class="button" href="${customerFrontendUrl}/agent-mode?tab=scheduled">Review your schedules</a>
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">This is an automated email from your scheduled chat.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `Scheduled Chat Keeps Failing: ${scheduleName}

"${scheduleName}" last attempted to run at ${currentDate} and produced no result. It has now failed ${failedAttempts} times in a row on every automatic retry, so it will not be retried again until its next scheduled run.

${userMessage}

---
Review your schedules: ${customerFrontendUrl}/agent-mode?tab=scheduled`;

      const subject = `⚠️ Scheduled Chat Keeps Failing: ${scheduleName}`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`Scheduled run-failed email sent to recipients: ${emailList.join(', ')} (schedule ${scheduleId})`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled run-failed email to ${emailList.join(', ')}:`, error);
      // Don't throw — a notification failure must not break the scheduled chat flow.
    }
  },

  async sendScheduledChatTokenLimitEmail(
    toEmails: string | string[],
    scheduleName: string,
    scheduleId: string,
    usageStatus: {
      used: number;
      allowance: number | null;
      percentUsed?: number;
      effectiveAllowance?: number | null;
      costUsed?: number;
      costAllowance?: number | null;
      costPercentUsed?: number;
    }
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      // A block can be caused by either the token-count cap or the dollar cost cap
      // (ENG-200). When the cost cap is the trigger — the only reason a user with an
      // unlimited token allowance can be blocked — render a cost-based message so it
      // doesn't misleadingly read "N/A tokens".
      const { blockedByCost } = deriveBlockedByCost(usageStatus);

      const limitLabel = blockedByCost ? 'Monthly Cost Limit Reached' : 'Monthly Token Limit Reached';
      const limitReasonText = blockedByCost ? 'monthly cost limit' : 'monthly token limit';
      const usageLine = blockedByCost
        ? `<strong>Spend:</strong> $${(usageStatus.costUsed ?? 0).toFixed(2)} / $${(usageStatus.costAllowance ?? 0).toFixed(2)} spent this month.`
        : `<strong>Usage:</strong> ${usageStatus.used.toLocaleString()} / ${usageStatus.allowance != null ? usageStatus.allowance.toLocaleString() : 'N/A'} tokens used this month.`;
      const usageLineText = blockedByCost
        ? `Spend: $${(usageStatus.costUsed ?? 0).toFixed(2)} / $${(usageStatus.costAllowance ?? 0).toFixed(2)} spent this month.`
        : `Usage: ${usageStatus.used.toLocaleString()} / ${usageStatus.allowance != null ? usageStatus.allowance.toLocaleString() : 'N/A'} tokens used this month.`;
      const allowanceResetNoun = blockedByCost ? 'cost allowance' : 'token allowance';

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .error-section { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
            .error-section h3 { margin-top: 0; color: #856404; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>❌ Scheduled Chat Error</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${scheduleName}</p>
            </div>
            <div class="content">
              <div class="error-section">
                <h3>⚠️ ${limitLabel}</h3>
                <p style="margin: 0; line-height: 1.6;">
                  Your scheduled chat <strong>"${scheduleName}"</strong> was scheduled to run at <strong>${currentDate}</strong>,
                  but it cannot execute because you have reached your ${limitReasonText}.
                </p>
                <p style="margin: 10px 0 0 0; line-height: 1.6;">
                  ${usageLine}
                </p>
                <p style="margin: 10px 0 0 0; line-height: 1.6;">
                  Your ${allowanceResetNoun} resets at the start of each billing period. To continue using scheduled chats, please upgrade your plan or wait for your allowance to reset.
                </p>
              </div>
            </div>
            <div class="footer">
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">
                This is an automated email from your scheduled chat.
                <a href="${customerFrontendUrl}/agent-mode" style="color: #1976d2;">Manage your schedules</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Scheduled Chat Error: ${scheduleName}

Your scheduled chat "${scheduleName}" was scheduled to run at ${currentDate}, but it cannot execute because you have reached your ${limitReasonText}.

${usageLineText}

Your ${allowanceResetNoun} resets at the start of each billing period. To continue using scheduled chats, please upgrade your plan or wait for your allowance to reset.

---
This is an automated email from your scheduled chat.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `❌ Scheduled Chat Error: ${scheduleName} - ${limitLabel}`;

      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);

      console.log(`Scheduled chat token limit email sent to: ${emailList.join(', ')}`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat token limit email to ${emailList.join(', ')}:`, error);
    }
  },

  async sendScheduledChatVariableRequestEmail(
    toEmails: string | string[],
    scheduleName: string,
    scheduleId: string,
    variables: Array<{ name: string; description?: string }>,
    variableInputUrl?: string,
    expiresAt?: string
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const manageUrl = `${customerFrontendUrl}/agent-mode`;
      const inputUrl = variableInputUrl || manageUrl;
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      const expirationDate = expiresAt
        ? new Date(expiresAt).toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short'
        })
        : null;

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 760px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
            .header { background-color: #1976d2; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { padding: 20px; }
            .var-list { margin: 12px 0 0 0; padding-left: 18px; }
            .var-list li { margin: 8px 0; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 10px 18px; text-decoration: none; border-radius: 4px; margin-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2 style="margin: 0;">Variable Values Required</h2>
              <p style="margin: 6px 0 0 0; opacity: 0.92;">${scheduleName}</p>
            </div>
            <div class="content">
              <p>
                A scheduled chat run was due at <strong>${currentDate}</strong>, but it is waiting for variable values.
              </p>
              <p>Please provide values for:</p>
              <ul class="var-list">
                ${variables.map(variable => `<li><strong>{{${variable.name}}}</strong>${variable.description ? ` - ${variable.description}` : ''}</li>`).join('')}
              </ul>
              ${expirationDate ? `<p><strong>This request expires at ${expirationDate}.</strong></p>` : ''}
              <p>After values are provided, the scheduled run will start automatically.</p>
              <a href="${inputUrl}" class="button">Provide Variable Values</a>
              <p style="margin-top: 12px; font-size: 12px; color: #6c757d;">
                This link can only be used once and cannot be used after it expires.
              </p>
            </div>
            <div class="footer">
              <p style="margin: 0; color: #6c757d; font-size: 12px;">
                Schedule ID: ${scheduleId}
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Scheduled Chat Waiting For Variables: ${scheduleName}

A scheduled chat run was due at ${currentDate}, but it is waiting for variable values.

Please provide values for:
${variables.map(variable => `- {{${variable.name}}}${variable.description ? `: ${variable.description}` : ''}`).join('\n')}

${expirationDate ? `This request expires at ${expirationDate}.\n` : ''}

After values are provided, the scheduled run will start automatically.

Provide variable values: ${inputUrl}
This link can only be used once and cannot be used after it expires.

Manage scheduled chats: ${manageUrl}
Schedule ID: ${scheduleId}
      `;

      const subject = `🟡 Scheduled Chat Waiting for Variables: ${scheduleName}`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`Scheduled chat variable request email sent to recipients: ${emailList.join(', ')}`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat variable request emails to ${emailList.join(', ')}:`, error);
    }
  },

  // ENG-396: a scheduled/headless run paused because Emma emitted a blocking
  // AskUserQuestion (e.g. an immutable Meta campaign objective) and there was no
  // human present to answer it. The run did NOT proceed on a guess — it is waiting
  // for the owner to make a choice. Deliberately decision-agnostic: the specific
  // options live in the chat, so this wording is stable regardless of the question.
  async sendScheduledChatPausedForInputEmail(
    toEmails: string | string[],
    scheduleName: string,
    scheduleId: string,
    question: string,
    sessionId?: string
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      // Deep-link must use the PATH form `/agent-mode/<sessionId>` — the customer
      // portal reads the session id from the route param (useParams), NOT from a
      // `?sessionId=` query, so the query form would open a blank chat and the
      // "Open chat to decide" button would dead-end away from the parked question.
      const openUrl = `${customerFrontendUrl}/agent-mode${sessionId ? `/${encodeURIComponent(sessionId)}` : ''}`;
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 760px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
            .header { background-color: #f9a825; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { padding: 20px; }
            .question { margin: 12px 0; padding: 14px 16px; background-color: #fff8e1; border-left: 4px solid #f9a825; border-radius: 4px; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #f9a825; color: white !important; padding: 10px 18px; text-decoration: none; border-radius: 4px; margin-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2 style="margin: 0;">Emma needs your input to continue</h2>
              <p style="margin: 6px 0 0 0; opacity: 0.92;">${this.escapeHtml(scheduleName)}</p>
            </div>
            <div class="content">
              <p>Your scheduled run on ${currentDate} paused because Emma needs you to make a choice before continuing. She did not proceed on a guess.</p>
              <div class="question">${this.escapeHtml(question)}</div>
              <p>Open the chat to see the options and choose, and the run will pick up from there.</p>
              <a class="button" href="${openUrl}">Open chat to decide</a>
            </div>
            <div class="footer" style="color: #6c757d; font-size: 13px;">Schedule ID: ${scheduleId}</div>
          </div>
        </body>
        </html>
      `;

      const text = `
Emma needs your input to continue: ${scheduleName}

Your scheduled run on ${currentDate} paused because Emma needs you to make a choice before continuing. She did not proceed on a guess.

${question}

Open the chat to see the options and choose, and the run will pick up from there:
${openUrl}

Schedule ID: ${scheduleId}
      `;

      const subject = `🟡 Emma needs your input: ${scheduleName}`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`Scheduled chat paused-for-input email sent to recipients: ${emailList.join(', ')}`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat paused-for-input emails to ${emailList.join(', ')}:`, error);
    }
  },

  async sendScheduledChatResultEmail(
    toEmails: string | string[],
    scheduleName: string,
    result: {
      passed: boolean;
      actualResponse: string;
      keywordMatches: string[];
      keywordMisses: string[];
      functionCallMatches: string[];
      functionCallMisses: string[];
      functionCallDetails?: { [functionName: string]: { actual: number; required: number } };
      executionTime: number;
      sessionId: string;
      attempt: number;
      createdAt: string;
    },
    scheduleId: string,
    summary?: string
  ) {
    try {
      const { marked } = await import('marked');
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      // ENG-351: resolve {{cite:N}} markers to inline sources so recipients can trace each figure.
      // 'markdown' → the HTML body (marked()) renders clickable source links; the plain-text body
      // shows the same as "[Source](url)". Falls back to stripping.
      result = { ...result, actualResponse: await resolveEmmaCitationsForEmail(result.actualResponse || '', result.sessionId, 'markdown') };

      // Create an interactive share for the session so user can access without login
      let sessionUrl = `${customerFrontendUrl}/agent-mode/${result.sessionId}`;
      try {
        // Use the common function to create or reuse interactive share
        sessionUrl = await chatbotDb.createOrReuseInteractiveShare(result.sessionId);

        console.log(`Created or reused interactive share for scheduled chat session ${result.sessionId}`);
      } catch (shareError) {
        console.error('Error creating interactive share for scheduled chat:', shareError);
        // Fall back to regular agent-mode URL if share creation fails
      }

      const statusColor = result.passed ? '#28a745' : '#dc3545';
      const statusIcon = result.passed ? '✅' : '❌';

      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #1976d2; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .status { display: inline-block; padding: 8px 16px; border-radius: 4px; font-weight: bold; margin: 10px 0; }
            .status.passed { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .status.failed { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            .section { margin: 20px 0; padding: 15px; border: 1px solid #e9ecef; border-radius: 4px; }
            .section h3 { margin-top: 0; color: #495057; border-bottom: 2px solid #e9ecef; padding-bottom: 8px; }
            .criteria { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 15px 0; }
            .criteria-item { padding: 10px; background-color: #f8f9fa; border-radius: 4px; }
            .criteria-item h4 { margin: 0 0 8px 0; color: #495057; }
            .matches { color: #28a745; font-weight: bold; }
            .misses { color: #dc3545; font-weight: bold; }
            .response { background-color: #f8f9fa; padding: 15px; border-radius: 4px; border-left: 4px solid #1976d2; word-wrap: break-word; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
            .button:hover { background-color: #1565c0; }
            .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 15px 0; }
            .stat { text-align: center; padding: 10px; background-color: #f8f9fa; border-radius: 4px; }
            .stat-value { font-size: 24px; font-weight: bold; color: #1976d2; }
            .stat-label { font-size: 12px; color: #6c757d; text-transform: uppercase; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>${statusIcon} Scheduled Chat Results</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${scheduleName}</p>
            </div>
            
            <div class="content">
              <div class="section" style="background-color: ${result.passed ? '#e8f5e8' : '#ffeaea'}; border-left: 4px solid ${result.passed ? '#28a745' : '#dc3545'}; margin: 20px 0;">
                <p style="margin: 0; font-size: 16px; line-height: 1.5;">
                  Your scheduled chat <strong>"${scheduleName}"</strong> has been ${result.passed ? 'successfully executed' : 'executed but did not meet all criteria'} and results are ready. 
                  It ran for <strong>${Math.round(result.executionTime / 1000)} seconds</strong> 
                  and completed at <strong>${currentDate}</strong>.
                </p>
              </div>
              
              ${result.functionCallDetails && Object.keys(result.functionCallDetails).length > 0 ? `
              <div class="section">
                <h3>🔧 Function Call Details</h3>
                <div class="criteria">
                  ${Object.entries(result.functionCallDetails).map(([funcName, details]) => `
                    <div class="criteria-item">
                      <h4>${funcName}</h4>
                      <p>
                        <span class="${details.actual >= details.required ? 'matches' : 'misses'}">
                          ${details.actual}/${details.required} calls
                        </span>
                        ${details.actual >= details.required ? '✅' : '❌'}
                      </p>
                    </div>
                  `).join('')}
                </div>
              </div>
              ` : ''}
              
              <div class="section">
                <h3>💬 AI Response</h3>
                <div class="response">${marked(result.actualResponse)}</div>
              </div>
              
              <div class="section">
                <h3>🔗 Continue the Conversation</h3>
                <p>Click the button below to view the complete conversation and continue chatting with the AI.</p>
                <a href="${sessionUrl}" class="button">Continue Chatting</a>
                <p style="margin-top: 10px; font-size: 14px; color: #6c757d;">
                  Or copy this link: <a href="${sessionUrl}">${sessionUrl}</a>
                </p>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">
                This is an automated email from your scheduled chat. 
                <a href="${customerFrontendUrl}/agent-mode" style="color: #1976d2;">Manage your schedules</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Scheduled Chat Results: ${scheduleName}

Your scheduled chat "${scheduleName}" has been ${result.passed ? 'successfully executed' : 'executed but did not meet all criteria'} and results are ready.
It ran for ${Math.round(result.executionTime / 1000)} seconds and completed at ${currentDate}.

${result.functionCallDetails && Object.keys(result.functionCallDetails).length > 0 ? `
Function Call Details:
${Object.entries(result.functionCallDetails).map(([funcName, details]) =>
        `- ${funcName}: ${details.actual}/${details.required} calls ${details.actual >= details.required ? '✅' : '❌'}`
      ).join('\n')}

` : ''}AI Response:
${result.actualResponse}

Continue the conversation: ${sessionUrl}

---
This is an automated email from your scheduled chat.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `${statusIcon} Scheduled Chat: ${scheduleName}${summary ? ` — ${summary}` : ''}`;

      // Normalize to array for consistent handling
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];

      // Recipient-authorization guard (ENG-500): if this run read cross-account
      // user data via an admin-only tool, the report can contain other accounts'
      // identities/records — so restrict distribution to authorized (admin)
      // recipients + the owner, rather than auto-sending to every configured
      // address. No-op for ordinary reports. Fail-closed: if we cannot classify
      // the run (session lookup error), treat it as sensitive.
      let recipients = emailList;
      let finalHtml = html;
      let finalText = text;
      let guardOwnerEmail: string | undefined;
      try {
        let guardSession: any;
        // FAIL-CLOSED DEFAULT: treat the report as sensitive UNLESS we can
        // positively verify it is ordinary. Verification requires a present
        // session AND a clean strongly-consistent tool-call record. A missing
        // session, an unreadable/stale record, or any error therefore restricts
        // distribution rather than broadcasting — closing the whole class of
        // "couldn't classify → sent to everyone" fail-opens.
        let isSensitive = true;
        try {
          guardSession = await chatbotDb.getChatSession(result.sessionId);
          if (guardSession) {
            if (reportContainsCrossAccountData(guardSession.calledFunctions)) {
              isSensitive = true;
            } else {
              // calledFunctions is a best-effort counter (its write errors are
              // swallowed at the call site), so a successful cross-account tool
              // call can be missing from it. Confirm against the authoritative
              // tool-call message records. Use a STRONGLY CONSISTENT read: this
              // send fires immediately after the run wrote these messages, so an
              // eventually-consistent read could miss a just-written call.
              const guardMessages = await chatbotDb.getMessagesFromMessagesTable(result.sessionId, true);
              isSensitive = messagesReferenceCrossAccountTool(guardMessages as any);
            }
          }
          // guardSession falsy → cannot verify → isSensitive stays true (closed).
        } catch (classifyError) {
          console.error(`Scheduled report guard: could not classify session ${result.sessionId}; failing closed (treating as sensitive):`, classifyError);
          isSensitive = true;
        }
        // Resolve the owner email up front — used both to authorize the owner and
        // to notify them if delivery ends up blocked.
        try {
          const owner = guardSession?.userId ? await userDb.getUserById(guardSession.userId) : undefined;
          guardOwnerEmail = (owner as any)?.email;
        } catch { /* owner unknown → resolver still restricts to verified admins */ }
        if (isSensitive) {
          const authz = await resolveAuthorizedReportRecipients({ recipients: emailList, ownerEmail: guardOwnerEmail, isSensitive: true });
          recipients = authz.authorized;
          if (authz.withheld.length > 0) {
            const noticeText = `⚠️ ${authz.withheld.length} recipient(s) were withheld from this report because it contains cross-account account data and they are not authorized to receive it: ${authz.withheld.join(', ')}. To share this data, ensure recipients are admin users.`;
            // Escape the notice before HTML interpolation: withheld addresses are
            // attacker-influenceable (a configured recipient can contain HTML
            // metacharacters), so raw insertion would inject markup into the notice.
            finalHtml = `<div style="margin:0 0 16px 0;padding:12px 16px;background-color:#fff3cd;border:1px solid #ffe69c;border-radius:6px;color:#664d03;font-family:Arial,sans-serif;font-size:14px;">${this.escapeHtml(noticeText)}</div>${html}`;
            finalText = `${noticeText}\n\n${text}`;
            console.warn(`Scheduled report guard: withheld ${authz.withheld.length} unauthorized recipient(s) for session ${result.sessionId}: ${authz.withheld.join(', ')}`);
          }
        }
      } catch (guardError) {
        // Guard itself failed unexpectedly — fail-closed: withhold entirely rather
        // than risk distributing possibly-sensitive data to unverified addresses.
        // The empty-recipients branch below notifies the owner so it is not silent.
        console.error(`Scheduled report guard errored for session ${result.sessionId}; failing closed:`, guardError);
        recipients = [];
      }

      if (recipients.length === 0) {
        // Fail-closed left no authorized recipient. Do NOT silently drop the
        // completed report: notify the schedule owner that delivery was blocked
        // (a status message ONLY — never the report data) so the report is not
        // lost without a signal and the owner can add an authorized recipient.
        console.error(`Scheduled report for session ${result.sessionId} had no authorized recipients after the guard; report NOT delivered.`);
        // Durable escalation so a fully-withheld report is never lost silently —
        // this fires regardless of whether the owner email is known or its notice
        // succeeds (owner-notice failure would otherwise be swallowed by sendEmail).
        try {
          await this.sendOncallAlert(
            `Scheduled report withheld — no authorized recipients: ${scheduleName}`,
            `Session ${result.sessionId} produced a report containing cross-account account data, but none of its configured recipients (or the schedule owner) are authorized (admin) to receive it, so it was not delivered. Owner: ${guardOwnerEmail || 'unknown'}. Add an authorized recipient or adjust the report.`
          );
        } catch (alertError) {
          console.error(`Failed to send oncall alert for withheld report ${result.sessionId}:`, alertError);
        }
        if (guardOwnerEmail) {
          try {
            const blockedSubject = `⚠️ Scheduled report not delivered: ${scheduleName}`;
            const blockedText = `Your scheduled report "${scheduleName}" was not delivered because it contains cross-account account data and none of its configured recipients are authorized (admin) to receive it. Add an admin recipient (or adjust the report) and re-run.`;
            const blockedHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#664d03;padding:12px 16px;background-color:#fff3cd;border:1px solid #ffe69c;border-radius:6px;">${this.escapeHtml(blockedText)}</div>`;
            await this.sendEmail([guardOwnerEmail], blockedSubject, blockedText, blockedHtml);
            console.log(`Scheduled report delivery-blocked notice sent to owner ${guardOwnerEmail} for session ${result.sessionId}`);
          } catch (notifyError) {
            console.error(`Failed to send delivery-blocked notice for session ${result.sessionId}:`, notifyError);
          }
        }
      } else {
        // Send ONE email to all authorized recipients
        await this.sendEmail(recipients, subject, finalText, finalHtml);
        console.log(`Scheduled chat result email sent to recipients: ${recipients.join(', ')}`);
      }

    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat result emails to ${emailList.join(', ')}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  },

  async sendSessionNotificationEmail(
    toEmails: string | string[],
    sessionId: string,
    content: string,
    subject?: string
  ) {
    try {
      const { marked } = await import('marked');
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      // ENG-351: resolve {{cite:N}} markers to inline sources; 'markdown' → clickable links in the
      // marked()-rendered HTML body. Falls back to stripping.
      content = await resolveEmmaCitationsForEmail(content, sessionId, 'markdown');

      // Create or reuse interactive share so recipients can view without login
      let sessionUrl = `${customerFrontendUrl}/agent-mode/${sessionId}`;
      try {
        sessionUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId);
      } catch (shareError) {
        console.error('Error creating interactive share for session notification:', shareError);
      }

      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const emailSubject = subject ? `📋 Session Report — ${subject}` : `📋 Session Report from AgentWeb`;

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #1976d2; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .section { margin: 20px 0; padding: 15px; border: 1px solid #e9ecef; border-radius: 4px; }
            .section h3 { margin-top: 0; color: #495057; border-bottom: 2px solid #e9ecef; padding-bottom: 8px; }
            .response { background-color: #f8f9fa; padding: 15px; border-radius: 4px; border-left: 4px solid #1976d2; word-wrap: break-word; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
            .button:hover { background-color: #1565c0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📋 Session Report</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${currentDate}</p>
            </div>

            <div class="content">
              <div class="section">
                <h3>💬 Summary</h3>
                <div class="response">${marked(content)}</div>
              </div>

              <div class="section">
                <h3>🔗 View Full Session</h3>
                <p>Click the button below to view the complete conversation.</p>
                <a href="${sessionUrl}" class="button">Open Session</a>
                <p style="margin-top: 10px; font-size: 14px; color: #6c757d;">
                  Or copy this link: <a href="${sessionUrl}">${sessionUrl}</a>
                </p>
              </div>
            </div>

            <div class="footer">
              <p style="margin: 0; font-size: 12px; color: #6c757d;">
                Sent via <a href="${customerFrontendUrl}" style="color: #1976d2;">AgentWeb</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `Session Report — ${currentDate}

${content}

View the full session: ${sessionUrl}

---
Sent via AgentWeb: ${customerFrontendUrl}
      `;

      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmailStrict(emailList, emailSubject, text, html);
      console.log(`Session notification email sent to: ${emailList.join(', ')}`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending session notification email to ${emailList.join(', ')}:`, error);
      throw error; // Let the tool surface the error to the agent
    }
  },

  async sendDailyDigestEmail(
    toEmails: string | string[],
    scheduleName: string,
    todaysResults: any[],
    scheduleId: string,
    customDate?: Date
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      // ENG-351: resolve {{cite:N}} markers in each run's response preview to inline "(Source)"
      // attributions (falls back to stripping) — email has no citation-chip renderer.
      todaysResults = await Promise.all(
        (todaysResults || []).map(async (r) =>
          r && typeof r.actualResponse === 'string'
            ? { ...r, actualResponse: await resolveEmmaCitationsForEmail(r.actualResponse, r.sessionId) }
            : r
        )
      );

      const displayDate = customDate || new Date();
      const currentDate = displayDate.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // Determine if this is for today or a different date
      const isToday = !customDate || displayDate.toDateString() === new Date().toDateString();
      const dateLabel = isToday ? "Today's Summary" : `${currentDate} Summary`;

      // Calculate summary statistics
      const totalRuns = todaysResults.length;
      const successfulRuns = todaysResults.filter(result => result.passed).length;
      const failedRuns = totalRuns - successfulRuns;
      const averageExecutionTime = Math.round(
        todaysResults.reduce((sum, result) => sum + result.executionTime, 0) / totalRuns / 1000
      );

      // Create interactive shares for all sessions
      const sessionUrls: { [sessionId: string]: string } = {};
      for (const result of todaysResults) {
        if (result.sessionId) {
          try {
            // Use the common function to create or reuse interactive share
            sessionUrls[result.sessionId] = await chatbotDb.createOrReuseInteractiveShare(result.sessionId);
          } catch (shareError) {
            console.error('Error creating interactive share for daily digest:', shareError);
            // Fall back to regular agent-mode URL if share creation fails
            sessionUrls[result.sessionId] = `${customerFrontendUrl}/agent-mode/${result.sessionId}`;
          }
        }
      }

      // Generate results HTML
      const resultsHtml = todaysResults.map((result, index) => {
        const statusIcon = result.passed ? '✅' : '❌';
        const statusColor = result.passed ? '#28a745' : '#dc3545';
        const runTime = new Date(result.createdAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit'
        });
        const sessionUrl = result.sessionId ? sessionUrls[result.sessionId] : '#';

        return `
          <div class="result-item" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin: 10px 0; background-color: ${result.passed ? '#f8fff8' : '#fff8f8'};">
            <div class="result-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <div class="result-info">
                <span class="status-badge" style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background-color: ${statusColor}; color: white;">
                  ${statusIcon} ${result.passed ? 'PASSED' : 'FAILED'}
                </span>
                <span style="margin-left: 15px; color: #6c757d; font-size: 14px;">Run ${index + 1} at ${runTime}</span>
              </div>
              <div class="result-stats" style="font-size: 12px; color: #6c757d; text-align: right; min-width: 120px;">
                <div style="margin-bottom: 2px;">${Math.round(result.executionTime / 1000)}s</div>
                <div>Attempt ${result.attempt || 1}</div>
              </div>
            </div>
            <div class="result-content">
              <div class="response-preview" style="background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; font-size: 14px; line-height: 1.4; max-height: 100px; overflow: hidden; position: relative;">
                ${this.escapeHtml(result.actualResponse.length > 200 ? result.actualResponse.substring(0, 200) + '...' : result.actualResponse)}
              </div>
              ${result.sessionId ? `
                <a href="${sessionUrl}" class="view-conversation-btn" style="display: inline-block; background-color: #1976d2; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-size: 12px; margin-top: 8px;">
                  View Full Conversation
                </a>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 900px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #1976d2, #1565c0); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; font-weight: 300; }
            .header p { margin: 10px 0 0 0; opacity: 0.9; font-size: 16px; }
            .content { padding: 30px; }
            .summary { background: linear-gradient(135deg, #f8f9fa, #e9ecef); padding: 20px; border-radius: 8px; margin: 20px 0; }
            .summary h2 { margin: 0 0 15px 0; color: #495057; font-size: 20px; }
            .stats-container { display: table; width: 100%; padding: 20px 0; margin: 15px 0; }
            .stat-item { display: table-cell; text-align: center; width: 25%; vertical-align: middle; }
            .stat-value { font-size: 28px; font-weight: bold; color: #1976d2; margin-bottom: 5px; }
            .stat-label { font-size: 13px; color: #6c757d; font-weight: 500; }
            .results-section { margin: 30px 0; }
            .results-section h2 { color: #495057; border-bottom: 2px solid #e9ecef; padding-bottom: 10px; margin-bottom: 20px; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; font-weight: 500; }
            .button:hover { background-color: #1565c0; }
            .view-conversation-btn:hover { background-color: #1565c0 !important; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📊 Daily Digest</h1>
              <p>${scheduleName} - ${currentDate}</p>
            </div>
            
            <div class="content">
              <div class="summary">
                <h2>📈 ${dateLabel}</h2>
                <p style="margin: 0 0 15px 0; color: #6c757d; font-size: 16px;">
                  Your scheduled chat ran <strong>${totalRuns} times</strong> on <strong>${currentDate}</strong> with a <strong>${Math.round((successfulRuns / totalRuns) * 100)}%</strong> success rate.
                </p>
                <div class="stats-container">
                  <div class="stat-item">
                    <div class="stat-value">${totalRuns}</div>
                    <div class="stat-label">Total Runs</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value" style="color: #28a745;">${successfulRuns}</div>
                    <div class="stat-label">Successful</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value" style="color: #dc3545;">${failedRuns}</div>
                    <div class="stat-label">Failed</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value">${averageExecutionTime}s</div>
                    <div class="stat-label">Avg Runtime</div>
                  </div>
                </div>
              </div>
              
              <div class="results-section">
                <h2>🔍 Individual Run Results</h2>
                <p style="color: #6c757d; margin-bottom: 20px;">
                  Click on any "View Full Conversation" button to continue chatting with the AI about that specific run.
                </p>
                ${resultsHtml}
              </div>
            </div>
            
            <div class="footer">
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">
                This is your daily digest for scheduled chat "${scheduleName}". 
                <a href="${customerFrontendUrl}/agent-mode" style="color: #1976d2;">Manage your schedules</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Daily Digest: ${scheduleName} - ${currentDate}

${dateLabel}:
- Total Runs: ${totalRuns}
- Successful: ${successfulRuns}
- Failed: ${failedRuns}
- Average Runtime: ${averageExecutionTime} seconds
- Success Rate: ${Math.round((successfulRuns / totalRuns) * 100)}%

Individual Run Results:
${todaysResults.map((result, index) => {
        const runTime = new Date(result.createdAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit'
        });
        const sessionUrl = result.sessionId ? sessionUrls[result.sessionId] : 'N/A';
        return `
Run ${index + 1} at ${runTime} - ${result.passed ? 'PASSED' : 'FAILED'}
Response: ${result.actualResponse.substring(0, 100)}${result.actualResponse.length > 100 ? '...' : ''}
View Conversation: ${sessionUrl}
`;
      }).join('\n')}

---
This is your daily digest for scheduled chat "${scheduleName}" for ${currentDate}.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `📊 Daily Digest: ${scheduleName} - ${currentDate} - ${totalRuns} runs (${Math.round((successfulRuns / totalRuns) * 100)}% success)`;

      // Normalize to array for consistent handling
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];

      // Send ONE email to all recipients
      await this.sendEmail(emailList, subject, text, html);

      console.log(`Daily digest email sent to recipients: ${emailList.join(', ')}`);

    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending daily digest emails to ${emailList.join(', ')}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  },

  async sendSlackTriggeredSessionEmail(
    toEmails: string | string[],
    params: {
      sessionId: string;
      userEmail: string;
      channelName: string;
      originalMessage: string;
      emmaResponse: string;
      receivedAt: string;
      senderDisplayName?: string;
    }
  ) {
    try {
      const { sessionId, userEmail, channelName, originalMessage, emmaResponse, receivedAt, senderDisplayName } = params;
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      // ENG-351: resolve {{cite:N}} markers to inline "(Source)" attributions (falls back to strip).
      const emmaResponseText = await resolveEmmaCitationsForEmail(emmaResponse, sessionId);

      let sessionUrl = `${customerFrontendUrl}/agent-mode/${sessionId}`;
      try {
        const { chatbotDb } = await import('./chatbotService');
        sessionUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId);
      } catch (shareError) {
        console.error('Error creating interactive share for slack triggered session:', shareError);
      }

      const formattedDate = new Date(receivedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #611f69; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .header p { margin: 5px 0 0 0; opacity: 0.9; font-size: 14px; }
            .content { padding: 20px; }
            .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
            .meta-item { padding: 10px 15px; background-color: #f8f9fa; border-radius: 6px; border-left: 3px solid #611f69; }
            .meta-item .label { font-size: 11px; text-transform: uppercase; color: #6c757d; margin-bottom: 4px; }
            .meta-item .value { font-size: 14px; color: #212529; font-weight: 500; }
            .section { margin: 20px 0; }
            .section-title { font-size: 14px; font-weight: bold; text-transform: uppercase; color: #6c757d; margin-bottom: 8px; letter-spacing: 0.5px; }
            .message-box { background-color: #f8f9fa; padding: 15px; border-radius: 6px; border-left: 4px solid #611f69; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.6; }
            .response-box { background-color: #f0f7ff; padding: 15px; border-radius: 6px; border-left: 4px solid #1976d2; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.6; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; border-top: 1px solid #e9ecef; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>💬 New Client Question from Slack</h1>
              <p>Emma has prepared a draft response for your review</p>
            </div>
            <div class="content">
              <div class="meta">
                <div class="meta-item">
                  <div class="label">Client Account</div>
                  <div class="value">${this.escapeHtml(userEmail)}</div>
                </div>
                <div class="meta-item">
                  <div class="label">Slack Channel</div>
                  <div class="value">#${this.escapeHtml(channelName)}</div>
                </div>
                <div class="meta-item">
                  <div class="label">Received At</div>
                  <div class="value">${formattedDate}</div>
                </div>
              </div>

              <div class="section">
                <div class="section-title">Original Message from ${this.escapeHtml(senderDisplayName || 'Unknown')}</div>
                <div class="message-box">${this.escapeHtml(originalMessage)}</div>
              </div>

              <div class="section">
                <div class="section-title">Emma's Draft Response</div>
                <div class="response-box">${this.escapeHtml(emmaResponseText)}</div>
              </div>
            </div>
            <div class="footer">
              <a href="${sessionUrl}" class="button">View Full Session</a>
              <p style="margin: 15px 0 0 0; color: #6c757d; font-size: 12px;">
                Open the session to review the conversation, edit Emma's response, or continue the chat.
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `New Client Question from Slack

Client: ${userEmail}
Channel: #${channelName}
Received: ${formattedDate}

Original Message from ${senderDisplayName || 'Unknown'}:
${originalMessage}

Emma's Draft Response:
${emmaResponseText}

View Session: ${sessionUrl}`;

      const subject = `💬 Client question from #${channelName} — ${senderDisplayName || userEmail}`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`Slack triggered session email sent to: ${emailList.join(', ')} for session ${sessionId}`);
    } catch (error) {
      console.error('Error sending slack triggered session email:', error);
      // Non-blocking: email failure should not interrupt the session flow
    }
  },

  async sendOncallAlert(
    subject: string,
    message: string,
    context?: Record<string, any>,
    trackerUrl?: string
  ) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Suppressed oncall alert: ${subject}`);
      return;
    }
    try {
      const oncallEmails = await getAlertEmails('oncall_emails', ['ruiw@agentweb.pro']);
      const env: string = process.env.NODE_ENV || 'unknown';
      const envLabel = env === 'production' ? 'PROD' : env.toUpperCase();

      // File a tracked oncall item if no URL was provided. System-generated work always goes
      // through Linear; generic alerts fail closed to PM triage because this layer cannot prove
      // that a code-only fix is safe. A filing failure leaves the full detail in email.
      let resolvedTrackerUrl = trackerUrl || null;
      if (!resolvedTrackerUrl) {
        try {
          const { fileAutoIssue } = await import('./intakeService');
          const result = await fileAutoIssue({
            title: subject,
            description: message,
            source: 'Oncall alert',
            executionRoute: 'human-triage',
            extraLabels: ['Oncall'],
            notionTags: [],
            notionContext: context,
          });
          resolvedTrackerUrl = result.url || null;
          console.log(`Oncall item filed (${result.tracker}): ${resolvedTrackerUrl}`);
        } catch (fileError) {
          console.error('Failed to file oncall item, falling back to full email:', fileError);
        }
      }

      let html: string;
      let text: string;

      if (resolvedTrackerUrl) {
        // Slim email with a link to the canonical tracked issue.
        html = `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
          <div style="background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">⚠️ [${envLabel}] Oncall Alert</h1>
          </div>
          <div style="background-color: white; padding: 20px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #dc3545; margin-top: 0;">${this.escapeHtml(subject)}</h2>
            <div style="margin: 20px 0;">
              <a href="${this.escapeHtml(resolvedTrackerUrl)}" style="display: inline-block; padding: 12px 24px; background-color: #dc3545; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">View tracked issue</a>
            </div>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e9ecef; color: #6c757d; font-size: 12px;">
              <p>Full details are available in the tracked issue above.</p>
            </div>
          </div>
        </div>
        `;

        text = `⚠️ [${envLabel}] Oncall Alert\n\n${subject}\n\nIssue: ${resolvedTrackerUrl}`;
      } else {
        // Full detail email (fallback when issue filing failed)
        const contextHtml = context
          ? Object.entries(context)
            .map(([key, value]) => {
              const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
              return `<tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background-color: #f8f9fa;">${this.escapeHtml(key)}</td><td style="padding: 8px; border: 1px solid #ddd; white-space: pre-wrap; word-wrap: break-word;">${this.escapeHtml(displayValue)}</td></tr>`;
            })
            .join('')
          : '';

        html = `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
          <div style="background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">⚠️ [${envLabel}] Oncall Alert</h1>
          </div>
          <div style="background-color: white; padding: 20px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #dc3545; margin-top: 0;">${this.escapeHtml(subject)}</h2>
            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${this.escapeHtml(message)}</p>
            </div>
            ${contextHtml ? `
            <h3 style="color: #495057; margin-top: 30px;">Additional Context:</h3>
            <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
              ${contextHtml}
            </table>
            ` : ''}
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e9ecef; color: #6c757d; font-size: 12px;">
              <p>This is an automated alert that requires immediate attention.</p>
            </div>
          </div>
        </div>
        `;

        text = `
⚠️ [${envLabel}] Oncall Alert

${subject}

${message}

${context ? Object.entries(context).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`).join('\n') : ''}
        `.trim();
      }

      await this.sendEmail(oncallEmails, `[${envLabel}] ${subject}`, text, html);
      console.log(`Oncall alert sent to: ${oncallEmails.join(', ')}`);
    } catch (error) {
      console.error('Error sending oncall alert:', error);
      // Don't throw - alert failure shouldn't break the main flow
    }
  }
}; 
