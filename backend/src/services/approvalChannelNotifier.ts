/**
 * Approval requests on WhatsApp (ENG-273): the request, and the taps that answer it.
 *
 * Slack and WhatsApp are separate features and a customer connects one of them. An
 * approval reaches a WhatsApp customer as a message with Approve / Reject reply buttons
 * while their 24-hour window is open (a service message, so no template), or as the
 * approval template with a link when it is not. A tap comes back through the webhook and
 * is recorded by `handleApprovalButtonTap`.
 *
 * Unlike Slack, WhatsApp cannot remove or disable a button once a message is sent, so a
 * tap has to be safe to repeat: the verdict is written with a single conditional update
 * that only succeeds while the approval is still open (see approvalDb.answerIfOpen).
 *
 * Nothing here throws into its caller. A WhatsApp problem must never fail the approval
 * request that triggered it, nor a webhook delivery that Meta would then retry.
 */
import {
  bootstrapMessagingChannels,
  getMessagingChannel,
  resolveDestination,
} from './messagingChannelService';
import {
  TEMPLATES,
  WhatsAppError,
  isServiceWindowOpen,
  redactPhone,
  resolveUserIdByPhone,
  sendInteractiveButtons,
  sendText,
} from './whatsappService';
import { settingsService } from './settingsService';

export interface ApprovalChannelNotification {
  /** The customer account that owns the asset and is being asked to approve it. */
  userId: string;
  /** The account's record, if the caller already loaded it — saves a second read. */
  user?: unknown;
  /** Asset kind, e.g. "image" or "video" — becomes the template's {{1}}. */
  assetType: string;
  /** Human-readable asset name — the template's {{2}}. */
  filename: string;
  /** Where the reviewer can look at the asset — the template's {{3}}. */
  assetUrl: string;
}

/**
 * What happened to a WhatsApp approval notice:
 *  - delivered:      handed to WhatsApp.
 *  - not_applicable: the account has no WhatsApp number to send to. Nothing went wrong.
 *  - failed:         the account HAS a number and the send failed. Distinct from the
 *                    above because the caller must not read it as "no channel": a
 *                    customer who can be reached but was not must not have their
 *                    approval gate quietly opened.
 */
export type WhatsAppNotifyOutcome = 'delivered' | 'not_applicable' | 'failed';

const BODY_BUDGET = 1000; // interactive body limit is 1024; leave headroom

/**
 * The text of the approval message, shaped so the asset link is never cut off. A body
 * that is simply truncated at the limit can slice the URL mid-way, which leaves a link
 * that opens the wrong thing or nothing — worse than no link. The filename is capped
 * first; if the URL alone still will not fit, the link is dropped and the customer is
 * pointed at AgentWeb instead.
 */
export function approvalMessageText(assetType: string, filename: string, assetUrl: string): string {
  // By code point, not UTF-16 unit: slicing inside an emoji leaves a lone surrogate Meta may reject.
  const points = Array.from(filename);
  const name = points.length > 80 ? `${points.slice(0, 79).join('')}…` : filename;
  const head = `${assetType} "${name}" is waiting for your approval.`;
  const full = `${head} ${assetUrl}`;
  return full.length <= BODY_BUDGET ? full : `${head} Open AgentWeb to review it.`;
}

/**
 * Notify the owning account on WhatsApp, if it has connected and verified a number.
 * Never throws.
 */
export async function notifyApprovalOnWhatsApp(
  params: ApprovalChannelNotification,
): Promise<WhatsAppNotifyOutcome> {
  try {
    if (!params.userId) return 'not_applicable';

    let user: any = params.user;
    if (!user) {
      const { userDb } = await import('./db');
      user = await userDb.getUserById(params.userId);
    }
    if (!user) return 'not_applicable';

    // No Slack check here, deliberately. Slack and WhatsApp are separate features and a
    // customer connects one of them. The recipient is the account that owns the asset,
    // on a number that account personally verified; phone numbers are never inherited
    // from an org, so this cannot reach anyone but that account's own handset.
    await bootstrapMessagingChannels();
    const destination = await resolveDestination(user, 'whatsapp');
    if (!destination) return 'not_applicable';

    const assetType = params.assetType || 'Asset';
    const filename = params.filename || 'Untitled';
    const summary = approvalMessageText(assetType, filename, params.assetUrl);

    // Two shapes, chosen by the window, because Meta allows very different things
    // either side of it.
    //
    // INSIDE: real Approve/Reject buttons. Interactive messages are service messages, so
    // they need no pre-approved template.
    //
    // OUTSIDE: only a template can be delivered at all. The customer gets the Approve /
    // Reject quick-reply template; until Meta has approved it (it answers 132001, template
    // does not exist) they get the link-only template and answer in the portal. Templates
    // with mixed button types cannot be viewed on WhatsApp Desktop, so this one carries
    // quick replies only.
    const sendOutsideWindow = async () => {
      const send = (template: { name: string }) =>
        getMessagingChannel('whatsapp').sendMessage({
          destination,
          text: summary,
          template: { name: template.name, variables: [assetType, filename, params.assetUrl] },
        } as any);
      try {
        return await send(TEMPLATES.APPROVAL_REQUEST_BUTTONS);
      } catch (error) {
        if (error instanceof WhatsAppError && error.subcode === 132001) {
          return send(TEMPLATES.APPROVAL_REQUEST);
        }
        throw error;
      }
    };
    const sent = (await isServiceWindowOpen(destination))
      ? await sendInteractiveButtons(destination, summary, [
          { id: 'approve', title: 'Approve' },
          { id: 'reject', title: 'Reject' },
        ])
      : await sendOutsideWindow();

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
    return 'delivered';
  } catch (error) {
    // Logged against the user id, never the phone number (CWE-532): the id is enough
    // to correlate this with the approval it belongs to.
    console.warn(
      `[approval-notify] WhatsApp approval notice for user ${params.userId} failed:`,
      error instanceof Error ? error.message : error,
    );
    return 'failed';
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

/**
 * What to say to a tap that arrives after the approval was already answered. WhatsApp
 * greys out only the button that was tapped, so the other one stays live forever — the
 * reply has to do in words the locking the client will not do.
 */
function alreadyAnsweredReply(current: string | null): string {
  if (current === 'approved') {
    return 'This was already approved, so the buttons no longer do anything. Nothing has changed.';
  }
  if (current === 'rejected') {
    return 'This was already rejected, so the buttons no longer do anything. Nothing has changed.';
  }
  if (current === 'revision_submitted') {
    return 'A revision of this has already been requested, so the buttons no longer do anything. Nothing has changed.';
  }
  if (current === null) {
    return 'This approval request is no longer available, so nothing was changed.';
  }
  return 'This one is already answered, so the buttons no longer do anything. Nothing has changed.';
}

const NOT_CONNECTED =
  "This number isn't connected to an AgentWeb account any more, so that answer couldn't be recorded. " +
  'Open Settings in AgentWeb to connect WhatsApp again.';

const COULD_NOT_RECORD =
  "Sorry, we couldn't record that just now. Please tap the button again in a moment.";

/**
 * Record an approval verdict tapped on WhatsApp.
 *
 * Idempotency is the whole point of this function. The buttons can never be removed, so
 * every tap — a double tap, a tap on the other button, a tap a week later — arrives as a
 * fresh message, and the customer may also have answered on another surface. Approving
 * emails the task's subscribers, so a handler that could run twice would send that twice.
 *
 * The verdict is therefore written by one atomic conditional update that succeeds only
 * while the approval is still open. Exactly one tap can win it; the subscriber email is
 * sent only by the winner. An earlier version took a separate claim row first, which
 * guarded only WhatsApp taps (the portal and Slack write the same status), never expired,
 * and survived a re-requested approval so its buttons answered "already done" while the
 * record said pending.
 *
 * Attribution is checked, not assumed: the tapping number must resolve to the user the
 * approval belongs to. A number that has moved accounts, or simply is not this approval's
 * owner, is ignored rather than allowed to answer someone else's decision.
 */
export async function handleApprovalButtonTap(params: {
  phone: string;
  approvalMessageId: string;
  action: string;
}): Promise<void> {
  try {
    const verdict = VERDICTS[params.action.trim().toLowerCase()];
    if (!verdict) return; // Not an approval button — nothing to do.

    let ref: Awaited<ReturnType<typeof lookupApprovalMessage>>;
    let senderUserId: string | null;
    try {
      ref = await lookupApprovalMessage(params.approvalMessageId);
      senderUserId = ref ? await resolveUserIdByPhone(params.phone) : null;
    } catch (error) {
      // A storage blip while reading the correlation. Meta gets a 200 either way (this
      // handler never throws), so say so rather than leave the customer wondering.
      console.error(
        '[approval-notify] could not read an approval tap:',
        error instanceof Error ? error.message : error,
      );
      await sendText(params.phone, COULD_NOT_RECORD).catch(() => {});
      return;
    }
    if (!ref) {
      // Expired (30-day TTL), or the correlation row was never written (it is best-effort).
      // The button id came from a message of ours, so answer rather than going quiet: with
      // no visible state on a WhatsApp button, silence reads as "recorded".
      console.warn(
        `[approval-notify] tap from ${redactPhone(params.phone)} referenced an unknown message`,
      );
      await sendText(params.phone, alreadyAnsweredReply(null)).catch(() => {});
      return;
    }

    if (!senderUserId) {
      // The number no longer belongs to any account (they sent STOP, or an admin removed
      // it) but is back to receiving messages. Their buttons cannot be recorded, and
      // silence reads as "recorded".
      console.warn(
        `[approval-notify] tap from ${redactPhone(params.phone)} which is no longer connected to an account`,
      );
      await sendText(params.phone, NOT_CONNECTED).catch(() => {});
      return;
    }
    if (senderUserId !== ref.userId) {
      console.warn(
        `[approval-notify] tap from ${redactPhone(params.phone)} does not own that approval — ignored`,
      );
      return;
    }

    const { approvalDb } = await import('./approvalDb');
    let outcome;
    try {
      outcome = await approvalDb.answerIfOpen(ref.assetUrl, verdict, `whatsapp:${ref.userId}`, ref.userId);
    } catch (error) {
      // A real failure, not "already answered". Say so rather than staying silent: with
      // no visible state on a WhatsApp button, silence reads as success.
      console.error(
        '[approval-notify] could not record an approval tap:',
        error instanceof Error ? error.message : error,
      );
      await sendText(params.phone, COULD_NOT_RECORD).catch(() => {});
      return;
    }

    if (!outcome.answered) {
      // Still open but refused: the record now belongs to someone else (another account
      // re-requested the same asset), so these buttons no longer point at this customer's
      // approval. Say it is gone rather than "already answered".
      const stale = outcome.current === 'pending' || outcome.current === 'needs_changes';
      await sendText(params.phone, alreadyAnsweredReply(stale ? null : outcome.current)).catch(() => {});
      return;
    }

    if (verdict === 'approved') {
      // Same consequence as approving on Slack: the task's subscribers are emailed. Only
      // the tap that won the conditional write reaches here, so this runs once per
      // approval however many times the button is tapped. Never throws.
      const { notifySubscribersOfApproval } = await import('./approvalSubscriberNotify');
      await notifySubscribersOfApproval(outcome.approval);
    }

    await sendText(
      params.phone,
      verdict === 'approved'
        ? 'Approved — thanks, that is recorded.'
        : 'Rejected — thanks, that is recorded.',
    ).catch((e) =>
      console.warn('[approval-notify] verdict confirmation failed to send:', e?.message || e),
    );
  } catch (error) {
    // Never throw into the webhook: a 500 makes Meta retry, and a retried tap would then
    // be told the approval is already answered — a confusing reply to a tap that failed.
    console.error(
      '[approval-notify] handling an approval button tap failed:',
      error instanceof Error ? error.message : error,
    );
  }
}
