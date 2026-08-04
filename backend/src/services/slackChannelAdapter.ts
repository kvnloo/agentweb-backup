/**
 * Slack, expressed as an `IMessagingChannel` (ENG-273).
 *
 * This is a thin adapter over the existing `slackService` functions — deliberately
 * so. It adds no behavior: the Slack test suites (`slack.events.test.ts`,
 * `slackService.*.test.ts`, `loopSlackApprovalDispatcher.test.ts`,
 * `admin.slackChannelMapping.test.ts` and siblings) are the regression proof that
 * introducing the channel seam left Slack untouched.
 *
 * `slackService` keeps its direct callers for the Slack-only surfaces that have no
 * cross-channel meaning: modals, mention resolution, channel listing, file download,
 * and the internal-ops alerts (`humanEvalService`, `leadCaptureFailureService`,
 * `sendLandingPageSmokeTestAlert`). Those are not going through this interface, and
 * that is intentional rather than an omission — see the capability table in
 * docs/integrations/whatsapp-contract.md.
 */

import {
  MessagingChannelError,
  type ChannelCapabilities,
  type IMessagingChannel,
  type SendMessageParams,
  type SentMessage,
} from './messagingChannelService';
import { postSlackMessage } from './slackService';

export class SlackChannelError extends MessagingChannelError {
  constructor(message: string) {
    super(message, 'slack');
  }
}

const SLACK_CAPABILITIES: ChannelCapabilities = {
  canEdit: true,
  canDelete: true,
  hasThreads: true,
  hasModals: true,
  canReadHistory: true,
  hasDirectory: true,
  addressing: 'channel',
  supportsInteractive: true,
  // Slack has no service window and no opt-in gate — both are WhatsApp platform
  // constraints, not general messaging concepts.
  requiresTemplateOutsideWindow: false,
  requiresOptIn: false,
};

class SlackChannelAdapter implements IMessagingChannel {
  readonly channel = 'slack' as const;
  readonly capabilities = SLACK_CAPABILITIES;

  async sendMessage(params: SendMessageParams): Promise<SentMessage> {
    try {
      // postSlackMessage already takes an optional thread_ts and returns the new ts,
      // so it covers both the flat and threaded cases. Deliberately NOT
      // postThreadResponse: that one also runs markdown→mrkdwn conversion and
      // chunking for Emma's long-form replies, which would change what a plain
      // notification looks like.
      const result = await postSlackMessage(
        params.destination,
        params.text,
        params.replyToMessageId,
      );
      return { messageId: result.ts || null };
    } catch (e) {
      throw new SlackChannelError(
        `Slack send to ${params.destination} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

export const slackChannelAdapter = new SlackChannelAdapter();
