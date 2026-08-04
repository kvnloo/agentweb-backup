/**
 * WhatsApp expressed as an `IMessagingChannel` (ENG-273).
 *
 * The capability record here is the honest statement of what WhatsApp cannot do, and
 * it is what lets shared call sites degrade deliberately instead of failing:
 *
 *   canEdit: false        -> callers send a follow-up instead of editing in place
 *   canDelete: false      -> Cloud API has no delete; callers must not offer one
 *   hasThreads: false     -> quoted reply via replyToMessageId, not a thread
 *   hasModals: false      -> deep-link to the customer portal instead
 *   canReadHistory: false -> no history API; we only know what the webhook delivered
 *   hasDirectory: false   -> no user lookup, no mentions; a phone and a profile name
 *
 * See docs/integrations/whatsapp-contract.md for the full mapping.
 */

import {
  type ChannelCapabilities,
  type IMessagingChannel,
  type SendMessageParams,
  type SentMessage,
} from './messagingChannelService';
import { sendMessage as whatsappSend } from './whatsappService';

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  canEdit: false,
  canDelete: false,
  hasThreads: false,
  hasModals: false,
  canReadHistory: false,
  hasDirectory: false,
  addressing: 'phone',
  // Up to 3 reply buttons, and only inside an approved template.
  supportsInteractive: true,
  requiresTemplateOutsideWindow: true,
  requiresOptIn: true,
};

/** A send that may need to survive a closed service window. */
export interface WhatsAppSendMessageParams extends SendMessageParams {
  template?: { name: string; variables: string[] };
}

class WhatsAppChannelAdapter implements IMessagingChannel {
  readonly channel = 'whatsapp' as const;
  readonly capabilities = WHATSAPP_CAPABILITIES;

  async sendMessage(params: WhatsAppSendMessageParams): Promise<SentMessage> {
    // whatsappService already throws typed MessagingChannelError subclasses, so there
    // is nothing useful to wrap here — re-wrapping would only bury the subcode.
    return whatsappSend({
      destination: params.destination,
      text: params.text,
      template: params.template,
    });
  }
}

export const whatsappChannelAdapter = new WhatsAppChannelAdapter();
