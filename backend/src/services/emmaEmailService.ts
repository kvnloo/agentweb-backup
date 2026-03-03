import { EMMA_EMAIL_ADDRESS, EMMA_EMAIL_FROM } from '../config';
import { resendService } from './resendService';
import { chatbotDb } from './chatbotService';
import { generateSessionResponse } from '../controllers/agentModeController';
import { agentModeService } from './agentModeService';
import { userDb } from './db';

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
    return toArray.some((addr) => extractBareEmail(addr) === emmaLower);
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
   * Look up a registered user by email. Returns null if not found.
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

    // Add [ref:sessionId] tag if not already present
    if (!SESSION_ID_REGEX.test(subject)) {
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

    // 3. Extract session ID from subject
    const existingSessionId = this.extractSessionId(event.subject);

    // 4. Resolve user — reject unregistered senders
    const userId = await this.resolveUserId(event.from);
    if (!userId) {
      await this.sendUnregisteredUserReply(event);
      return;
    }

    // 5. Determine session: continue existing or create new
    let sessionId: string;

    if (existingSessionId) {
      // Validate the session exists
      const existingSession = await chatbotDb.getChatSession(existingSessionId);
      if (existingSession) {
        sessionId = existingSessionId;
        console.log(`[EmmaEmail] Continuing existing session ${sessionId}`);
      } else {
        // Session not found — fall back to new session
        console.log(`[EmmaEmail] Session ${existingSessionId} not found, creating new session`);
        const newSession = await chatbotDb.createChatSession(
          userId, undefined, 'agent', 'agent-mode', undefined, undefined, undefined, undefined, 'emma-email', undefined
        );
        sessionId = newSession.sessionId;
        const defaultModel = await agentModeService.getDefaultModel();
        await chatbotDb.updateSessionLlmModel(sessionId, defaultModel);
        if (event.subject) {
          await chatbotDb.updateSessionTitle(sessionId, event.subject);
        }
      }
    } else {
      // New conversation — create Agent Mode session
      const newSession = await chatbotDb.createChatSession(
        userId, undefined, 'agent', 'agent-mode', undefined, undefined, undefined, undefined, 'emma-email', undefined
      );
      sessionId = newSession.sessionId;
      const defaultModel = await agentModeService.getDefaultModel();
      await chatbotDb.updateSessionLlmModel(sessionId, defaultModel);
      if (event.subject) {
        await chatbotDb.updateSessionTitle(sessionId, event.subject);
      }
      console.log(`[EmmaEmail] Created new Agent Mode session ${sessionId}`);
    }

    // 6. Update email metadata on session
    await chatbotDb.updateSessionEmailMetadata(sessionId, {
      senderEmail: event.from,
      lastInboundEmailId: event.emailId,
    });

    // 7. Generate response using Agent Mode (same logic as in-app Agent Mode chat)
    const isNewConversation = !existingSessionId;
    const fullMessage = isNewConversation && event.subject && messageBody
      ? `${event.subject}\n\n${messageBody}`
      : messageBody || event.subject || '';
    const llmModel = await agentModeService.getDefaultModel();
    const agentResponse = await generateSessionResponse(
      sessionId,
      fullMessage,
      userId,
      llmModel
    );
    const emmaResponse = agentResponse.content;

    // 8. Create ishare URL
    const ishareUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId);

    // 9. Build and send response email
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

    // 10. Update outbound email ID on session
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
