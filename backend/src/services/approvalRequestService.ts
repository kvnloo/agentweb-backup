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
 * An approval is delivered if it reached the customer on ANY channel they have. It
 * fails only when it reached nobody — and then no record is written, because an
 * approval nobody was shown can never be answered.
 */
import { approvalDb, type AssetApproval } from './approvalDb';

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

export async function requestApproval(
  request: ApprovalRequestInput,
): Promise<{ messageTs: string | null; approvalId: string; deliveredVia: string[] }> {
  const deliveredVia: string[] = [];

  // ── Slack, only for a customer who is on Slack ──
  let slackMessageTs: string | null = null;
  let slackError: unknown = null;
  if (request.channel) {
    try {
      const { sendApprovalRequest } = await import('./slackService');
      slackMessageTs = (await sendApprovalRequest({ ...request, channel: request.channel }))
        .messageTs;
      deliveredVia.push('slack');
    } catch (error) {
      slackError = error;
    }
  }

  // ── WhatsApp, only for a customer who has connected a number ──
  // The import is inside the guard as well as the call: a module-load failure rejects
  // before any of the notifier's own error handling runs.
  try {
    const { notifyApprovalOnWhatsApp } = await import('./approvalChannelNotifier');
    const delivered = await notifyApprovalOnWhatsApp({
      userId: request.userId,
      assetType: request.assetType,
      filename: request.filename,
      assetUrl: request.imageUrl,
    });
    if (delivered) deliveredVia.push('whatsapp');
  } catch (notifyError: any) {
    console.warn(
      '[approval-request] WhatsApp approval notification could not be dispatched:',
      notifyError?.message || notifyError,
    );
  }

  if (deliveredVia.length === 0) {
    // Reached nobody. A Slack failure is surfaced unchanged so existing callers see the
    // error they always saw; with no Slack channel there is no such error to pass on.
    if (slackError) throw slackError;
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

  const approval: AssetApproval = await approvalDb.createApproval({
    assetUrl: request.imageUrl,
    filename: request.filename,
    assetType: request.assetType as any, // string -> AssetType
    executionId: request.executionId || '',
    userId: request.userId,
    // Empty, not absent, for a customer who is not on Slack: every reader of this
    // record already treats a falsy channel as "no Slack thread to post into".
    slackChannel: request.channel || '',
    slackChannelName: request.channelName || request.channel || '',
    slackMessageTs,
    note: request.note,
  });

  console.log(`✅ Approval request delivered via ${deliveredVia.join(' + ')} and stored`);

  return {
    messageTs: slackMessageTs,
    approvalId: approval.assetUrl, // assetUrl is the primary key
    deliveredVia,
  };
}
