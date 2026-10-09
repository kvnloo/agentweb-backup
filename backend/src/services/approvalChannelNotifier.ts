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
import {
  TEMPLATES,
  isServiceWindowOpen,
  redactPhone,
  resolveUserIdByPhone,
  sendInteractiveButtons,
  sendText,
} from './whatsappService';
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
 * Never throws. Resolves true only when the message was actually handed to WhatsApp, so
 * the caller can tell "reached the reviewer here" from "nothing to send / send failed".
 */
export async function notifyApprovalOnWhatsApp(
  params: ApprovalChannelNotification,
): Promise<boolean> {
  try {
    if (!params.userId) return false;

    const { userDb } = await import('./db');
    const user = await userDb.getUserById(params.userId);
    if (!user) return false;

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
    if (!params.approvalChannel || !watchesApprovalChannel) return false;

    await bootstrapMessagingChannels();
    const destination = await resolveDestination(user as any, 'whatsapp');
    if (!destination) return false;

    const assetType = params.assetType || 'Asset';
    const filename = params.filename || 'Untitled';
    const summary = `${assetType} "${filename}" is waiting for your approval. ${params.assetUrl}`;

    // Two shapes, chosen by the window, because Meta allows very different things
    // either side of it.
    //
    // INSIDE: real Approve/Reject buttons. Interactive messages are service messages,
    // so they need no pre-approved template — which also means this path is testable
    // the moment a customer has written to us, with no Meta review in the loop.
    //
    // OUTSIDE: only a template can be delivered at all, so the reviewer gets the text
    // and a link and answers in Slack or the portal. Putting quick-reply buttons on the
    // template would work, but Meta returns a template button's own LABEL rather than
    // an id, and more than three buttons (or mixing button types) breaks WhatsApp
    // Desktop — so that variant is worth its own change, not a silent upgrade here.
    const sent = (await isServiceWindowOpen(destination))
      ? await sendInteractiveButtons(destination, summary, [
          { id: 'approve', title: 'Approve' },
          { id: 'reject', title: 'Reject' },
        ])
      : await getMessagingChannel('whatsapp').sendMessage({
          destination,
          text: summary,
          template: {
            name: TEMPLATES.APPROVAL_REQUEST.name,
            variables: [assetType, filename, params.assetUrl],
          },
        } as any);

    // Keep the provider's message id. A tap arrives carrying `context.id` — the id of
    // the message the button was on — and NOTHING else that identifies the approval:
    // Meta sets `button.payload` to the button's own label, so a decision id cannot be
    // smuggled through the button. This row is the only link back to what was approved.
    if (sent?.messageId) {
      await rememberApprovalMessage(sent.messageId, {
        assetUrl: params.assetUrl,
        userId: params.userId,
      });
    }
    return true;
  } catch (error) {
    // Logged against the user id, never the phone number (CWE-532): the id is enough
    // to correlate this with the approval it belongs to.
    console.warn(
      `[approval-notify] WhatsApp approval notice for user ${params.userId} failed:`,
      error instanceof Error ? error.message : error,
    );
    return false;
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

// ── Inbound: a tapped Approve / Reject button ──────────────────────────────

const VERDICTS: Record<string, 'approved' | 'rejected'> = {
  approve: 'approved',
  approved: 'approved',
  reject: 'rejected',
  rejected: 'rejected',
};

const claimKey = (assetUrl: string) => `whatsapp:approval-claim:${assetUrl}`;

/**
 * WhatsApp cannot lock or remove buttons once a message is sent — the client greys out
 * only the one that was tapped, and the other stays live forever. So the answer to a
 * later tap has to do the locking in words: say what was recorded and that it is final.
 */
function alreadyAnsweredReply(status?: string): string {
  if (status === 'approved') {
    return 'This was already approved, so the buttons no longer do anything. Nothing has changed.';
  }
  if (status === 'rejected') {
    return 'This was already rejected, so the buttons no longer do anything. Nothing has changed.';
  }
  return 'This one is already answered, so the buttons no longer do anything. Nothing has changed.';
}

/**
 * Record an approval verdict tapped on WhatsApp.
 *
 * Idempotency is not optional here, and this is the part that differs sharply from
 * Slack. Slack strips an approval's buttons the moment it is answered, so a second
 * click is impossible. WhatsApp has no edit operation: the buttons stay on the
 * customer's screen forever, and every tap arrives as a fresh inbound message. Since
 * approving fans out email to every task subscriber, an un-claimed handler would turn
 * an idle double-tap into duplicate mail. The claim is taken BEFORE the status write
 * so a repeat loses the race rather than re-running the work.
 *
 * Attribution is checked, not assumed: the tapping number must resolve to the very
 * user the approval belongs to. A number that has since moved accounts, or simply
 * isn't this approval's owner, is ignored rather than allowed to answer someone
 * else's decision.
 */
export async function handleApprovalButtonTap(params: {
  phone: string;
  approvalMessageId: string;
  action: string;
}): Promise<void> {
  try {
    const verdict = VERDICTS[params.action.trim().toLowerCase()];
    if (!verdict) return; // Not an approval button — nothing to do.

    const ref = await lookupApprovalMessage(params.approvalMessageId);
    if (!ref) {
      // Expired (30-day TTL) or never ours.
      console.warn(
        `[approval-notify] tap from ${redactPhone(params.phone)} referenced an unknown message`,
      );
      return;
    }

    const senderUserId = await resolveUserIdByPhone(params.phone);
    if (!senderUserId || senderUserId !== ref.userId) {
      console.warn(
        `[approval-notify] tap from ${redactPhone(params.phone)} does not own that approval — ignored`,
      );
      return;
    }

    const { settingsService: settings } = await import('./settingsService');
    const claimed = await settings.claimSetMember(claimKey(ref.assetUrl), 'answered');
    if (!claimed) {
      // Already answered. Say so rather than going quiet: with no way to grey the
      // button out, silence is indistinguishable from a failure.
      let recorded: string | undefined;
      try {
        const { approvalDb } = await import('./approvalDb');
        recorded = (await approvalDb.getApproval(ref.assetUrl))?.status;
      } catch {
        // The generic wording is fine if the record cannot be read.
      }
      await sendText(params.phone, alreadyAnsweredReply(recorded)).catch(() => {});
      return;
    }

    let recordedApproval: { executionId?: string } | null = null;
    try {
      const { approvalDb } = await import('./approvalDb');
      recordedApproval = await approvalDb.updateApprovalStatus(
        ref.assetUrl,
        verdict,
        `whatsapp:${ref.userId}`,
      );
    } catch (error) {
      // Release so the customer can retry; a consumed claim with no recorded verdict
      // would leave the approval permanently unanswerable from WhatsApp.
      await settings.releaseSetMember(claimKey(ref.assetUrl), 'answered').catch(() => {});
      throw error;
    }

    if (verdict === 'approved') {
      // Same consequence as approving on Slack: the task's subscribers are emailed.
      // Safe to run here because the claim above guarantees it happens once per
      // approval, however many times the button is tapped. Never throws.
      const { notifySubscribersOfApproval } = await import('./approvalSubscriberNotify');
      await notifySubscribersOfApproval(recordedApproval);
    }

    await sendText(
      params.phone,
      verdict === 'approved' ? 'Approved — thanks, that is recorded.' : 'Rejected — thanks, that is recorded.',
    ).catch((e) =>
      console.warn('[approval-notify] verdict confirmation failed to send:', e?.message || e),
    );
  } catch (error) {
    // Never throw into the webhook: a 500 makes Meta retry, and a retried tap would
    // hit the claim and be reported to the customer as "already recorded".
    console.error(
      '[approval-notify] handling an approval button tap failed:',
      error instanceof Error ? error.message : error,
    );
  }
}
