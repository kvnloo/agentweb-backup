/**
 * Asking a customer to approve an asset — on whichever channel they use (ENG-273).
 *
 * Slack and WhatsApp are two separate features. A customer connects ONE of them, so
 * neither may depend on the other: a WhatsApp customer has no Slack channel, and a Slack
 * customer has no WhatsApp number. This is the one place that knows about both.
 *
 * It used to live in slackService and require a Slack channel, which made a Slack
 * channel a precondition for being asked to approve anything at all.
 *
 * An approval is delivered if it reached the customer on the channel they have. It fails
 * when it reached nobody, and the failure says WHICH of two things happened, because the
 * caller must treat them differently:
 *
 *  - ApprovalNotDeliveredError: the account has no channel to be asked on at all.
 *  - ApprovalDeliveryFailedError: the account HAS one (a verified WhatsApp number) and the
 *    send failed. The caller must hold the work, as it does for a Slack send that fails,
 *    rather than treat the customer as unreachable and let unapproved output through.
 */
import { approvalDb, type AssetApproval } from './approvalDb';
import { hasVerifiedWhatsApp } from './messagingChannelService';

export interface ApprovalRequestInput {
  executionId?: string;
  /** The asset URL. Named for history: it is the primary key of the approval. */
  imageUrl: string;
  filename: string;
  assetType: string;
  /** The customer account that owns the asset and is being asked to approve it. */
  userId: string;
  /** Slack channel, for customers on Slack. Absent for everyone else. */
  channel?: string | null;
  channelName?: string;
  note?: string;
}

export class ApprovalNotDeliveredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalNotDeliveredError';
  }
}

export class ApprovalDeliveryFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDeliveryFailedError';
  }
}

async function loadAccount(userId: string): Promise<any | null> {
  try {
    const { userDb } = await import('./db');
    return (await userDb.getUserById(userId)) ?? null;
  } catch (error) {
    // Falls toward the behaviour before WhatsApp existed: judge the account as having no
    // WhatsApp number and use the Slack channel the caller supplied.
    console.warn(
      '[approval-request] could not load the account; treating it as not on WhatsApp:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function requestApproval(
  request: ApprovalRequestInput,
): Promise<{ messageTs: string | null; approvalId: string; deliveredVia: string[] }> {
  const deliveredVia: string[] = [];
  const account = await loadAccount(request.userId);
  const onWhatsApp = !!account && hasVerifiedWhatsApp(account);

  // A customer on WhatsApp is not also posted to in Slack, even when the task they set up
  // names a Slack channel (task-level channels are typed in per task and outlive a switch
  // of platform). One platform per customer.
  const slackChannel = onWhatsApp ? null : request.channel || null;

  // ── Slack, only for a customer who is on Slack ──
  let slackMessageTs: string | null = null;
  let slackError: unknown = null;
  if (slackChannel) {
    try {
      const { sendApprovalRequest } = await import('./slackService');
      slackMessageTs = (await sendApprovalRequest({ ...request, channel: slackChannel }))
        .messageTs;
      deliveredVia.push('slack');
    } catch (error) {
      slackError = error;
    }
  }

  const createRecord = (messageTs: string | null): Promise<AssetApproval> =>
    approvalDb.createApproval({
      assetUrl: request.imageUrl,
      filename: request.filename,
      assetType: request.assetType as any, // string -> AssetType
      executionId: request.executionId || '',
      userId: request.userId,
      // Empty, not absent, for a customer who is not on Slack: every reader of this
      // record already treats a falsy channel as "no Slack thread to post into".
      slackChannel: slackChannel || '',
      slackChannelName: request.channelName || slackChannel || '',
      slackMessageTs: messageTs,
      note: request.note,
    });

  // For a Slack customer the record is written straight after the post, exactly where it
  // always was: a click on the Slack message can never find no record.
  let approval: AssetApproval | null = null;
  if (deliveredVia.includes('slack')) approval = await createRecord(slackMessageTs);

  // ── WhatsApp, only for a customer who has connected a number ──
  let whatsappFailed = false;
  if (onWhatsApp) {
    // The record is written BEFORE the message goes out. Its buttons cannot be taken back,
    // so one that reaches the customer ahead of its record can never be answered — and a
    // tap on it would otherwise have nothing to update.
    if (!approval) approval = await createRecord(null);

    // The import is inside the guard as well as the call: a module-load failure rejects
    // before any of the notifier's own error handling runs.
    try {
      const { notifyApprovalOnWhatsApp } = await import('./approvalChannelNotifier');
      const outcome = await notifyApprovalOnWhatsApp({
        userId: request.userId,
        user: account,
        assetType: request.assetType,
        filename: request.filename,
        assetUrl: request.imageUrl,
      });
      if (outcome === 'delivered') deliveredVia.push('whatsapp');
      else if (outcome === 'failed') whatsappFailed = true;
    } catch (notifyError: any) {
      whatsappFailed = true;
      console.warn(
        '[approval-request] WhatsApp approval notification could not be dispatched:',
        notifyError?.message || notifyError,
      );
    }
  }

  if (deliveredVia.length === 0) {
    // Reached nobody. Remove a record written ahead of a send that then failed: an
    // approval nobody was shown can never be answered. (If this asset URL already had a
    // record, writing the new one replaced it — approving the same asset again is a new
    // round — so nothing older is lost by removing it.)
    if (approval) {
      await approvalDb
        .deleteApproval(request.imageUrl)
        .catch((e) => console.warn('[approval-request] could not remove unsent approval:', e?.message || e));
    }
    // A Slack failure is surfaced unchanged so existing callers see the error they always saw.
    if (slackError) throw slackError;
    if (whatsappFailed) {
      // The caller will hold the customer's output until this is resolved, and nothing here
      // retries. Say so where an operator can see it (user id and asset only — never the
      // number), so a customer who has opted out or has a standing Meta error is not held
      // silently and indefinitely.
      console.error(
        `[approval-request] could not deliver an approval to user ${request.userId} on WhatsApp; ` +
          `their output for ${request.imageUrl} is being held until this is resolved`,
      );
      throw new ApprovalDeliveryFailedError(
        'The approval request could not be delivered to the connected WhatsApp number.',
      );
    }
    throw new ApprovalNotDeliveredError(
      'This account has no connected channel to receive an approval request on.',
    );
  }
  if (slackError) {
    console.warn(
      '[approval-request] Slack post failed but another channel delivered — approval is tracked:',
      (slackError as any)?.message || slackError,
    );
  }

  console.log(`✅ Approval request delivered via ${deliveredVia.join(' + ')} and stored`);

  return {
    messageTs: slackMessageTs,
    approvalId: (approval as AssetApproval).assetUrl, // assetUrl is the primary key
    deliveredVia,
  };
}
