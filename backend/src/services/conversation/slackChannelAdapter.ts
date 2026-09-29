/**
 * Slack implementation of the conversation channel port (ENG-272).
 *
 * Behavior-preserving: every call here is the same call `routes/slack.ts` made
 * inline before the extraction, in the same order, against the same services.
 * In particular the persisted shapes are untouched — the session keeps its
 * historical `slackThread` field and the thread mapping keeps the
 * `slack_thread_{channel}_{ts}` settings key. Live customer threads depend on
 * both; changing either orphans every open conversation.
 */

import {
  postThreadResponse,
  resolveSlackFileUrl,
  downloadSlackFile,
} from '../slackService';
import { renderCitationMarkers } from '../../utils/citations';
import type {
  ConversationChannelAdapter,
  ConversationRef,
  ContextLinks,
  InboundAttachment,
  ResolvedAttachment,
} from './channelPort';

/**
 * ENG-351: resolve Emma's {{cite:N}} markers to Slack-clickable source links. The citation
 * metadata rides on the response's last assistant message; render as markdown links, which
 * postThreadResponse's markdown→mrkdwn converter turns into "<url|Source>". Falls back to
 * stripping when no citations.
 */
export function renderOutboundForSlack(response: any): string {
  const content: string = response?.content || '';
  const citations = [...(response?.responseMessages || [])]
    .reverse()
    .find((m: any) => m?.role === 'assistant')?.metadata?.citations;
  return renderCitationMarkers(content, Array.isArray(citations) ? citations : [], 'markdown');
}

export const slackChannelAdapter: ConversationChannelAdapter = {
  transport: 'slack',

  async persistThreadBinding(ref: ConversationRef, sessionId: string, userId: string): Promise<void> {
    const { chatbotDb } = await import('../chatbotService');
    const { settingsService } = await import('../settingsService');

    // Associate the session with this Slack thread
    await chatbotDb.updateSessionSlackThread(sessionId, {
      channel: ref.conversationId,
      threadTs: ref.threadId,
    });

    // Save thread-to-session mapping for future thread replies
    await settingsService.setSetting(
      `slack_thread_${ref.conversationId}_${ref.threadId}`,
      JSON.stringify({ sessionId, userId }),
      `Slack thread to session mapping`,
      'system'
    );
  },

  async postReply(ref: ConversationRef, text: string): Promise<void> {
    await postThreadResponse(ref.conversationId, ref.threadId, text);
  },

  async postContextLinks(ref: ConversationRef, links: ContextLinks): Promise<void> {
    if (!links.ishareLink) return;

    const { WebClient } = await import('@slack/web-api');
    const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

    const contextElements: any[] = [
      {
        type: 'mrkdwn',
        text: `:speech_balloon: Continue chat by simply reply or <${links.ishareLink}|click to chat in AgentWeb portal>`,
      },
    ];
    if (links.gtmTrackerLink) {
      contextElements.push({
        type: 'mrkdwn',
        text: `:bar_chart: <${links.gtmTrackerLink}|Manage all sessions in GTM Tracker>`,
      });
    }

    await slackClient.chat.postMessage({
      channel: ref.conversationId,
      thread_ts: ref.threadId,
      text: `Continue chat by simply reply or click to chat in AgentWeb portal: ${links.ishareLink}`,
      blocks: [
        {
          type: 'context',
          elements: contextElements,
        },
      ],
    });
  },

  async fetchAttachments(
    files: InboundAttachment[] | undefined,
    userId: string
  ): Promise<ResolvedAttachment[]> {
    const attachments: ResolvedAttachment[] = [];
    if (!files || files.length === 0) return attachments;

    for (const file of files) {
      try {
        // Slack Connect / ext-shared channels omit url_private and send a stub
        // (file_access: 'check_file_info') — hydrate it via files.info first (ENG-323).
        const fileUrl = await resolveSlackFileUrl(file);
        const fileBuffer = await downloadSlackFile(fileUrl);
        const { uploadFileToS3 } = await import('../../utils/s3Utils');
        const uploadResult = await uploadFileToS3(
          fileBuffer,
          file.name || 'attachment',
          userId,
          file.mimetype || 'application/octet-stream'
        );
        if (!uploadResult.success || !uploadResult.url) {
          console.error('❌ Failed to upload Slack file to S3');
          continue;
        }
        attachments.push({
          url: uploadResult.url,
          filename: file.name || 'attachment',
          size: file.size,
          mimetype: file.mimetype || 'application/octet-stream',
        });
      } catch (fileError) {
        console.error('❌ Error downloading Slack file:', fileError);
      }
    }
    return attachments;
  },

  renderOutbound(response: any): string {
    return renderOutboundForSlack(response);
  },

  gtmTrackerLink(planId: string, phaseId: string, isAdminChannel?: boolean): string {
    const deepLinkParams = `?planId=${planId}&phaseId=${phaseId}`;
    if (isAdminChannel) {
      // Admin-channel sessions: link to partner portal GTM ops page
      const partnerPortalUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      return `${partnerPortalUrl}/gtm-ops${deepLinkParams}`;
    }
    // Regular user sessions: link to customer portal GTM plan page
    const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    return `${customerFrontendUrl}/gtm-plan${deepLinkParams}`;
  },
};
