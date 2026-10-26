import axios from 'axios';
import { EMMA_EMAIL_ADDRESS, EMMA_EMAIL_FROM, TEMP_EMAIL_PREFIX, TEMP_EMAIL_DOMAIN } from '../config';
import { resendService, ReceivedEmailAuthentication } from './resendService';
import { chatbotDb } from './chatbotService';
import { generateSessionResponse, modelUnavailableBody } from '../controllers/agentModeController';
import { isModelUnavailableError } from './agentMode/modelUnavailable';
import { agentModeService } from './agentModeService';
import { userDb } from './db';
import { uploadFileToS3 } from '../utils/s3Utils';
import { cronJobRegistry } from '../utils/cronJobRegistry';

interface InboundEmailEvent {
  emailId: string;
  from: string;
  to: string[];
  subject: string;
}

const SESSION_ID_REGEX = /\[ref:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

export class EmmaEmailService {
  /**
   * Check if any of the to-addresses match Emma's email address.
   */
  isEmmaEmail(toAddresses: string[]): boolean {
    return toAddresses.some(
      (addr) => addr.toLowerCase() === EMMA_EMAIL_ADDRESS.toLowerCase()
    );
  }

  /**
   * Check if an email event involves Emma (either as sender or recipient).
   * Used to exclude Emma emails from CRM lead activity tracking and alerts.
   * Handles both bare addresses (emma@...) and formatted addresses (Emma <emma@...>).
   */
  isEmmaRelatedEvent(from: string, to: string | string[]): boolean {
    const emmaLower = EMMA_EMAIL_ADDRESS.toLowerCase();
    if (extractBareEmail(from) === emmaLower) return true;
    const toArray = Array.isArray(to) ? to : [to];
    if (toArray.some((addr) => extractBareEmail(addr) === emmaLower)) return true;
    // Also treat temp test emails as Emma-related so they don't get tracked in CRM
    const tempPrefix = `${TEMP_EMAIL_PREFIX}+`;
    return toArray.some((addr) => {
      const bare = extractBareEmail(addr).toLowerCase();
      return bare.startsWith(tempPrefix) && bare.endsWith(`@${TEMP_EMAIL_DOMAIN}`);
    });
  }

  /**
   * Extract a session ID from a [ref:uuid] tag in the subject line.
   */
  extractSessionId(subject: string): string | null {
    if (!subject) return null;
    const match = subject.match(SESSION_ID_REGEX);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Extract the meaningful message body from email content.
   * Strips HTML tags, quoted lines, signatures, and "On ... wrote:" blocks.
   */
  extractMessageBody(content: { html?: string; text?: string }): string {
    let body = '';

    if (content.html) {
      // Strip HTML tags to get plain text
      body = content.html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
    } else if (content.text) {
      body = content.text;
    } else {
      return '';
    }

    // Strip "On ... wrote:" blocks and everything after
    body = body.replace(/\n\s*On\s+.+wrote:\s*\n[\s\S]*/i, '');

    // Strip signature blocks (-- separator)
    body = body.replace(/\n-- \n[\s\S]*/m, '');

    // Strip quoted lines (> prefix)
    body = body
      .split('\n')
      .filter((line) => !line.startsWith('>'))
      .join('\n');

    return body.trim();
  }

  /**
   * ENG-2652: whether Resend's receiving server proved the From address genuine. The From header
   * is whatever the sender typed, and resolveUserId turns it into the account Emma acts for, so
   * an unproven From must never pick an account. Accepted: DMARC `pass` (SPF or DKIM aligned with
   * the From domain), or DKIM `pass` (Resend reports a signature from any domain other than the
   * From domain as `gray`, so `pass` is a From-aligned signature). SPF `pass` alone is not enough:
   * it covers the envelope sender, which need not be the From domain. Missing verdicts fail closed.
   */
  isSenderAuthenticated(authentication: ReceivedEmailAuthentication | null | undefined): boolean {
    return authentication?.dmarc === 'pass' || authentication?.dkim === 'pass';
  }

  /**
   * Look up a registered user by email. Returns null if not found. Callers must first establish
   * that the address is authenticated (isSenderAuthenticated): this trusts it as given.
   */
  async resolveUserId(senderEmail: string): Promise<string | null> {
    const user = await userDb.getUserByEmail(senderEmail);
    return user?.userId || null;
  }

  /**
   * Send a "start free trial" email to unregistered senders.
   */
  async sendUnregisteredUserReply(event: InboundEmailEvent): Promise<void> {
    const signupUrl = 'https://www.agentweb.pro/build';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p style="line-height: 1.6;">Hi there!</p>
  <p style="line-height: 1.6;">Thanks for reaching out to Emma. It looks like you don't have an AgentWeb account associated with <strong>${escapeHtml(event.from)}</strong> yet.</p>
  <p style="line-height: 1.6;">Start a free trial to get access to Emma and all of AgentWeb's features:</p>
  <p>
    <a href="${signupUrl}" style="display: inline-block; background: #4F46E5; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">Start Free Trial</a>
  </p>
  <p style="font-size: 12px; color: #999; margin-top: 24px;">Once you've signed up, simply email Emma again and she'll be ready to help!</p>
</body>
</html>`.trim();

    const text = `Hi there!\n\nThanks for reaching out to Emma. It looks like you don't have an AgentWeb account associated with ${event.from} yet.\n\nStart a free trial to get access to Emma and all of AgentWeb's features:\n${signupUrl}\n\nOnce you've signed up, simply email Emma again and she'll be ready to help!`;

    await resendService.sendEmail({
      from: EMMA_EMAIL_FROM,
      to: event.from,
      subject: `Re: ${event.subject || 'Your message to Emma'}`,
      html,
      text,
      inReplyTo: event.emailId,
    });

    console.log(`[EmmaEmail] Sent free trial invite to unregistered user ${event.from}`);
  }

  /**
   * Build the response email subject line with Re: prefix and [ref:sessionId] tag.
   */
  buildResponseSubject(originalSubject: string, sessionId: string): string {
    let subject = originalSubject || '';

    // Add Re: prefix if not present
    if (!/^Re:/i.test(subject)) {
      subject = `Re: ${subject}`;
    }

    // The tag names the session that answered, so the next reply continues it. An inbound tag
    // naming any other session (one that was not found, or belongs to another account — ENG-2652)
    // is replaced rather than echoed back into the thread.
    if (SESSION_ID_REGEX.test(subject)) {
      subject = subject.replace(SESSION_ID_REGEX, `[ref:${sessionId}]`);
    } else {
      subject = `${subject} [ref:${sessionId}]`;
    }

    return subject.trim();
  }

  /**
   * Build the HTML and plain-text response email body.
   */
  buildResponseEmail(
    emmaResponse: string,
    ishareUrl: string
  ): { html: string; text: string } {
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="line-height: 1.6;">${emmaResponse}</div>
  <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;" />
  <p style="font-size: 14px; color: #666;">
    <a href="${escapeHtml(ishareUrl)}" style="display: inline-block; background: #4F46E5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Continue in Browser</a>
  </p>
  <p style="font-size: 12px; color: #999;">You can reply to this email to continue the conversation, or click the button above to chat in your browser.</p>
</body>
</html>`.trim();

    const plainResponse = stripHtml(emmaResponse);
    const text = `${plainResponse}\n\n---\nContinue in browser: ${ishareUrl}\n\nYou can reply to this email to continue the conversation.`;

    return { html, text };
  }

  /**
   * Main orchestration: process an inbound email addressed to Emma.
   */
  async processInboundEmail(event: InboundEmailEvent): Promise<void> {
    console.log(`[EmmaEmail] Processing inbound email ${event.emailId} from ${event.from}`);

    // 1. Fetch email content
    const emailContent = await resendService.getReceivedEmailContent(event.emailId);
    if (!emailContent) {
      throw new Error(`[EmmaEmail] Failed to fetch email content for ${event.emailId}`);
    }

    // 2. Extract message body
    const messageBody = this.extractMessageBody(emailContent);

    // 3. Refuse a sender whose From address is not authenticated (ENG-2652). It decides which
    // account Emma acts for, so a forged From would otherwise run a turn inside — and email back —
    // another person's account. No reply: replying would mail the forged address.
    if (!this.isSenderAuthenticated(emailContent.authentication)) {
      console.warn(
        `[EmmaEmail] Ignoring inbound email ${event.emailId}: sender not authenticated ` +
        `(authentication=${JSON.stringify(emailContent.authentication ?? null)})`
      );
      return;
    }

    // 4. Extract session ID from subject
    const existingSessionId = this.extractSessionId(event.subject);

    // 5. Resolve user — reject unregistered senders
    const userId = await this.resolveUserId(event.from);
    if (!userId) {
      await this.sendUnregisteredUserReply(event);
      return;
    }

    // 6. Determine session: continue the referenced session only when the sender owns it,
    // otherwise start a new one. ENG-2652: a [ref:<id>] tag is just subject text, so it must not
    // let a sender run a turn in (and receive the iShare link of) another account's chat. Owner
    // only, admins included: email carries no delegate ("access account") context, and its sender
    // proof is weaker than a portal token, so it never unlocks a chat its sender does not own.
    // A foreign session is treated exactly like a missing one. Record-only read: a refused id
    // never loads the other account's transcript.
    let sessionId: string | undefined;
    if (existingSessionId) {
      const existingSession = await chatbotDb.getChatSessionRecord(existingSessionId, true);
      if (existingSession && existingSession.userId === userId) {
        sessionId = existingSessionId;
        console.log(`[EmmaEmail] Continuing existing session ${sessionId}`);
      } else {
        console.log(`[EmmaEmail] Session ${existingSessionId} not found for sender, creating new session`);
      }
    }

    const isNewConversation = !sessionId;
    if (!sessionId) {
      const newSession = await chatbotDb.createChatSession(
        userId, undefined, 'agent', 'agent-mode', undefined, undefined, undefined, undefined, 'emma-email', undefined
      );
      sessionId = newSession.sessionId;
      const defaultModel = await agentModeService.getDefaultModel();
      await chatbotDb.updateSessionLlmModel(sessionId, defaultModel, undefined, 'system');
      if (event.subject) {
        await chatbotDb.updateSessionTitle(sessionId, event.subject);
      }
      console.log(`[EmmaEmail] Created new Agent Mode session ${sessionId}`);
    }

    // 7. Update email metadata on session
    await chatbotDb.updateSessionEmailMetadata(sessionId, {
      senderEmail: event.from,
      lastInboundEmailId: event.emailId,
    });

    // 8. Upload email attachments to S3 for Agent Mode access
    let attachments: { url: string; filename: string; size: number; mimetype: string; uploadedAt: string }[] | undefined;
    if (emailContent.attachments && emailContent.attachments.length > 0) {
      console.log(`[EmmaEmail] Processing ${emailContent.attachments.length} attachment(s)`);
      attachments = [];
      for (const att of emailContent.attachments) {
        try {
          // Download from Resend's signed URL
          const downloadResp = await axios.get<ArrayBuffer>(att.download_url, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(downloadResp.data as ArrayBuffer);

          // Upload to S3
          const uploadResult = await uploadFileToS3(buffer, att.filename, userId, att.content_type);
          if (uploadResult.success && uploadResult.url) {
            attachments.push({
              url: uploadResult.url,
              filename: att.filename,
              size: att.size,
              mimetype: att.content_type,
              uploadedAt: new Date().toISOString(),
            });
            console.log(`[EmmaEmail] Uploaded attachment: ${att.filename} (${att.size} bytes)`);
          }
        } catch (err) {
          console.error(`[EmmaEmail] Failed to process attachment ${att.filename}:`, err);
        }
      }
      if (attachments.length === 0) attachments = undefined;
    }

    // 9. Generate response using Agent Mode (same logic as in-app Agent Mode chat)
    const fullMessage = isNewConversation && event.subject && messageBody
      ? `${event.subject}\n\n${messageBody}`
      : messageBody || event.subject || '';
    // ENG-2648: a continued chat keeps the model it already runs on (the user may have picked one in the
    // app), exactly like a Slack thread reply; only a new session uses the default (stamped above).
    // Read here, after the session is decided, so the ownership rules above stay the only gate.
    const continuedSession = sessionId === existingSessionId ? await chatbotDb.getChatSessionRecord(sessionId) : null;
    const llmModel = continuedSession?.llmModel || await agentModeService.getDefaultModel();
    // ENG-1189: this turn's tool calls self-call back into this process via
    // mcpFetch — tracked so a deploy mid-run waits for it instead of
    // abandoning it against a closed listener.
    // ENG-2648: a continued chat's stored model can be outside the owner's plan (downgrade): the final gate in
    // generateSessionResponse then refuses before anything runs. Same as a Slack thread reply, say so to the sender
    // (and in the chat) instead of dying silently; nothing ran on another model.
    let emmaResponse: string;
    try {
      const agentResponse = await cronJobRegistry.track('emmaEmailAgentTurn', generateSessionResponse(
        sessionId,
        fullMessage,
        userId,
        llmModel,
        attachments
      ));
      emmaResponse = agentResponse.content;
    } catch (genError) {
      if (!isModelUnavailableError(genError)) throw genError;
      emmaResponse = modelUnavailableBody(genError).error;
      try {
        await chatbotDb.addMessageToSession(sessionId, {
          role: 'assistant',
          content: emmaResponse,
          timestamp: new Date().toISOString(),
          metadata: { timestamp: new Date().toISOString(), isErrorMessage: true },
        });
      } catch (saveError) {
        console.error('[EmmaEmail] Error saving model refusal to session:', saveError);
      }
    }

    // 10. Create ishare URL (always the sender's own session — see step 6)
    const ishareUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId);

    // 11. Build and send response email
    const responseSubject = this.buildResponseSubject(event.subject, sessionId);
    const { html, text } = this.buildResponseEmail(emmaResponse, ishareUrl);

    // Use the actual Message-ID header from the inbound email for proper threading
    const inboundMessageId = emailContent.headers?.['message-id']
      || emailContent.headers?.['Message-ID']
      || emailContent.headers?.['Message-Id'];

    const sendResult = await resendService.sendEmail({
      from: EMMA_EMAIL_FROM,
      to: event.from,
      subject: responseSubject,
      html,
      text,
      inReplyTo: inboundMessageId || event.emailId,
    });

    // 12. Update outbound email ID on session
    if (sendResult?.id) {
      await chatbotDb.updateSessionEmailMetadata(sessionId, {
        senderEmail: event.from,
        lastInboundEmailId: event.emailId,
        lastOutboundEmailId: sendResult.id,
      });
    }

    console.log(`[EmmaEmail] Response sent for session ${sessionId}`);
  }
}

/**
 * Extract bare email address from a potentially formatted address.
 * "Emma <emma@example.com>" → "emma@example.com"
 * "emma@example.com" → "emma@example.com"
 */
function extractBareEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).toLowerCase().trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strip HTML tags to produce plain text (for email text/plain fallback).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const emmaEmailService = new EmmaEmailService();
