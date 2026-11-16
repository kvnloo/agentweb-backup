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
  /**
   * Verify the caller owns the asset's existing approval and the execution before writing
   * anything. Always applied for a WhatsApp customer (whose record is written ahead of the
   * send and deleted if it fails); the channel-neutral route sets it for everyone. Not set by
   * the legacy Slack route, whose behaviour is deliberately unchanged.
   */
  enforceOwnership?: boolean;
  /**
   * Report a failed Slack send as ApprovalDeliveryFailedError instead of the raw error, so
   * the neutral route can answer 502 (hold) rather than a generic 500. Off by default: the
   * legacy Slack route keeps seeing the error it always saw.
   */
  typedFailures?: boolean;
}

export class ApprovalNotDeliveredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalNotDeliveredError';
  }
}

export class ApprovalForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalForbiddenError';
  }
}

export class ApprovalDeliveryFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDeliveryFailedError';
  }
}

async function loadAccount(userId: string): Promise<{ account: any | null; failed: boolean }> {
  try {
    const { userDb } = await import('./db');
    return { account: (await userDb.getUserById(userId)) ?? null, failed: false };
  } catch (error) {
    console.warn(
      '[approval-request] could not load the account:',
      error instanceof Error ? error.message : error,
    );
    return { account: null, failed: true };
  }
}

/**
 * The caller may only touch an approval, and only point at an execution, that is theirs.
 *
 * `assetUrl` is the primary key of the approvals table and `createApproval` is a put, so
 * without this a caller who supplies someone else's asset URL replaces that approval with a
 * pending one of their own — and, for a customer on WhatsApp, deletes it again if the send
 * fails. `executionId` decides whose task subscribers are emailed when an approval is
 * granted, so it must be the caller's too.
 */
export async function assertCallerOwnsApprovalTarget(
  userId: string,
  assetUrl: string,
  executionId?: string,
): Promise<void> {
  const existing = await approvalDb.getApproval(assetUrl);
  if (existing && existing.userId !== userId) {
    throw new ApprovalForbiddenError('That asset belongs to a different account.');
  }
  if (executionId) {
    const { taskDb } = await import('./db');
    const execution: any = await taskDb.getTaskExecutionById(executionId);
    if (!execution || execution.userId !== userId) {
      throw new ApprovalForbiddenError('That execution belongs to a different account.');
    }
  }
}

export async function requestApproval(
  request: ApprovalRequestInput,
): Promise<{ messageTs: string | null; approvalId: string; deliveredVia: string[] }> {
  const deliveredVia: string[] = [];
  const { account, failed: accountReadFailed } = await loadAccount(request.userId);

  // Fails CLOSED when the account cannot be read and no Slack channel was supplied. Falling
  // through would judge a reachable WhatsApp customer as having no channel (409 no_channel),
  // which the task engine answers by emailing their unreviewed output to subscribers. A
  // read that blipped must hold the output, not release it. With a Slack channel supplied
  // the old behaviour stands: that customer is asked on Slack as before.
  if (accountReadFailed && !request.channel) {
    throw new ApprovalDeliveryFailedError(
      'Could not determine how to reach this account, so the approval request was not sent.',
    );
  }

  const onWhatsApp = !!account && hasVerifiedWhatsApp(account);

  if (onWhatsApp || request.enforceOwnership) {
    await assertCallerOwnsApprovalTarget(request.userId, request.imageUrl, request.executionId);
  }

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
  let previousApproval: AssetApproval | null = null;
  if (onWhatsApp) {
    // The record is written BEFORE the message goes out. Its buttons cannot be taken back,
    // so one that reaches the customer ahead of its record can never be answered — and a
    // tap on it would otherwise have nothing to update.
    if (!approval) {
      // createApproval is a put on the asset URL, so it replaces any earlier record. Keep
      // that record: if this round reaches nobody it must be put back, not deleted.
      previousApproval = await approvalDb.getApproval(request.imageUrl);
      approval = await createRecord(null);
    }

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
    // Reached nobody. Undo a record written ahead of a send that then failed: an approval
    // nobody was shown can never be answered. If this asset URL already had a record, the
    // new one replaced it, so put the earlier one back — a failed re-request must not erase
    // an earlier verdict.
    if (approval) {
      const undo = previousApproval
        ? approvalDb.restoreApproval(previousApproval, approval.createdAt)
        : approvalDb.deleteApprovalIfUnanswered(request.imageUrl, approval.createdAt);
      await undo.catch((e) =>
        console.warn('[approval-request] could not undo unsent approval:', e?.message || e),
      );
    }
    // A Slack failure is surfaced unchanged so existing callers see the error they always saw.
    if (slackError) {
      if (request.typedFailures) {
        console.error(
          `[approval-request] Slack send failed for user ${request.userId}:`,
          (slackError as any)?.message || slackError,
        );
        throw new ApprovalDeliveryFailedError('The approval request could not be delivered to Slack.');
      }
      throw slackError;
    }
    if (whatsappFailed) {
      // The caller will hold the customer's output until this is resolved, and nothing here
      // retries. Say so where an operator can see it (user id and asset only — never the
      // number), so a customer who has opted out or has a standing Meta error is not held
      // silently and indefinitely.
      // And tell the owner by email (once a day at most): the buttons they were waiting for
      // never reached them, and nothing else will say so.
      try {
        const { notifyOwnerUnreachable } = await import('./whatsappOwnerNotices');
        await notifyOwnerUnreachable(request.userId);
      } catch {
        // Telling the owner is best-effort; the failure below is what the caller needs.
      }
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
