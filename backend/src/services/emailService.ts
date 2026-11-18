import dotenv from 'dotenv';
import { isSuppressedSendResult } from '../utils/nonProdEmailGuard';

import { resendService } from './resendService';
import { deriveBlockedByCost } from './tokenUsageService';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';
import { chatbotDb } from './chatbotService';
import { userDb } from './db';
import { reportContainsCrossAccountData, messagesReferenceCrossAccountTool, resolveAuthorizedReportRecipients, recordReportDeliveryState, deliveryEnforcementEnabled, logShadowDecision } from './scheduledReportAccess';
import { settingsService } from './settingsService';
import { Citation, CitationRenderFormat, renderCitationMarkers, stripCitationMarkers } from '../utils/citations';
import { LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON } from '../utils/scheduleRunBlockedReason';
import { resetDateFromMonth, formatResetDateLong } from '../utils/usageCycle';
import { buildUsageBlockCopy, paygBlockActionSentence, type UsageBlockPaygInput } from '../utils/usageBlockCopy';
import {
  paygInvoiceCreatedEmailCopy,
  paygPaymentActionRequiredEmailCopy,
  paygPaymentFailedEmailCopy,
  paygPaymentUnconfirmedEmailCopy,
  type PaygSettlementEmailCopy,
} from '../utils/paygSettlementCopy';
import { buildScheduleModelNotice, buildWorkPlanStepModelNotice, type ModelNoticeCopy } from '../utils/unattendedModelNoticeCopy';
import type { ModelUnavailableReason } from './agentMode/modelUnavailable';

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

/**
 * ENG-1552: one Alert Class for every "scheduled report withheld" occurrence, so intake
 * clusters them onto a single canonical Linear defect instead of one issue per schedule/day.
 */
export const WITHHELD_REPORT_ALERT_CLASS = 'scheduled-report-withheld-no-recipients';

export type EmailSendOutcome = 'sent' | 'suppressed' | 'failed';

/**
 * What sendScheduledRunFailedEmail reports. The first three classes are a schedule that keeps producing nothing after
 * every automatic retry (ENG-826); `model_unavailable` (ENG-669 PR-D) is a run refused before it started because the
 * schedule's saved model is outside the owner's plan or no longer available. `modelLabel` is already sanitized.
 */
export type ScheduledRunFailureNotice =
  | { failedAttempts: number; failureClass: 'budget' | 'transient' | 'system' }
  | {
      failureClass: 'model_unavailable'; modelLabel: string; reason: ModelUnavailableReason;
      /** ENG-669 PR-C: the saved model is the AgentWeb Model and the router is unavailable right now (not "gone"). */
      routerUnavailable?: boolean;
      /** The plans that include the model (the refusal's `upgradeRequired`); empty = none, so no upgrade is offered. */
      upgradeRequired?: string[];
    };

const EMPTY_RUN_DIGEST_PLACEHOLDER = '(This run produced no report content.)';

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

  /**
   * Best-effort send — never throws. Resolves to what actually happened so a caller
   * that records delivery (ENG-1552) can tell a real send from a swallowed failure or
   * a non-prod suppression. `void` only ever comes from a test stub; treat it as unknown.
   */
  async sendEmail(to: string | string[], subject: string, text: string, html: string, cc?: string | string[], headers?: Record<string, string>): Promise<EmailSendOutcome | void> {
    try {
      const result = await resendService.sendEmail({
        from: SYSTEM_FROM,
        to,
        cc,
        subject,
        text,
        html,
        replyTo: SUPPORT_REPLY_TO,
        ...(headers ? { headers } : {})
      });
      const toList = Array.isArray(to) ? to.join(', ') : to;
      const ccList = cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : '';
      // Never claim delivery for a send the non-prod guard blocked — the log is
      // the only record this best-effort path leaves behind.
      if (isSuppressedSendResult(result)) {
        console.log('Email suppressed by the non-prod guard, not sent to:', toList, cc ? `CC: ${ccList}` : '');
        return 'suppressed';
      }
      console.log('Email sent successfully to:', toList, cc ? `CC: ${ccList}` : '');
      return 'sent';
    } catch (error) {
      console.error('Error sending email:', error);
      // Don't throw - best-effort by design. Callers that need delivery
      // guarantees use sendEmailStrict.
      return 'failed';
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

    // A suppressed send did not leave the box, so it cannot satisfy this
    // method's contract — its whole purpose is that the caller's audit row
    // reflects ground truth. Checked BEFORE the messageId check, because the
    // guard deliberately supplies a string id (so it is not misread as a
    // provider failure) and that id would otherwise be recorded as a delivery.
    if (isSuppressedSendResult(result)) {
      throw new Error(
        'sendEmailStrict: send suppressed by the non-prod email guard — ' +
          'no message left the box. Add the recipient to NONPROD_EMAIL_ALLOWLIST, ' +
          'or set NONPROD_EMAIL_ALLOW_ALL=true for a deliberate delivery test.',
      );
    }
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
      cc: ['founders@agentweb.pro', 'francisco@agentweb.pro'],
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

  /**
   * ENG-2991: double opt-in. Sent when someone asks (through the public join form) to receive a task's updates; nobody is subscribed until
   * the link is opened, so a stranger cannot make AgentWeb email an address on a task owner's behalf by typing it into a form.
   */
  async sendSubscriberConfirmationEmail(email: string, taskId: string, confirmUrl: string) {
    try {
      const { taskDb, userDb } = require('../services/db');
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const task = await taskDb.getTaskById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const user = await userDb.getUserById(task.userId);
      if (!user) throw new Error(`User not found: ${task.userId}`);
      const taskName = task.name || 'this task';
      // The task name is chosen by the task's owner and this goes to an address the owner does not control: keep the subject short and on one line.
      const subjectName = String(taskName).replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'this task';

      let emailSender = task.emailSender;
      let fromName = task.fromName;
      if (!emailSender || !fromName) {
        if (user.emailDomain && user.defaultSenderUsername && user.fromName) {
          emailSender = `${user.defaultSenderUsername}@${user.emailDomain}`;
          fromName = user.fromName;
        }
      }
      const hasCustomSender = Boolean(emailSender && fromName);
      const from = hasCustomSender ? `${fromName} <${emailSender}>` : SYSTEM_FROM;
      // The owner's task name is shown only when the mail goes out from the owner's own sender. From the system address it would be text written
      // by an account owner, sent to strangers under AgentWeb's name.
      const forTask = hasCustomSender;

      // Both bodies come from one function so the fallback below can be built without the task name by calling it again, not by editing text.
      const render = (withTaskName: boolean) => {
        const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1B2549; margin-top: 0;">Please confirm your subscription</h2>
            <p style="color: #333; line-height: 1.6;">
              Someone asked to receive email updates${withTaskName ? ` for <strong>${this.escapeHtml(subjectName)}</strong>` : ''} at this address. If that was you, confirm below.
            </p>
            <p style="margin: 24px 0;">
              <a href="${confirmUrl}" style="background: #3b82f6; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Confirm my subscription</a>
            </p>
            <p style="color: #666; line-height: 1.6; font-size: 0.9em;">
              If it wasn't you, ignore this email: you won't be subscribed and you won't receive anything else. The link expires in 48 hours.
            </p>
          </div>
        </div>
      `;
        const text = `Please confirm your subscription

Someone asked to receive email updates${withTaskName ? ` for ${subjectName}` : ''} at this address. If that was you, confirm here:
${confirmUrl}

If it wasn't you, ignore this email: you won't be subscribed and you won't receive anything else. The link expires in 48 hours.`;
        return { html, text };
      };

      let result;
      try {
        result = await resendService.sendEmail({
          from,
          to: email,
          // From the owner's own sender the task name is part of the subject; from the system address the subject is fixed, so a task name written
          // by an account owner is not sent to strangers under AgentWeb's name.
          subject: hasCustomSender ? `Confirm your subscription to ${subjectName}` : 'Please confirm your subscription',
          ...render(forTask),
          ...(hasCustomSender ? {} : { replyTo: SUPPORT_REPLY_TO })
        });
      } catch (customSenderError: any) {
        if (!hasCustomSender) throw customSenderError;
        // The owner's own sender was refused (an unverified domain, a revoked key): the form tells the person to check their email, so send
        // the plain system confirmation instead of losing the sign-up. It names no task, as for any task without a sender of its own.
        console.error('Subscriber confirmation from the task sender failed, using the system address:', customSenderError?.statusCode || customSenderError?.name || 'error');
        result = await resendService.sendEmail({
          from: SYSTEM_FROM,
          to: email,
          subject: 'Please confirm your subscription',
          ...render(false),
          replyTo: SUPPORT_REPLY_TO
        });
      }
      console.log('Subscriber confirmation email sent', result?.id ? `(ID: ${result.id})` : '');
      return true;
    } catch (error: any) {
      // The recipient is not logged: an error object from the mail service can carry it.
      console.error('Error sending subscriber confirmation email:', error?.statusCode || error?.name || 'error');
      return false;
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
  //
  // ENG-669 PR-D: `model_unavailable` is a different failure with its own copy: the run never started because the
  // schedule's saved model is outside the owner's plan (or no longer available). It is the owner's to fix, so the
  // "keeps failing / contact support" wording above would be wrong; it says which model and how to fix it instead.
  async sendScheduledRunFailedEmail(
    toEmails: string | string[],
    scheduleName: string,
    scheduleId: string,
    opts: ScheduledRunFailureNotice
  ) {
    if (opts.failureClass === 'model_unavailable') {
      await this.sendModelUnavailableNoticeEmail(
        toEmails,
        buildScheduleModelNotice({
          scheduleName, modelLabel: opts.modelLabel, reason: opts.reason, routerUnavailable: opts.routerUnavailable, upgradeRequired: opts.upgradeRequired,
        }),
        `schedule ${scheduleId}`,
      );
      return;
    }
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

  /**
   * ENG-669 PR-D: tell the owner an unattended session's work plan paused because a step's model is outside their
   * plan (or no longer available). Sent once per session and step (see pauseWorkPlanForUnavailableStepModel).
   * Best-effort: never throws.
   */
  async sendWorkPlanStepModelUnavailableEmail(
    toEmails: string | string[],
    opts: {
      sessionId: string;
      stepCount: number;
      modelLabel: string;
      reason: ModelUnavailableReason;
      /** ENG-669 PR-C: the step is on the AgentWeb Model and its router is unavailable right now. */
      routerUnavailable?: boolean;
      scheduleName?: string | null;
      sessionTitle?: string | null;
      /** The plans that include the model (the refusal's `upgradeRequired`); empty = none, so no upgrade is offered. */
      upgradeRequired?: string[];
    },
  ) {
    await this.sendModelUnavailableNoticeEmail(toEmails, buildWorkPlanStepModelNotice(opts), `session ${opts.sessionId}`);
  },

  /** Renders and sends one unattendedModelNoticeCopy notice. Every string in it is plain text and escaped here. */
  async sendModelUnavailableNoticeEmail(toEmails: string | string[], notice: ModelNoticeCopy, logContext: string) {
    const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const [primary, ...secondary] = notice.actions;
      const linkHtml = (path: string) => this.escapeHtml(`${customerFrontendUrl}${path}`);
      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #ffc107; color: #664d03; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .info-section { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>⚠️ ${this.escapeHtml(notice.headline)}</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${this.escapeHtml(notice.subheading)}</p>
            </div>
            <div class="content">
              <div class="info-section">
                ${notice.paragraphs.map((p, i) => `<p style="margin: ${i === 0 ? '0' : '10px 0 0 0'}; line-height: 1.6;">${this.escapeHtml(p)}</p>`).join('\n                ')}
              </div>
            </div>
            <div class="footer">
              ${primary ? `<a class="button" href="${linkHtml(primary.path)}">${this.escapeHtml(primary.label)}</a>` : ''}
              ${secondary.map((a) => `<p style="margin: 10px 0 0 0;"><a href="${linkHtml(a.path)}">${this.escapeHtml(a.label)}</a></p>`).join('')}
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">${this.escapeHtml(notice.footer)}</p>
            </div>
          </div>
        </body>
        </html>
      `;
      const text = `${notice.headline}: ${notice.subheading}

${notice.paragraphs.join('\n\n')}

---
${notice.actions.map((a) => `${a.label}: ${customerFrontendUrl}${a.path}`).join('\n')}`;
      await this.sendEmail(emailList, notice.subject, text, html);
      console.log(`Model-unavailable notice sent to recipients: ${emailList.join(', ')} (${logContext})`);
    } catch (error) {
      console.error(`Error sending model-unavailable notice to ${emailList.join(', ')} (${logContext}):`, error);
      // Don't throw — a notification failure must not break the run.
    }
  },

  /**
   * Tell an owner their LinkedIn (Unipile) session died and only they can revive it
   * (ENG-1197).
   *
   * Deliberately names what is blocked rather than just "reconnect": the failure is
   * invisible from the product's surface, because discovery keeps working off a
   * shared account (ENG-1198) while every send, withdraw and even the read of the
   * pending queue is dead. An owner told only "reconnect your account" has no way to
   * tell whether that mattered.
   */
  async sendLinkedInAccountDisconnectedEmail(
    toEmails: string | string[],
    opts: {
      accountName: string;
      /**
       * When we DETECTED the dead session — not when LinkedIn ended it, which we have
       * no way to know. On a first-ever detection this is stamped "now", so for an
       * account that has been dead for weeks it is the moment we noticed and nothing
       * more. The copy says exactly that. Omit it entirely when even that is unknown;
       * the sentence drops rather than inventing a time.
       */
      disconnectedAt?: string;
      isReminder: boolean;
      daysDisconnected: number;
      /**
       * Set when a schedule was paused after repeated skips. Changes the remedy:
       * reconnecting is no longer sufficient on its own, because a paused schedule
       * does not resume by itself — which is the opposite of what the ordinary skip
       * copy promises, and the reason this cannot reuse the generic run-failed email.
       */
      pausedScheduleName?: string;
      /**
       * How many scheduled RUNS were skipped before the pause — a different unit from
       * `daysDisconnected`, and the one the pause copy actually means. Conflating them
       * mis-stated the elapsed time by whatever the schedule's cadence happened to be.
       */
      skippedRunCount?: number;
    }
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const safeName = this.escapeHtml(opts.accountName);
      // Rendered in UTC and labelled as such. Without an explicit `timeZone` this took
      // the SERVER's zone — meaningless to a customer base spread across the world, and
      // actively misleading once labelled, since the label would name our zone as
      // though it were theirs. UTC is the one zone that is unambiguous to everyone.
      const whenParsed = opts.disconnectedAt ? new Date(opts.disconnectedAt) : null;
      const when = whenParsed && !Number.isNaN(whenParsed.getTime())
        ? whenParsed.toLocaleString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            timeZone: 'UTC', timeZoneName: 'short',
          })
        : null;
      const safeSchedule = opts.pausedScheduleName ? this.escapeHtml(opts.pausedScheduleName) : '';
      const headline = opts.pausedScheduleName
        ? 'A schedule was paused — LinkedIn Outreach still disconnected'
        : opts.isReminder
          ? `Still disconnected ${opts.daysDisconnected} day${opts.daysDisconnected === 1 ? '' : 's'} after we detected it`
          : 'Your LinkedIn Outreach account disconnected';
      // /settings/:tab — the tab slug is `accounts` (labelled "Connected Accounts"
      // in the sidebar). `/settings/connected-accounts` is not a real tab, so it
      // would have sent every recipient of this alert to a dead page. Canonical
      // source: customer-portal src/config/portalRoutes.ts.
      const settingsUrl = `${customerFrontendUrl}/settings/accounts`;
      // A paused schedule needs BOTH actions, and saying only "reconnect" would
      // leave it stopped indefinitely.
      // NOT `?? opts.daysDisconnected`: that fallback re-created the units bug it was
      // added to remove, silently, for any caller that sets `pausedScheduleName`
      // without a run count.
      const skippedRuns = opts.skippedRunCount;
      const pausedAfter = typeof skippedRuns === 'number'
        ? ` after ${skippedRuns} skipped run${skippedRuns === 1 ? '' : 's'}`
        : '';
      const resumeHtml = opts.pausedScheduleName
        ? `<p style="line-height: 1.6;"><strong>"${safeSchedule}"</strong>
             has been paused${pausedAfter}.
             Reconnecting is not enough on its own — once the account is back, switch the schedule
             back on from your schedules page.</p>`
        : `<p style="line-height: 1.6;">
             Any scheduled outreach that needs this account is being skipped rather than run, so nothing is
             being sent from a broken session. It resumes on its own once you reconnect &mdash; there is
             nothing to switch back on.</p>`;

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
              <h1>🔌 ${headline}</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${safeName}</p>
            </div>
            <div class="content">
              <div class="error-section">
                <h3>LinkedIn Outreach is paused until you reconnect</h3>
                <p style="margin: 0; line-height: 1.6;">
                  LinkedIn has ended the session for <strong>${safeName}</strong>${when ? ` &mdash; we detected this on <strong>${when}</strong>` : ''}.
                  Reconnecting takes about a minute and only you can do it &mdash; it needs your LinkedIn login.
                </p>
              </div>
              <p style="line-height: 1.6;"><strong>What has stopped:</strong></p>
              <ul style="line-height: 1.6;">
                <li>Sending connection invitations and messages</li>
                <li>Withdrawing old pending invitations</li>
                <li>Reading how many invitations are still pending</li>
              </ul>
              ${resumeHtml}
            </div>
            <div class="footer">
              <a class="button" href="${settingsUrl}">Reconnect LinkedIn Outreach</a>
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">
                If reconnecting does not work, remove the connection and add it again as a new connection.
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `${headline}: ${opts.accountName}

LinkedIn has ended the session for "${opts.accountName}"${when ? ` - we detected this on ${when}` : ''}. Reconnecting takes about a minute and only you can do it - it needs your LinkedIn login.

What has stopped:
- Sending connection invitations and messages
- Withdrawing old pending invitations
- Reading how many invitations are still pending

${opts.pausedScheduleName
  ? `"${opts.pausedScheduleName}" has been paused${pausedAfter}. Reconnecting is not enough on its own - once the account is back, switch the schedule back on from your schedules page.`
  : 'Any scheduled outreach that needs this account is being skipped rather than run, so nothing is being sent from a broken session. It resumes on its own once you reconnect.'}

---
Reconnect LinkedIn Outreach: ${settingsUrl}
If reconnecting does not work, remove the connection and add it again as a new connection.`;

      const subject = opts.pausedScheduleName
        ? `⏸️ Schedule paused: "${opts.pausedScheduleName}" needs ${opts.accountName} reconnected`
        : opts.isReminder
          ? `🔌 Still disconnected: ${opts.accountName} (LinkedIn Outreach paused)`
          : `🔌 Reconnect needed: ${opts.accountName} (LinkedIn Outreach paused)`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`LinkedIn disconnect email sent to: ${emailList.join(', ')} (reminder=${opts.isReminder})`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending LinkedIn disconnect email to ${emailList.join(', ')}:`, error);
      // Don't throw — a notification failure must not break the sync cron.
    }
  },

  /**
   * ENG-1131 follow-up: tell the schedule owner the MOMENT their prospecting
   * schedule's LinkedIn sourcing capability changes state, rather than only
   * reporting it passively via the schedule-card badge / per-run emails the
   * next time they happen to check. Called on the EDGE (see
   * didSourcingBlockStateChange in agentModeController.ts) — once when a run
   * first comes back blocked, once when a later run recovers — never on every
   * run of a multi-day outage.
   */
  async sendScheduleSourcingBlockTransitionEmail(
    toEmails: string | string[],
    scheduleName: string,
    scheduleId: string,
    isNowBlocked: boolean,
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const safeName = this.escapeHtml(scheduleName);
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });

      const headline = isNowBlocked
        ? 'LinkedIn search is currently unavailable for this schedule'
        : 'LinkedIn search is working again for this schedule';
      const bodyHtml = isNowBlocked
        ? `Your scheduled prospecting chat <strong>"${safeName}"</strong> could not source any prospects on its most recent ` +
          `run (${currentDate}) because LinkedIn people search is currently unavailable for the connected account. ` +
          `This is <strong>not</strong> "nobody matched your filters" — the outage is upstream at LinkedIn/Unipile and is ` +
          `account-scoped: your account is not broken and reconnecting will not help. No action is needed on your end; ` +
          `we'll email you again once search is back and this schedule resumes sourcing normally.`
        : `Good news — LinkedIn people search is working again for the account connected to <strong>"${safeName}"</strong>, ` +
          `and its most recent run (${currentDate}) sourced prospects normally. No action was needed on your end.`;
      const bodyText = isNowBlocked
        ? `Your scheduled prospecting chat "${scheduleName}" could not source any prospects on its most recent run (${currentDate}) because LinkedIn people search is currently unavailable for the connected account. This is NOT "nobody matched your filters" — the outage is upstream at LinkedIn/Unipile and is account-scoped: your account is not broken and reconnecting will not help. No action is needed on your end; we'll email you again once search is back and this schedule resumes sourcing normally.`
        : `Good news — LinkedIn people search is working again for the account connected to "${scheduleName}", and its most recent run (${currentDate}) sourced prospects normally. No action was needed on your end.`;

      const headerColor = isNowBlocked ? '#ffc107' : '#28a745';
      const icon = isNowBlocked ? '⚠️' : '✅';

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: ${headerColor}; color: ${isNowBlocked ? '#664d03' : 'white'}; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .info-section { background-color: ${isNowBlocked ? '#fff3cd' : '#e8f5e8'}; border-left: 4px solid ${headerColor}; padding: 15px; margin: 20px 0; border-radius: 4px; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>${icon} ${headline}</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${safeName}</p>
            </div>
            <div class="content">
              <div class="info-section">
                <p style="margin: 0; line-height: 1.6;">${bodyHtml}</p>
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

      const text = `${headline}: ${scheduleName}

${bodyText}

---
Review your schedules: ${customerFrontendUrl}/agent-mode?tab=scheduled`;

      const subject = isNowBlocked
        ? `⚠️ LinkedIn search unavailable: ${scheduleName}`
        : `✅ LinkedIn search is back: ${scheduleName}`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`Sourcing-block transition email sent to recipients: ${emailList.join(', ')} (schedule ${scheduleId}, isNowBlocked=${isNowBlocked})`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending sourcing-block transition email to ${emailList.join(', ')}:`, error);
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
      // ENG-1116: which dimension actually gated. Without it a cost block over an
      // also-exceeded token counter would be worded in tokens, contradicting the
      // in-app message the same block produces.
      costEnforced?: boolean;
      // ENG-1344: the billing month (`YYYY-MM`), used to name the reset DATE.
      // Optional only because this type under-declared the `TokenUsageStatus` the
      // sole caller has always passed whole — every runtime call already carries it.
      month?: string;
      // ENG-668: set when the block is pay-as-you-go's own (cap reached / suspended / not covered).
      paygBlock?: UsageBlockPaygInput;
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
      // (ENG-200). Which dimension gated only picks which percentage to read — never
      // the wording: the raw figures and the "cost" vs "token" dimension name are
      // never surfaced to the customer, matching the in-app UsageMeter policy of a
      // percentage of "monthly usage" only (ENG-1566).
      const { blockedByCost } = deriveBlockedByCost(usageStatus);
      const limitPercent = Math.round(
        blockedByCost ? (usageStatus.costPercentUsed ?? 100) : (usageStatus.percentUsed ?? 100)
      );

      // ENG-668: a pay-as-you-go account is past its plan pool by design, so "N% of your monthly
      // allowance" is not what stopped it (and can read far above 100%). Name the PAYG reason instead,
      // in the same words as the 429.
      const paygCopy = usageStatus.paygBlock
        ? buildUsageBlockCopy({ month: usageStatus.month, paygBlock: usageStatus.paygBlock })
        : null;
      const limitLabel = paygCopy ? paygCopy.headline : 'Monthly Usage Limit Reached';
      // The PAYG reason is already the headline and the body; the cause just says usage is paused, and
      // the call to action is the reason's own (raise the limit / update or add a card / reactivate).
      const limitCause = paygCopy ? 'AI usage is paused' : 'you have reached your monthly usage limit';
      const continueAction = (paygCopy && paygBlockActionSentence(usageStatus.paygBlock))
        || 'To continue using scheduled chats, please upgrade your plan or wait for your allowance to reset.';
      const usageLine = paygCopy
        ? this.escapeHtml(paygCopy.body)
        : `<strong>Usage:</strong> ${limitPercent}% of your monthly allowance used.`;
      const usageLineText = paygCopy ? paygCopy.body : `Usage: ${limitPercent}% of your monthly allowance used.`;
      const allowanceResetNoun = 'usage allowance';
      // ENG-1344: "resets at the start of each billing period" is the exact
      // vagueness the escalating customer could not decode. Name the day when we
      // can derive it; keep the old sentence when we cannot, rather than guess.
      const resetIso = resetDateFromMonth(usageStatus.month);
      const resetLabel = formatResetDateLong(resetIso);
      const allowanceResetClause = resetLabel
        ? `Your ${allowanceResetNoun} resets on ${resetLabel}.`
        : `Your ${allowanceResetNoun} resets at the start of each billing period.`;

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
                  but it cannot execute because ${limitCause}.
                </p>
                <p style="margin: 10px 0 0 0; line-height: 1.6;">
                  ${usageLine}
                </p>
                <p style="margin: 10px 0 0 0; line-height: 1.6;">
                  ${allowanceResetClause} ${continueAction}
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

Your scheduled chat "${scheduleName}" was scheduled to run at ${currentDate}, but it cannot execute because ${limitCause}.

${usageLineText}

${allowanceResetClause} ${continueAction}

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
      // ENG-1131: set when the run "succeeded" (produced a report) but its only
      // sourcing path was blocked — e.g. the LinkedIn people-search outage. Left
      // separate from `passed` on purpose (see agentModeController.ts), so this
      // email must read it explicitly instead of trusting `passed` alone.
      blockedBy?: string;
      // ENG-1552: the run this email reports on, so its delivery state is recorded
      // against the right run. Callers that only have a session fall back to it.
      runId?: string;
    },
    scheduleId: string,
    summary?: string,
    // ENG-1552: false for a manual resend to an address the owner typed — that is not
    // the scheduled delivery, so it must not overwrite the run's recorded state.
    options?: { recordDelivery?: boolean }
  ) {
    const deliveryScheduleId = options?.recordDelivery === false ? undefined : scheduleId;
    // ENG-1552 (the xCures / ENG-1504 class): a run can finish with a real session and
    // no output at all. Sending that is an empty report that reads as delivered, so
    // withhold it and record why — before a share link is minted or anything is composed.
    if (!String(result.actualResponse ?? '').trim()) {
      if (deliveryEnforcementEnabled()) {
        await this.withholdEmptyScheduledReport(toEmails, result, deliveryScheduleId);
        return;
      }
      // Shadow mode: send exactly as before; the send is still recorded below.
      logShadowDecision('withheld an empty report', { scheduleId, runId: result.runId || result.sessionId });
    }
    try {
      const { marked } = await import('marked');
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      // CodeRabbit (PR #2383): escape before interpolating into the HTML body —
      // a schedule name containing markup otherwise renders unescaped in the
      // recipient's email client. sendScheduleSourcingBlockTransitionEmail
      // already does this; this brings the sibling function in line with it.
      const safeScheduleName = this.escapeHtml(scheduleName);

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

      // ENG-1131: a blocked-sourcing run reads neither as a plain success nor a
      // failure — `passed` stays `true` (the run itself completed; see
      // agentModeController.ts for why), but the card/email must not say
      // "successfully executed" when the reason it produced nothing was an
      // upstream outage, not a real empty result.
      //
      // ENG-1131 follow-up: a run can be BOTH blocked AND have failed to meet
      // its OTHER requirements — a schedule whose only sourcing path is search
      // can't satisfy requiredFunctionCalls when that path is down
      // (allRequirementsMet in agentModeController.ts depends on
      // allFunctionCallsMet). Failure must take icon/color precedence over the
      // blocked state: an owner must never read a run that failed as a
      // reassuring "outage, self-heals, nothing to worry about" notice with no
      // mention it also failed. The outage explanation is instead ALWAYS
      // appended as its own note when isBlockedRun, independent of pass/fail —
      // additive context, never a replacement for the failure signal.
      const isBlockedRun = result.blockedBy === LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON;
      const statusColor = !result.passed ? '#dc3545' : (isBlockedRun ? '#ffc107' : '#28a745');
      const statusIcon = !result.passed ? '❌' : (isBlockedRun ? '⚠️' : '✅');
      const statusBg = !result.passed ? '#ffeaea' : (isBlockedRun ? '#fff3cd' : '#e8f5e8');
      // Each of the 4 (passed x blocked) combinations gets its own headline —
      // NOT derived from `passed` alone, or the original "don't say
      // 'successfully executed' for a blocked run" fix (the whole point of
      // this email surfacing at all) regresses right back for the passed +
      // blocked case.
      const primaryMessage = !result.passed && isBlockedRun
        ? 'did not meet all criteria on this run. LinkedIn people search was also unavailable for the connected account during the run — see the note below.'
        : !result.passed
        ? 'executed but did not meet all criteria and results are ready.'
        : isBlockedRun
        ? 'ran, but LinkedIn people search was unavailable for the connected account, so no prospects could be sourced — see the note below.'
        : 'has been successfully executed and results are ready.';
      const outageNoteHtml = isBlockedRun
        ? 'LinkedIn people search was unavailable for the connected account on this run, so no prospects could be sourced — ' +
          'this is <strong>not</strong> "nobody matched your filters". The outage is upstream at LinkedIn/Unipile and is ' +
          'account-scoped: your account is not broken and reconnecting will not help. Sourcing resumes automatically ' +
          'once search returns for the account.'
        : '';
      const outageNoteText = isBlockedRun
        ? 'LinkedIn people search was unavailable for the connected account on this run, so no prospects could be sourced — ' +
          'this is NOT "nobody matched your filters". The outage is upstream at LinkedIn/Unipile and is account-scoped: ' +
          'your account is not broken and reconnecting will not help. Sourcing resumes automatically once search returns for the account.'
        : '';

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
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${safeScheduleName}</p>
            </div>

            <div class="content">
              <div class="section" style="background-color: ${statusBg}; border-left: 4px solid ${statusColor}; margin: 20px 0;">
                <p style="margin: 0; font-size: 16px; line-height: 1.5;">
                  Your scheduled chat <strong>"${safeScheduleName}"</strong> ${primaryMessage}
                  It ran for <strong>${Math.round(result.executionTime / 1000)} seconds</strong>
                  and completed at <strong>${currentDate}</strong>.
                </p>
              </div>

              ${isBlockedRun ? `
              <div class="section" style="background-color: #fff3cd; border-left: 4px solid #ffc107; margin: 20px 0;">
                <p style="margin: 0; font-size: 14px; line-height: 1.5;">${outageNoteHtml}</p>
              </div>
              ` : ''}

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

Your scheduled chat "${scheduleName}" ${primaryMessage}
It ran for ${Math.round(result.executionTime / 1000)} seconds and completed at ${currentDate}.
${isBlockedRun ? `
${outageNoteText}
` : ''}

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
      // address. No-op for ordinary reports. Fail-closed throughout; see
      // classifyAndResolveScheduledReportRecipients.
      const guard = await this.classifyAndResolveScheduledReportRecipients([result.sessionId], emailList);
      const recipients = guard.authorized;
      const notice = this.withheldRecipientsNotice(guard.withheld);
      const finalHtml = notice ? `${notice.html}${html}` : html;
      const finalText = notice ? `${notice.text}\n\n${text}` : text;
      const runKey = result.runId || result.sessionId;

      if (recipients.length === 0) {
        // Fail-closed left no authorized recipient. Do NOT silently drop the
        // completed report: notify the schedule owner that delivery was blocked
        // (a status message ONLY — never the report data) so the report is not
        // lost without a signal and the owner can add an authorized recipient.
        console.error(`Scheduled report for session ${result.sessionId} had no authorized recipients after the guard; report NOT delivered.`);
        await recordReportDeliveryState(deliveryScheduleId, {
          runId: runKey,
          state: 'withheld',
          reason: 'no_authorized_recipients',
          authorizedRecipients: [],
          withheldRecipients: emailList,
          missingPermission: 'isAdmin',
        });
        await this.notifyScheduledReportWithheld({
          scheduleId,
          scheduleName,
          sessionId: result.sessionId,
          ownerEmail: guard.ownerEmail,
          ownerUserId: guard.ownerUserId,
          stage: 'after_generation',
          emailOwner: true,
        });
      } else {
        // Send ONE email to all authorized recipients
        await this.deliverScheduledReport(deliveryScheduleId, runKey, recipients, guard.withheld, subject, finalText, finalHtml);
        console.log(`Scheduled chat result email sent to recipients: ${recipients.join(', ')}`);
      }

    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat result emails to ${emailList.join(', ')}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  },

  /**
   * The ENG-500 recipient guard for one report or a batch of runs (a daily digest).
   *
   * FAIL-CLOSED DEFAULT: each session is treated as sensitive UNLESS it can be
   * positively verified ordinary — a present session AND a clean strongly-consistent
   * tool-call record. A missing session, an unreadable record, or any error restricts
   * distribution rather than broadcasting. A batch is sensitive if ANY of its runs is:
   * a combined digest cannot redact one run's content, so it takes the safer policy.
   * Callers pass only the sessions whose content is actually in the email. Never
   * throws: if the guard itself fails, nobody is authorized.
   */
  async classifyAndResolveScheduledReportRecipients(
    sessionIds: string[],
    recipients: string[],
  ): Promise<{ authorized: string[]; withheld: string[]; ownerEmail?: string; ownerUserId?: string }> {
    let ownerEmail: string | undefined;
    let ownerUserId: string | undefined;
    try {
      let isSensitive = false;
      // ENG-2785: owner admin status scopes classification — the Meta Ads tools
      // only read cross-account data for admin callers. undefined = unknown →
      // full (safe) classification.
      let ownerIsAdmin: boolean | undefined;
      let ownerResolved = false;
      const resolveOwner = async () => {
        if (ownerResolved || !ownerUserId) return;
        ownerResolved = true;
        try {
          const owner: any = await userDb.getUserById(ownerUserId);
          ownerEmail = owner?.email;
          if (typeof owner?.isAdmin === 'boolean') ownerIsAdmin = owner.isAdmin; // legacy records without isAdmin stay unknown → full classification
        } catch { /* owner unknown → full classification; resolver restricts to verified admins */ }
      };
      for (const sessionId of sessionIds) {
        let sessionSensitive = true;
        try {
          const session: any = await chatbotDb.getChatSession(sessionId);
          if (session) {
            ownerUserId = ownerUserId || session.userId;
            await resolveOwner();
            if (!reportContainsCrossAccountData(session.calledFunctions, { ownerIsAdmin })) {
              // calledFunctions is a best-effort counter (its write errors are
              // swallowed at the call site), so a successful cross-account tool
              // call can be missing from it. Confirm against the authoritative
              // tool-call message records. Use a STRONGLY CONSISTENT read: this
              // send fires immediately after the run wrote these messages, so an
              // eventually-consistent read could miss a just-written call.
              const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId, true);
              sessionSensitive = messagesReferenceCrossAccountTool(messages as any, { ownerIsAdmin });
            }
          }
          // session falsy → cannot verify → sessionSensitive stays true (closed).
        } catch (classifyError) {
          console.error(`Scheduled report guard: could not classify session ${sessionId}; failing closed (treating as sensitive):`, classifyError);
          sessionSensitive = true;
        }
        isSensitive = isSensitive || sessionSensitive;
      }
      // Resolve the owner up front — used both to authorize the owner and to
      // notify them if delivery ends up blocked.
      await resolveOwner();
      const authz = await resolveAuthorizedReportRecipients({ recipients, ownerEmail, isSensitive });
      if (authz.withheld.length > 0) {
        console.warn(`Scheduled report guard: withheld ${authz.withheld.length} unauthorized recipient(s) for session(s) ${sessionIds.join(', ')}: ${authz.withheld.join(', ')}`);
      }
      return { authorized: authz.authorized, withheld: authz.withheld, ownerEmail, ownerUserId };
    } catch (guardError) {
      // Guard itself failed unexpectedly — fail-closed: withhold entirely rather
      // than risk distributing possibly-sensitive data to unverified addresses.
      // The caller's empty-recipients branch notifies the owner so it is not silent.
      console.error(`Scheduled report guard errored for session(s) ${sessionIds.join(', ')}; failing closed:`, guardError);
      return { authorized: [], withheld: [...recipients], ownerEmail, ownerUserId };
    }
  },

  /** The banner prepended to a report some configured recipients were withheld from. */
  withheldRecipientsNotice(withheld: string[]): { html: string; text: string } | null {
    if (withheld.length === 0) return null;
    const text = `⚠️ ${withheld.length} recipient(s) were withheld from this report because it contains cross-account account data and they are not authorized to receive it: ${withheld.join(', ')}. To share this data, ensure recipients are admin users.`;
    // Escape the notice before HTML interpolation: withheld addresses are
    // attacker-influenceable (a configured recipient can contain HTML
    // metacharacters), so raw insertion would inject markup into the notice.
    const html = `<div style="margin:0 0 16px 0;padding:12px 16px;background-color:#fff3cd;border:1px solid #ffe69c;border-radius:6px;color:#664d03;font-family:Arial,sans-serif;font-size:14px;">${this.escapeHtml(text)}</div>`;
    return { html, text };
  },

  /**
   * ENG-1552: send a scheduled report and record what actually happened — ONE write,
   * after the send (each append rewrites the whole schedule row, so it is kept to the
   * minimum). `delivered` only for a send the provider accepted; a swallowed failure or
   * a non-prod suppression is `delivery_attempted` with the reason.
   */
  async deliverScheduledReport(
    scheduleId: string | undefined,
    runId: string,
    recipients: string[],
    withheld: string[],
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    const base = {
      runId,
      authorizedRecipients: recipients,
      ...(withheld.length > 0 ? { withheldRecipients: withheld } : {}),
    };
    const outcome = await this.sendEmail(recipients, subject, text, html);
    await recordReportDeliveryState(scheduleId, outcome === 'sent'
      ? { ...base, state: 'delivered' }
      : {
          ...base,
          state: 'delivery_attempted',
          ...(outcome === 'failed' ? { reason: 'provider_error' as const } : {}),
          ...(outcome === 'suppressed' ? { reason: 'suppressed_nonprod' as const } : {}),
        });
  },

  /**
   * ENG-1552: the empty-content half of sendScheduledChatResultEmail. Records the
   * withhold and sends nothing — the recipients used to get an empty report, and the
   * customer is deliberately sent nothing new during the review period. Never throws.
   */
  async withholdEmptyScheduledReport(
    toEmails: string | string[],
    result: { sessionId: string; runId?: string },
    scheduleId: string | undefined,
  ): Promise<void> {
    const emailList = (Array.isArray(toEmails) ? toEmails : [toEmails]).filter(Boolean);
    console.error(`Scheduled report for schedule ${scheduleId} (session ${result.sessionId || 'none'}) has no content; NOT sent to ${emailList.length} recipient(s).`);
    await recordReportDeliveryState(scheduleId, {
      runId: result.runId || result.sessionId,
      state: 'withheld',
      reason: 'empty_content',
      withheldRecipients: emailList,
    });
  },

  /**
   * A sensitive scheduled report has no authorized recipient, so nothing was
   * delivered. Oncall is always told (durably, deduped onto one canonical defect).
   * The schedule owner is emailed a status notice (never report data) only when
   * `emailOwner` is set — the pre-ENG-1552 single-report path, which already did so.
   * The paths ENG-1552 added (preflight, digest) deliberately send the customer
   * nothing new: reports are in an internal review period (2026-09-18), and the
   * outcome is recorded in the schedule's deliveryLog instead. Never throws.
   *
   * ENG-1552 / ENG-1825: the oncall alert used to carry no context, so intake could
   * only fuzzy-match on a per-schedule title and re-filed a fresh Linear issue per
   * schedule per day. The Alert Class folds every occurrence, across all schedules,
   * onto one canonical defect (each occurrence comment still names its Schedule ID);
   * the dedupeKey keeps a daily schedule from re-emailing oncall inside 24h.
   * `sessionId` goes only into context, never the helper's own sessionId param: that
   * would mint a no-login share link to a report withheld because it holds
   * cross-account data.
   */
  async notifyScheduledReportWithheld(params: {
    scheduleId: string;
    scheduleName: string;
    sessionId?: string;
    ownerEmail?: string;
    ownerUserId?: string;
    stage: 'before_generation' | 'after_generation';
    emailOwner?: boolean;
  }): Promise<void> {
    const { scheduleId, scheduleName, sessionId, ownerEmail, ownerUserId, stage, emailOwner } = params;
    const what = stage === 'before_generation'
      ? `Schedule ${scheduleId} was not run: it produces a report containing cross-account account data, and none of its configured recipients (or the schedule owner) are currently authorized (admin) to receive it, so generation was skipped.`
      : `Session ${sessionId} produced a report containing cross-account account data, but none of its configured recipients (or the schedule owner) are authorized (admin) to receive it, so it was not delivered.`;
    try {
      const { sendAgentModeOncallAlert } = await import('../utils/agentModeAlerts');
      await sendAgentModeOncallAlert({
        subject: `Scheduled report withheld — no authorized recipients: ${scheduleName}`,
        message: `${what} Owner: ${ownerEmail || 'unknown'}. Add an authorized recipient or adjust the report.`,
        userId: ownerUserId,
        context: {
          'Session ID': sessionId || 'N/A',
          'Schedule ID': scheduleId,
          'Alert Class': WITHHELD_REPORT_ALERT_CLASS,
        },
        dedupeKey: `withheld-recipients:${scheduleId}`,
        dedupeWindowMs: 24 * 60 * 60 * 1000,
      });
    } catch (alertError) {
      console.error(`Failed to send oncall alert for withheld report on schedule ${scheduleId}:`, alertError);
    }
    if (!emailOwner || !ownerEmail) return;
    try {
      const blockedSubject = `⚠️ Scheduled report not delivered: ${scheduleName}`;
      const blockedText = `Your scheduled report "${scheduleName}" was not delivered because it contains cross-account account data and none of its configured recipients are authorized (admin) to receive it. Add an admin recipient (or adjust the report) and re-run.`;
      const blockedHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#664d03;padding:12px 16px;background-color:#fff3cd;border:1px solid #ffe69c;border-radius:6px;">${this.escapeHtml(blockedText)}</div>`;
      await this.sendEmail([ownerEmail], blockedSubject, blockedText, blockedHtml);
      console.log(`Scheduled report delivery-blocked notice sent to owner ${ownerEmail} for schedule ${scheduleId}`);
    } catch (notifyError) {
      console.error(`Failed to send delivery-blocked notice for schedule ${scheduleId}:`, notifyError);
    }
  },

  async sendSessionNotificationEmail(
    toEmails: string | string[],
    sessionId: string,
    content: string,
    subject?: string
  ) {
    const emailListForClaim = Array.isArray(toEmails) ? toEmails : [toEmails];
    // ENG-1297: a scheduled run's automated completion nudge can re-invoke this after
    // the notification for THIS session + recipient set has already gone out (the
    // nudge fires because an unrelated requirement is still unmet, not because the
    // notification failed) — the observed production outcome was a duplicate report
    // email. Claim atomically BEFORE sending so a repeat call for the same session
    // and recipients is a no-op instead of a second send.
    //
    // Deliberately NOT content-aware (a prior version of this guard hashed
    // subject+content into the claim member so a genuinely different notification
    // to the same recipients wouldn't be permanently suppressed). Re-derived
    // against the actual production incident this ticket reports (session
    // 0050a0b4-…): the scheduler's nudge caused the SAME run to re-run its
    // research, regenerate an "updated" report, and re-notify the same recipient
    // — different content both times (9588 vs 11359 chars, a restructured report).
    // A content hash produces a different signature for each call and does NOT
    // suppress that duplicate, so it does not fix the bug it was added for.
    // Recipient+session is coarser — a genuinely distinct second notification to
    // the same recipients later in the same session is also suppressed — but that
    // trade is the one that actually stops the proven regression.
    //
    // NOT superseded by the read-only press circuit breaker
    // (readOnlyPressCircuitBreaker.ts): that breaker still allows exactly ONE
    // nudge per the ticket's own recommendation ("cap nudges, suggest 1"), and in
    // the real incident the duplicate send happened on the response to that
    // FIRST, still-permitted nudge — the model complied immediately, so the
    // breaker's budget was never exhausted before the second notify_session call
    // went out. The breaker only caps the COST of a run that keeps refusing (the
    // sibling session in this ticket, d1f7942d-…); this guard is what actually
    // stops the duplicate SEND when a run complies instead.
    // JSON.stringify (not a bare comma-join) keeps the recipient signature
    // collision-safe against an embedded comma in a single recipient entry.
    // De-duplicated via Set before sorting (CodeRabbit): sort() alone does not
    // collapse repeats, so a call listing the same address twice would claim a
    // different signature than a later, legitimate call listing it once —
    // letting that second call slip past the guard as if it were a distinct
    // recipient set.
    const claimMember = JSON.stringify(
      [...new Set(emailListForClaim.map(e => e.trim().toLowerCase()))].sort()
    );
    const notifyClaimKey = `notify-session:${sessionId}`;
    const claimed = await settingsService.claimSetMember(notifyClaimKey, claimMember);
    if (!claimed) {
      console.log(`Session notification to ${emailListForClaim.join(', ')} for session ${sessionId} was already sent — skipping duplicate.`);
      return { sent: false, duplicate: true };
    }

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
      return { sent: true, duplicate: false };
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending session notification email to ${emailList.join(', ')}:`, error);
      // The primary action failed, so release the claim — a retry (nudge-driven or
      // otherwise) must be allowed to actually send, not get silently swallowed as
      // "already sent" for a notification that never went out.
      try {
        await settingsService.releaseSetMember(notifyClaimKey, claimMember);
      } catch (releaseError) {
        console.error(`Failed to release notify-session claim for session ${sessionId}:`, releaseError);
      }
      throw error; // Let the tool surface the error to the agent
    }
  },

  async sendDailyDigestEmail(
    toEmails: string | string[],
    scheduleName: string,
    todaysResults: any[],
    scheduleId: string,
    customDate?: Date,
    // ENG-1552: false for a manual resend — see sendScheduledChatResultEmail.
    options?: { recordDelivery?: boolean }
  ) {
    const deliveryScheduleId = options?.recordDelivery === false ? undefined : scheduleId;
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
      // ENG-1552: a run with no content is shown as such, not as a blank preview
      // (a missing actualResponse also used to throw on `.length` below). Customer-
      // visible, so enforcement-only like everything else ENG-1552 changes.
      if (deliveryEnforcementEnabled()) {
        todaysResults = todaysResults.map((r) =>
          r && !(typeof r.actualResponse === 'string' && r.actualResponse.trim())
            ? { ...r, actualResponse: EMPTY_RUN_DIGEST_PLACEHOLDER }
            : r
        );
      }

      const displayDate = customDate || new Date();
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      const digestRunKey = `digest-${displayDate.toISOString().slice(0, 10)}`;

      // ENG-1552: the same ENG-500 recipient guard as a single report. This path
      // used to send every run's content to every configured address unchecked.
      // Runs without a session carry only system text, so only sessions count.
      const digestSessionIds = [...new Set(todaysResults.map((r) => r?.sessionId).filter(Boolean))] as string[];
      const enforced = deliveryEnforcementEnabled();
      const classified = await this.classifyAndResolveScheduledReportRecipients(digestSessionIds, emailList);
      if (!enforced && classified.withheld.length > 0) {
        logShadowDecision('restricted a digest', { scheduleId, withheldRecipients: classified.withheld });
      }
      // Shadow mode: every configured recipient gets the digest, exactly as before.
      const guard = enforced ? classified : { ...classified, authorized: emailList, withheld: [] as string[] };
      if (guard.authorized.length === 0) {
        console.error(`Daily digest for schedule ${scheduleId} had no authorized recipients after the guard; digest NOT delivered.`);
        await recordReportDeliveryState(deliveryScheduleId, {
          runId: digestRunKey,
          state: 'withheld',
          reason: 'no_authorized_recipients',
          authorizedRecipients: [],
          withheldRecipients: emailList,
          missingPermission: 'isAdmin',
        });
        await this.notifyScheduledReportWithheld({
          scheduleId,
          scheduleName,
          sessionId: digestSessionIds[0],
          ownerEmail: guard.ownerEmail,
          ownerUserId: guard.ownerUserId,
          stage: 'after_generation',
        });
        return;
      }
      const digestNotice = this.withheldRecipientsNotice(guard.withheld);
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
        // ENG-1131: a blocked-sourcing run (LinkedIn search outage) still has
        // `passed: true` — see agentModeController.ts — so it must be read off
        // `blockedBy` explicitly rather than rendered as a plain PASSED run.
        //
        // ENG-1131 follow-up: a run can be BOTH blocked AND failed to meet its
        // other requirements (a schedule whose only sourcing path is search
        // can't satisfy requiredFunctionCalls when that path is down). FAILED
        // must take badge precedence over BLOCKED — the outage note below is
        // always shown when isBlockedRun regardless of pass/fail, so no
        // information is lost either way.
        const isBlockedRun = result.blockedBy === LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON;
        const statusIcon = !result.passed ? '❌' : (isBlockedRun ? '⚠️' : '✅');
        const statusLabel = !result.passed ? 'FAILED' : (isBlockedRun ? 'BLOCKED' : 'PASSED');
        const statusColor = !result.passed ? '#dc3545' : (isBlockedRun ? '#ffc107' : '#28a745');
        const statusTextColor = !result.passed ? 'white' : (isBlockedRun ? '#664d03' : 'white');
        const itemBg = !result.passed ? '#fff8f8' : (isBlockedRun ? '#fffbea' : '#f8fff8');
        const runTime = new Date(result.createdAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit'
        });
        const sessionUrl = result.sessionId ? sessionUrls[result.sessionId] : '#';

        return `
          <div class="result-item" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin: 10px 0; background-color: ${itemBg};">
            <div class="result-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <div class="result-info">
                <span class="status-badge" style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background-color: ${statusColor}; color: ${statusTextColor};">
                  ${statusIcon} ${statusLabel}
                </span>
                <span style="margin-left: 15px; color: #6c757d; font-size: 14px;">Run ${index + 1} at ${runTime}</span>
              </div>
              <div class="result-stats" style="font-size: 12px; color: #6c757d; text-align: right; min-width: 120px;">
                <div style="margin-bottom: 2px;">${Math.round(result.executionTime / 1000)}s</div>
                <div>Attempt ${result.attempt || 1}</div>
              </div>
            </div>
            <div class="result-content">
              ${isBlockedRun ? `
                <div style="background-color: #fff3cd; border: 1px solid #ffe69c; color: #664d03; padding: 10px; border-radius: 4px; margin-bottom: 10px; font-size: 13px; line-height: 1.4;">
                  LinkedIn people search was unavailable for the connected account on this run, so no prospects were sourced —
                  this is <strong>not</strong> "nobody matched your filters". The outage is upstream at LinkedIn/Unipile and is
                  account-scoped: your account is not broken and reconnecting will not help. Sourcing resumes automatically
                  once search returns for the account.
                </div>
              ` : ''}
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
        const isBlockedRun = result.blockedBy === LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON;
        // FAILED takes precedence over BLOCKED — see the HTML branch above for why.
        const statusLabel = !result.passed ? 'FAILED' : (isBlockedRun ? 'BLOCKED' : 'PASSED');
        const runTime = new Date(result.createdAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit'
        });
        const sessionUrl = result.sessionId ? sessionUrls[result.sessionId] : 'N/A';
        return `
Run ${index + 1} at ${runTime} - ${statusLabel}${isBlockedRun ? '\nLinkedIn people search was unavailable for the connected account on this run, so no prospects were sourced — this is NOT "nobody matched your filters". The outage is upstream at LinkedIn/Unipile and is account-scoped: your account is not broken and reconnecting will not help. Sourcing resumes automatically once search returns for the account.' : ''}
Response: ${result.actualResponse.substring(0, 100)}${result.actualResponse.length > 100 ? '...' : ''}
View Conversation: ${sessionUrl}
`;
      }).join('\n')}

---
This is your daily digest for scheduled chat "${scheduleName}" for ${currentDate}.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `📊 Daily Digest: ${scheduleName} - ${currentDate} - ${totalRuns} runs (${Math.round((successfulRuns / totalRuns) * 100)}% success)`;

      // Send ONE email to all authorized recipients
      await this.deliverScheduledReport(
        deliveryScheduleId,
        digestRunKey,
        guard.authorized,
        guard.withheld,
        subject,
        digestNotice ? `${digestNotice.text}\n\n${text}` : text,
        digestNotice ? html.replace(/<body([^>]*)>/i, (m) => `${m}${digestNotice.html}`) : html,
      );

      console.log(`Daily digest email sent to recipients: ${guard.authorized.join(', ')}`);

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

  /**
   * ENG-668 PR-2: the billing owner's email when the month's pay-as-you-go overage invoice is created.
   * A percentage of the cap only — never dollars; the Stripe invoice it links to carries the amount.
   * Best-effort (`sendEmail` never throws): settlement does not depend on it.
   */
  async sendPaygOverageInvoiceEmail(input: {
    to: string;
    month: string;
    percentOfCap: number;
    invoiceUrl?: string | null;
    /** Stripe already collected the invoice when the email goes out (the paid wording). */
    paid?: boolean;
  }): Promise<EmailSendOutcome | void> {
    return this.sendPaygSettlementEmail(input.to, paygInvoiceCreatedEmailCopy(input), input.invoiceUrl, '#1976d2');
  },

  /** ENG-668 PR-2: the billing owner's email when the month's overage charge fails and PAYG is put on hold. */
  async sendPaygOveragePaymentFailedEmail(input: {
    to: string;
    month: string;
    invoiceUrl?: string | null;
  }): Promise<EmailSendOutcome | void> {
    return this.sendPaygSettlementEmail(input.to, paygPaymentFailedEmailCopy(input), input.invoiceUrl, '#dc3545');
  },

  /** ENG-668 PR-2: the owner's email when their bank holds the overage charge for confirmation (3-D Secure). */
  async sendPaygOveragePaymentActionRequiredEmail(input: {
    to: string;
    month: string;
    invoiceUrl?: string | null;
  }): Promise<EmailSendOutcome | void> {
    return this.sendPaygSettlementEmail(input.to, paygPaymentActionRequiredEmailCopy(input), input.invoiceUrl, '#1976d2');
  },

  /**
   * ENG-668 PR-2: the owner's email when a payment waiting for their confirmation (3-D Secure) was not
   * confirmed within the grace period and pay-as-you-go is put on hold. Sent once per month.
   */
  async sendPaygOveragePaymentUnconfirmedEmail(input: {
    to: string;
    month: string;
    invoiceUrl?: string | null;
  }): Promise<EmailSendOutcome | void> {
    return this.sendPaygSettlementEmail(input.to, paygPaymentUnconfirmedEmailCopy(input), input.invoiceUrl, '#dc3545');
  },

  /** Renders the copy from `utils/paygSettlementCopy.ts`; no wording lives here. */
  async sendPaygSettlementEmail(
    to: string,
    copy: PaygSettlementEmailCopy,
    invoiceUrl: string | null | undefined,
    accent: string,
  ): Promise<EmailSendOutcome | void> {
    const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    const settingsUrl = `${customerFrontendUrl}/settings`;
    const invoiceLink = invoiceUrl && /^https:\/\//.test(invoiceUrl) ? invoiceUrl : null;
    const paragraphsHtml = copy.paragraphs
      .map((p) => `<p style="margin: 0 0 12px 0; line-height: 1.6;">${this.escapeHtml(p)}</p>`)
      .join('');
    const html = `
      <html>
      <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa;">
        <div style="max-width: 640px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="background-color: ${accent}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0; font-size: 22px;">${this.escapeHtml(copy.headline)}</h1>
          </div>
          <div style="padding: 20px;">
            ${paragraphsHtml}
            ${invoiceLink && copy.invoiceLinkLabel
              ? `<p style="margin: 16px 0;"><a href="${this.escapeHtml(invoiceLink)}" style="display: inline-block; background-color: #1976d2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">${this.escapeHtml(copy.invoiceLinkLabel)}</a></p>`
              : ''}
            <p style="margin: 16px 0 0 0;"><a href="${this.escapeHtml(settingsUrl)}" style="color: #1976d2;">${this.escapeHtml(copy.settingsLinkLabel)}</a></p>
          </div>
        </div>
      </body>
      </html>
    `;
    const text = [
      copy.headline,
      '',
      ...copy.paragraphs,
      '',
      ...(invoiceLink && copy.invoiceLinkLabel ? [`${copy.invoiceLinkLabel}: ${invoiceLink}`] : []),
      `${copy.settingsLinkLabel}: ${settingsUrl}`,
    ].join('\n');
    return this.sendEmail(to, copy.subject, text, html);
  },

  /**
   * ENG-2743: email the oncall list (`oncall_emails` setting, or ONCALL_EMAIL_LIST) WITHOUT filing a tracked
   * issue. For low-urgency daily digests the owner asked to receive by email rather than as a Linear item.
   * Production only (elsewhere it is logged and skipped). Returns whether the email was handed to the sender;
   * never throws.
   */
  async sendOncallEmailOnly(subject: string, message: string): Promise<boolean> {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Suppressed oncall email: ${subject}`);
      return false;
    }
    try {
      const oncallEmails = await getAlertEmails('oncall_emails', ['ruiw@agentweb.pro']);
      if (oncallEmails.length === 0) return false;
      const html =
        `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">` +
        `<h2 style="margin-top: 0;">${this.escapeHtml(subject)}</h2>` +
        `<p style="white-space: pre-wrap; word-wrap: break-word;">${this.escapeHtml(message)}</p></div>`;
      // sendEmail never throws; only a real send counts as sent (a failed or suppressed one returns false).
      const outcome = await this.sendEmail(oncallEmails, `[PROD] ${subject}`, `${subject}\n\n${message}`, html);
      if (outcome !== 'sent') return false;
      console.log(`Oncall email sent to ${oncallEmails.length} recipient(s): ${subject}`);
      return true;
    } catch (error) {
      console.error('Error sending oncall email:', (error as Error)?.message);
      return false;
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

      // The tracked issue is the canonical record. Founders asked (2026-11-07) to stop the
      // redundant "Oncall Alert" emails (e.g. "Meta connection: … token expired"): they were
      // noise, not actionable. Email only when filing failed, so nothing is silently lost.
      if (resolvedTrackerUrl) {
        console.log(`Oncall alert tracked, email skipped: ${resolvedTrackerUrl}`);
        return;
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
