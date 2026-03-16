import { Webhook } from 'svix';
import { chatbotDb } from './chatbotService';
import { agentModeService } from './agentModeService';
import { generateSessionResponse } from '../controllers/agentModeController';

// --- Types ---

export interface FathomCalendarInvitee {
  name: string;
  email: string;
  domain: string;
  is_external: boolean;
}

export interface FathomActionItem {
  description: string;
  is_completed: boolean;
  timestamp: string;
  assignee?: { name: string; email: string };
}

export interface FathomTranscriptEntry {
  speaker: { display_name: string; matched_email?: string };
  text: string;
  timestamp: string;
}

export interface FathomMeetingPayload {
  title: string;
  recording_id: number;
  url: string;
  scheduled_start_time: string;
  recording_start_time: string;
  recording_end_time: string;
  calendar_invitees: FathomCalendarInvitee[];
  default_summary: { template_name: string; markdown_formatted: string };
  action_items: FathomActionItem[];
  transcript: FathomTranscriptEntry[];
}

export interface ParsedMeeting {
  title: string;
  recordingId: number;
  recordingUrl: string;
  scheduledStart: string;
  recordingStart: string;
  recordingEnd: string;
  summary: string;
  actionItems: {
    description: string;
    isCompleted: boolean;
    timestamp: string;
    assignee?: { name: string; email: string };
  }[];
  participants: { name: string; email: string; domain: string; isExternal: boolean }[];
  transcript: { speaker: string; text: string; timestamp: string }[];
}

export interface FathomWebhookHeaders {
  'webhook-id'?: string;
  'webhook-timestamp'?: string;
  'webhook-signature'?: string;
}

// --- Service ---

export class FathomWebhookService {
  private webhookSecret: string | undefined;

  constructor() {
    this.webhookSecret = process.env.FATHOM_WEBHOOK_SECRET;
  }

  /**
   * Verify the Svix webhook signature on an incoming Fathom webhook request.
   * Throws if verification fails.
   */
  verifySignature(payload: string, headers: FathomWebhookHeaders): void {
    if (!this.webhookSecret) {
      throw new Error('FATHOM_WEBHOOK_SECRET is not configured');
    }

    const wh = new Webhook(this.webhookSecret);
    // Svix verify throws on invalid signatures
    wh.verify(payload, {
      'webhook-id': headers['webhook-id'] || '',
      'webhook-timestamp': headers['webhook-timestamp'] || '',
      'webhook-signature': headers['webhook-signature'] || '',
    });
  }

  /**
   * Parse the raw Fathom meeting payload into a structured format.
   */
  parseMeetingPayload(payload: FathomMeetingPayload): ParsedMeeting {
    return {
      title: payload.title,
      recordingId: payload.recording_id,
      recordingUrl: payload.url,
      scheduledStart: payload.scheduled_start_time,
      recordingStart: payload.recording_start_time,
      recordingEnd: payload.recording_end_time,
      summary: payload.default_summary?.markdown_formatted || '',
      actionItems: (payload.action_items || []).map((item) => ({
        description: item.description,
        isCompleted: item.is_completed,
        timestamp: item.timestamp,
        assignee: item.assignee ? { name: item.assignee.name, email: item.assignee.email } : undefined,
      })),
      participants: (payload.calendar_invitees || []).map((inv) => ({
        name: inv.name,
        email: inv.email,
        domain: inv.domain,
        isExternal: inv.is_external,
      })),
      transcript: (payload.transcript || []).map((entry) => ({
        speaker: entry.speaker.display_name,
        text: entry.text,
        timestamp: entry.timestamp,
      })),
    };
  }

  /**
   * Format parsed meeting data into a message to send to Emma.
   */
  formatMeetingMessage(meeting: ParsedMeeting): string {
    const sections: string[] = [];

    sections.push(`# Meeting: ${meeting.title}`);
    sections.push(`**Recording**: ${meeting.recordingUrl}`);
    sections.push(`**Time**: ${meeting.recordingStart} — ${meeting.recordingEnd}`);

    if (meeting.participants.length > 0) {
      sections.push('\n## Participants');
      for (const p of meeting.participants) {
        const ext = p.isExternal ? ' (external)' : '';
        sections.push(`- ${p.name} <${p.email}>${ext}`);
      }
    }

    if (meeting.summary) {
      sections.push('\n## Summary');
      sections.push(meeting.summary);
    }

    if (meeting.actionItems.length > 0) {
      sections.push('\n## Action Items');
      for (const item of meeting.actionItems) {
        const status = item.isCompleted ? '[x]' : '[ ]';
        const assignee = item.assignee ? ` — assigned to ${item.assignee.name} (${item.assignee.email})` : '';
        sections.push(`- ${status} ${item.description}${assignee}`);
      }
    }

    if (meeting.transcript.length > 0) {
      sections.push('\n## Transcript');
      for (const entry of meeting.transcript) {
        sections.push(`**${entry.speaker}** (${entry.timestamp}): ${entry.text}`);
      }
    }

    return sections.join('\n');
  }

  /**
   * Create an Emma Agent Mode session with the meeting data and send it as the first message.
   * Returns the session ID.
   */
  async createEmmaSession(meeting: ParsedMeeting, userId: string): Promise<string> {
    // Create an Agent Mode session with session type 'meeting-intake'
    const newSession = await chatbotDb.createChatSession(
      userId,
      undefined,   // pageContent
      'agent',     // portalType
      'agent-mode', // pageIdentifier
      undefined,   // selectedStartupId
      undefined,   // workflowId
      undefined,   // executionId
      undefined,   // emailCampaignTaskId
      'meeting-intake', // sessionType
      undefined    // delegateInfo
    );

    const sessionId = newSession.sessionId;

    // Set the default LLM model
    const defaultModel = await agentModeService.getDefaultModel();
    await chatbotDb.updateSessionLlmModel(sessionId, defaultModel);

    // Set session title
    await chatbotDb.updateSessionTitle(sessionId, `Meeting: ${meeting.title}`);

    // Format and send the meeting data as the first user message
    const message = this.formatMeetingMessage(meeting);
    await generateSessionResponse(sessionId, message, userId, defaultModel, undefined);

    return sessionId;
  }
}

export const fathomWebhookService = new FathomWebhookService();
