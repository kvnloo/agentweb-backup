/**
 * Approval requests on peer messaging channels (ENG-273).
 *
 * Approvals began life as a Slack-only flow: an interactive message with Approve and
 * Reject buttons. WhatsApp cannot reproduce that — it has no Block Kit, and reply
 * buttons need a pre-approved interactive template plus inbound button handling, which
 * the registry deliberately does not have yet. So this is a NOTIFICATION, not a second
 * place to approve from: it tells the reviewer something is waiting and links them to
 * the asset. Approving still happens in Slack or the portal, which keeps exactly one
 * surface authoritative and avoids two half-implemented approval paths disagreeing.
 *
 * Additive by construction. The Slack send and the approval record both happen before
 * this runs, and nothing here can change or fail either one — same contract as the
 * WhatsApp block in leadListAlertService.
 */
import {
  bootstrapMessagingChannels,
  getMessagingChannel,
  normalizeUserChannels,
  resolveDestination,
} from './messagingChannelService';
import { TEMPLATES } from './whatsappService';
import { settingsService } from './settingsService';

export interface ApprovalChannelNotification {
  /**
   * The approval record's owning account. NOT necessarily the reviewer — on
   * `POST /send-approval` this is the authenticated caller, i.e. whoever REQUESTED the
   * approval. See the audience check in the implementation.
   */
  userId: string;
  /** The Slack channel the approval was posted to — the reviewers' actual audience. */
  approvalChannel: string;
  /** Asset kind, e.g. "image" or "video" — becomes the template's {{1}}. */
  assetType: string;
  /** Human-readable asset name — the template's {{2}}. */
  filename: string;
  /** Where the reviewer can look at the asset — the template's {{3}}. */
  assetUrl: string;
}

/**
 * Notify the requesting user's WhatsApp number, if they have connected and verified one.
 *
 * Never throws. A reviewer missing a WhatsApp ping is an inconvenience; an approval that
 * fails to send because a secondary channel was unreachable is a broken feature.
 */
export async function notifyApprovalOnWhatsApp(
  params: ApprovalChannelNotification,
): Promise<void> {
  try {
    if (!params.userId) return;

    const { userDb } = await import('./db');
    const user = await userDb.getUserById(params.userId);
    if (!user) return;

    // Only notify someone who is genuinely an audience of THIS approval. `userId` is
    // the requester, and the reviewers are whoever watches the Slack channel the
    // approval went to — the two are often the same person but are not the same field,
    // and sending on `userId` alone pings the requester about a decision nobody asked
    // them to make. Requiring their own Slack destination to include the approval's
    // channel makes this a true mirror of the Slack message's audience. It costs
    // nothing: the channels are already on the user record just loaded, and no reverse
    // channel-to-user index exists to do it the other way round.
    //
    // Deliberately fails CLOSED. A reviewer who watches the channel but has not linked
    // that channel to their account gets no WhatsApp ping, which is a missing
    // notification; the alternative messages the wrong person about someone else's
    // asset, which is a privacy problem.
    const watchesApprovalChannel = normalizeUserChannels(user as any).some(
      (c) => c.channel === 'slack' && c.enabled && c.destination === params.approvalChannel,
    );
    if (!params.approvalChannel || !watchesApprovalChannel) return;

    await bootstrapMessagingChannels();
    const destination = await resolveDestination(user as any, 'whatsapp');
    if (!destination) return;

    const assetType = params.assetType || 'Asset';
    const filename = params.filename || 'Untitled';

    const sent = await getMessagingChannel('whatsapp').sendMessage({
      destination,
      // Used when the 24-hour window happens to be open; outside it Meta requires the
      // template below, which carries the same three facts.
      text: `${assetType} "${filename}" is waiting for your approval. ${params.assetUrl}`,
      template: {
        name: TEMPLATES.APPROVAL_REQUEST.name,
        variables: [assetType, filename, params.assetUrl],
      },
    } as any);

    // Keep the provider's message id. When this message grows Approve/Reject buttons,
    // the tap arrives carrying `context.id` — the id of the message the button was on —
    // and NOTHING else that identifies the approval: Meta sets `button.payload` to the
    // button's own label, so a decision id cannot be smuggled through the button.
    // This row is therefore the only link from a tap back to what was being approved.
    if (sent?.messageId) {
      await rememberApprovalMessage(sent.messageId, {
        assetUrl: params.assetUrl,
        userId: params.userId,
      });
    }
  } catch (error) {
    // Logged against the user id, never the phone number (CWE-532): the id is enough
    // to correlate this with the approval it belongs to.
    console.warn(
      `[approval-notify] WhatsApp approval notice for user ${params.userId} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** What an inbound button tap on an approval message resolves back to. */
export interface ApprovalMessageRef {
  assetUrl: string;
  userId: string;
}

const approvalMsgKey = (messageId: string) => `whatsapp:approval-msg:${messageId}`;

/**
 * Thirty days, matching WhatsApp's own limit: a quoted reply to a message older than
 * about 30 days does not render, so a tap can no longer arrive after that and the row
 * is dead weight. Stored as epoch SECONDS, which is what DynamoDB's TTL expects —
 * milliseconds here would keep the row for millennia.
 */
const APPROVAL_MSG_TTL_DAYS = 30;

export async function rememberApprovalMessage(
  messageId: string,
  ref: ApprovalMessageRef,
): Promise<void> {
  try {
    await settingsService.setSetting(
      approvalMsgKey(messageId),
      JSON.stringify(ref),
      'WhatsApp approval message -> asset (for inbound button taps)',
      'system',
      Math.floor(Date.now() / 1000) + APPROVAL_MSG_TTL_DAYS * 24 * 60 * 60,
    );
  } catch (error) {
    // Losing the correlation row costs a future button tap, not this notification.
    console.warn(
      '[approval-notify] could not record approval message id:',
      error instanceof Error ? error.message : error,
    );
  }
}

/** The approval a tapped button belongs to, or null if unknown or expired. */
export async function lookupApprovalMessage(
  messageId: string,
): Promise<ApprovalMessageRef | null> {
  const row = await settingsService.getSetting(approvalMsgKey(messageId));
  if (!row?.settingValue) return null;
  try {
    const parsed = JSON.parse(row.settingValue);
    return parsed?.assetUrl && parsed?.userId ? (parsed as ApprovalMessageRef) : null;
  } catch {
    // A wamid is an opaque provider handle, not PII — safe to log as-is.
    console.warn(`[approval-notify] unparseable approval-message row for ${messageId}`);
    return null;
  }
}
