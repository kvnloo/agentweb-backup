import { WebClient } from '@slack/web-api';
import { resolveSlackApiUrl } from './slackService';
import { settingsService } from './settingsService';
import { getApproverChannel, getApproverReminderChannel, getApproverSlackUserId, getFallbackApproverSlackUserIds } from './approverDirectory';
import {
  approvalInboxService,
  type ApprovalDecision,
  type ApprovalDecisionApprover,
  type ApprovalDecisionVerdict,
} from './approvalInboxService';
import { executeResolvedDecision } from './approvalInboxExecution';

/**
 * ENG-1644 Phase C: ONE live, upsertable Slack message per approver,
 * re-rendered whole on every create/resolve event for that approver's
 * queue — deliberately NOT one message per decision, which would reproduce
 * the exact serial-prompt problem this ticket exists to kill.
 *
 * Rebuilds the message's blocks from the CURRENT DB state on every call
 * (via listPendingForApprover) rather than incrementally patching blocks
 * the way updateApprovalMessage (slackService.ts, one-asset case) does —
 * simpler and can't drift from what's actually still pending.
 */

let slackClient: WebClient | null = null;
if (process.env.SLACK_BOT_TOKEN) {
  const slackApiUrl = resolveSlackApiUrl();
  slackClient = slackApiUrl
    ? new WebClient(process.env.SLACK_BOT_TOKEN, { slackApiUrl })
    : new WebClient(process.env.SLACK_BOT_TOKEN);
}

function messageRefSettingName(approver: ApprovalDecisionApprover): string {
  return `approval_inbox_message_ref_${approver}`;
}

interface MessageRef {
  channel: string;
  messageTs: string;
}

async function getMessageRef(approver: ApprovalDecisionApprover): Promise<MessageRef | null> {
  const setting = await settingsService.getSetting(messageRefSettingName(approver));
  if (!setting?.settingValue) return null;
  try {
    const parsed = JSON.parse(setting.settingValue);
    return parsed?.channel && parsed?.messageTs ? parsed : null;
  } catch {
    return null;
  }
}

async function setMessageRef(approver: ApprovalDecisionApprover, ref: MessageRef): Promise<void> {
  await settingsService.setSetting(
    messageRefSettingName(approver),
    JSON.stringify(ref),
    `Live approval-inbox queue message for ${approver}`,
    'approval-inbox',
  );
}

// ENG-2159 follow-up: the domain is derived from the email at render time,
// never stored separately — a stored domain could drift from the real email
// if either were edited independently.
//
// The domain is repeated OUTSIDE the email, not bolded inline within it —
// Slack's mrkdwn auto-linkifies a bare email address before processing bold
// markers, so `local@*domain*` left a literal stray asterisk in the
// rendered message (the auto-link swallows the formatting, found live
// previewing this exact string in Block Kit Builder). Showing the domain a
// second time, fully outside the auto-linked span, is what actually makes
// the company jump out at a glance without fighting Slack's link detection.
function formatContactLine(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex === -1) return `:email: ${email}`;
  const domain = email.slice(atIndex + 1);
  return `:email: ${email} — *${domain}*`;
}

function decisionItemBlocks(decision: ApprovalDecision): any[] {
  const links = decision.evidencePacket?.links?.filter(Boolean) || [];
  if (decision.evidencePacket?.chatUrl) links.unshift(decision.evidencePacket.chatUrl);

  const summaryLines = [
    // ENG-2159: rendered as its own distinct, always-present line for any
    // decision created after this shipped — a real account got mistakenly
    // rejected because the account it concerned was buried in businessImpact
    // prose (or absent) rather than shown plainly.
    //
    // Still guarded (not unconditional): subjectLabel is required at CREATE
    // time (validateCreateRequest), but pre-existing records created before
    // this field existed have no value for it — an unconditional render
    // produced a literal "undefined" line in a real, live prod card (found
    // live-testing this exact fix, not assumed). Legacy records simply omit
    // the line, same fallback shape as the optional subjectContactEmail line.
    decision.subjectLabel ? `:office: *${decision.subjectLabel}*` : undefined,
    decision.subjectContactEmail ? formatContactLine(decision.subjectContactEmail) : undefined,
    `*${decision.businessImpact}*`,
    decision.evidencePacket?.researchSummary,
    links.length > 0 ? links.map((l) => `<${l}|link>`).join(' · ') : undefined,
  ].filter(Boolean);

  const optionLines = (decision.options || [])
    .map((o) => `${o.recommended ? '⭐ ' : ''}*${o.label}* — ${o.consequence}${o.recommended && o.why ? ` _(${o.why})_` : ''}`)
    .join('\n');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summaryLines.join('\n') + (optionLines ? `\n${optionLines}` : '') },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve', emoji: true },
          style: 'primary',
          action_id: 'approve_decision',
          value: JSON.stringify({ decisionId: decision.decisionId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 Edit', emoji: true },
          action_id: 'edit_decision',
          value: JSON.stringify({ decisionId: decision.decisionId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject', emoji: true },
          style: 'danger',
          action_id: 'reject_decision',
          value: JSON.stringify({ decisionId: decision.decisionId }),
        },
      ],
    },
    { type: 'divider' },
  ];
}

async function renderApproverQueueMessage(approver: ApprovalDecisionApprover): Promise<{ text: string; blocks: any[] }> {
  const decisions = await approvalInboxService.listPendingForApprover(approver);
  const slackUserId = await getApproverSlackUserId(approver);
  const mention = slackUserId ? `<@${slackUserId}>` : approver;

  if (decisions.length === 0) {
    return {
      text: `${approver}'s approval queue is empty.`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${mention} — no pending decisions right now.` } }],
    };
  }

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${mention} — *${decisions.length} pending decision${decisions.length === 1 ? '' : 's'}*` } },
    { type: 'divider' },
  ];
  for (const decision of decisions) blocks.push(...decisionItemBlocks(decision));

  return {
    text: `${approver} has ${decisions.length} pending decision${decisions.length === 1 ? '' : 's'}`,
    blocks,
  };
}

/**
 * Re-render and upsert an approver's queue message. Call this after ANY
 * create or resolve event affecting that approver's queue.
 *
 * Returns `{ posted: true }` when this call did a real, fresh chat.postMessage
 * (no tracked message yet, or the tracked update failed and it fell back to
 * posting) — a fresh post is itself a real notification. Returns
 * `{ posted: false }` when it updated the existing tracked message in place
 * (chat.update — no new-message notification). Callers that separately want
 * to guarantee a real notification (e.g. postDecisionAddedNotice) should skip
 * that when `posted` is already true, to avoid double-notifying.
 */
export async function upsertApproverQueueMessage(approver: ApprovalDecisionApprover): Promise<{ posted: boolean }> {
  if (!slackClient) {
    console.warn('[approval-inbox-slack] Slack client not initialized (SLACK_BOT_TOKEN unset) — skipping post');
    return { posted: false };
  }

  const { text, blocks } = await renderApproverQueueMessage(approver);
  const existingRef = await getMessageRef(approver);

  if (existingRef) {
    try {
      const result = await slackClient.chat.update({ channel: existingRef.channel, ts: existingRef.messageTs, text, blocks });
      if (result.ok) return { posted: false };
      console.warn('[approval-inbox-slack] chat.update failed, will post a fresh message:', result.error);
    } catch (err: any) {
      console.warn('[approval-inbox-slack] chat.update threw, will post a fresh message:', err?.message || err);
    }
  }

  const channel = await getApproverChannel(approver);
  const result = await slackClient.chat.postMessage({ channel, text, blocks });
  if (!result.ok || !result.ts) {
    throw new Error(`Failed to post approval-inbox message for ${approver}: ${result.error}`);
  }
  // Review fix: chat.postMessage has ALREADY genuinely succeeded at this
  // point — a failure in this bookkeeping write must not make the caller
  // think nothing was posted (it was), which would otherwise cause a
  // duplicate postDecisionAddedNotice on top of a post that already
  // happened. Ref-tracking failing just means the NEXT upsert won't find it
  // and posts fresh again — a real but much smaller cost than a guaranteed
  // double-notify.
  try {
    await setMessageRef(approver, { channel, messageTs: result.ts });
  } catch (err: any) {
    console.warn('[approval-inbox-slack] posted fresh message but failed to save its ref:', err?.message || err);
  }
  return { posted: true };
}

export const APPROVAL_DECISION_ACTION_IDS = ['approve_decision', 'reject_decision', 'edit_decision'] as const;
export type ApprovalDecisionActionId = typeof APPROVAL_DECISION_ACTION_IDS[number];

/**
 * The real, currently-absent gap the plan called out: approve_asset's own
 * handler has zero identity check today (only Slack's own token/team-id are
 * verified). Refuses any clicking Slack user who isn't the decision's named
 * approver AND isn't on the configured fallback allowlist.
 */
export async function isAuthorizedApprover(decision: ApprovalDecision, clickingSlackUserId: string): Promise<boolean> {
  if (!decision.approver) return false;
  const approverSlackId = await getApproverSlackUserId(decision.approver);
  if (approverSlackId && approverSlackId === clickingSlackUserId) return true;
  const fallbackIds = await getFallbackApproverSlackUserIds();
  return fallbackIds.includes(clickingSlackUserId);
}

/**
 * Reject/Edit both need free text (reject's is optional context, edit's is
 * the mandatory correction) — same modal shape as slackService.ts's own
 * openRejectModal, generalized to carry a decisionId instead of an assetUrl.
 */
export async function openDecisionVerdictModal(
  triggerId: string,
  decisionId: string,
  verdict: 'reject' | 'edit',
): Promise<void> {
  if (!slackClient) throw new Error('Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.');

  const isEdit = verdict === 'edit';
  await slackClient.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'approval_decision_verdict_modal',
      title: { type: 'plain_text', text: isEdit ? 'Chat about this' : 'Reject' },
      submit: { type: 'plain_text', text: isEdit ? 'Send' : 'Reject' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({ decisionId, verdict }),
      blocks: [
        {
          type: 'input',
          block_id: 'decision_free_text_input',
          optional: !isEdit,
          element: {
            type: 'plain_text_input',
            action_id: 'decision_free_text',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: isEdit ? "What should change before this is re-approved?" : 'Optional — why is this rejected?',
            },
          },
          label: { type: 'plain_text', text: isEdit ? 'Correction' : 'Reason' },
        },
      ],
    },
  });
}

/**
 * Shared claim path for both the direct Approve button and the two
 * modal-driven verdicts. Resolves the durable record, executes it (Phase D —
 * plan_choice/customer_* notify the origin session; meta_write is a no-op
 * pending a real producer, see approvalInboxExecution.ts), then refreshes
 * the approver's Slack surfaces so the resolution is visible immediately.
 */
export async function resolveApprovalDecision(
  decisionId: string,
  verdict: ApprovalDecisionVerdict,
  answeredBy: string,
  freeText?: string,
): Promise<{ claimed: true; decision: ApprovalDecision } | { claimed: false; reason: string }> {
  const result = await approvalInboxService.claimDecision(decisionId, verdict, answeredBy, freeText);
  if (!result.claimed) return result;

  // The claim itself is already durably committed above — a failure in
  // execution or in the Slack refresh must never surface as a failed claim
  // (same non-fatal principle as stage_pending_decision's own post-create
  // refresh). Without this, a missing channel/Slack config — or a failed
  // origin-session notify — would make a SUCCESSFUL approve bubble up as a
  // 500 to the caller, even though the DB already reflects it.
  const { decision } = result;
  try {
    // executeResolvedDecision already catches everything internally and is
    // not expected to throw — wrapped here too anyway, defense-in-depth
    // against the exact bug class just found and fixed for the Slack
    // refresh below: nothing downstream of a committed claim may mask it.
    await executeResolvedDecision(decision);
  } catch (err: any) {
    console.warn('[approval-inbox-slack] claim succeeded but execution failed:', err?.message || err);
  }

  if (decision.approver) {
    // Review fix: separate try/catches — a queue-refresh failure (e.g.
    // getApproverChannel throwing) must not silently skip the resolution
    // notice too. Same class of bug already fixed for stage_pending_decision
    // and the expiry sweep; this call site was missed.
    try {
      await upsertApproverQueueMessage(decision.approver);
    } catch (err: any) {
      console.warn('[approval-inbox-slack] claim succeeded but queue refresh failed:', err?.message || err);
    }
    try {
      await postDecisionResolvedNotice(decision.approver, decision);
    } catch (err: any) {
      console.warn('[approval-inbox-slack] claim succeeded but resolution notice failed:', err?.message || err);
    }
  }
  return result;
}

/**
 * Shared scaffold for every one-off, always-fresh notice this file posts
 * (resolved / added / expired) — same slackClient guard, channel lookup,
 * postMessage call, and swallow-and-warn failure handling; only the message
 * text differs per caller (review fix — 3rd near-identical copy was the
 * signal this needed factoring, not 2). Takes a text BUILDER, not a plain
 * string, so any async work needed to build the text (e.g. postDecisionAddedNotice's
 * mention lookup) still runs inside both the slackClient guard (no wasted
 * work when Slack is disabled) and the try/catch (still failure-isolated) —
 * a plain-string signature would silently move that work outside both.
 */
async function postApproverNotice(
  approver: ApprovalDecisionApprover,
  buildText: () => Promise<string> | string,
  failureLabel: string,
  resolveChannel: (a: ApprovalDecisionApprover) => Promise<string> = getApproverChannel,
): Promise<void> {
  if (!slackClient) return;
  try {
    const text = await buildText();
    const channel = await resolveChannel(approver);
    await slackClient.chat.postMessage({ channel, text });
  } catch (err: any) {
    console.warn(`[approval-inbox-slack] failed to post ${failureLabel}:`, err?.message || err);
  }
}

/**
 * ENG-1853: the Approval Desk's one concise reminder per packet — an @-mention of the assigned
 * reviewer plus the portal link, in the same channel and style as the eval queue's "one concise
 * reviewer assignment/link" message. Deliberately no per-item text or buttons: the Desk is where the
 * context and the decision live, Slack only says "something is waiting for you".
 */
export async function postManifestReadyNotice(
  approver: ApprovalDecisionApprover,
  packet: { manifestId: string; itemCount: number; accountLabel?: string },
): Promise<void> {
  await postApproverNotice(
    approver,
    async () => {
      const slackUserId = await getApproverSlackUserId(approver);
      const mention = slackUserId ? `<@${slackUserId}>` : approver;
      // A reviewer must never get a dead localhost link: outside dev, no portal URL means no message.
      const configured = process.env.FRONTEND_URL;
      if (!configured && process.env.NODE_ENV === 'production') throw new Error('FRONTEND_URL is not set, so the Approval Desk link would be wrong');
      const base = (configured || 'http://localhost:5173').replace(/\/+$/, '');
      const what = `${packet.itemCount} Meta Ads change${packet.itemCount === 1 ? '' : 's'}${packet.accountLabel ? ` for ${packet.accountLabel}` : ''}`;
      return `🔔 ${mention} — ${what} waiting for your review in the Approval Desk: ${base}/approval-desk/${encodeURIComponent(packet.manifestId)}`;
    },
    'packet-ready notice',
    getApproverReminderChannel,
  );
}

export async function postDecisionResolvedNotice(approver: ApprovalDecisionApprover, decision: ApprovalDecision): Promise<void> {
  // The re-rendered queue message already reflects the resolution (the item
  // simply disappears from the pending list) — this is an additional,
  // explicit confirmation in-channel so the resolution isn't silent.
  const verdictLabel = decision.verdict === 'approve' ? '✅ Approved' : decision.verdict === 'reject' ? '❌ Rejected' : '💬 Edited';
  await postApproverNotice(approver, () => `${verdictLabel}: ${decision.businessImpact}`, 'resolution notice');
}

/**
 * ENG-1644 gap-closing round: real production testing found the queue
 * message alone doesn't reliably reach an approver — upsertApproverQueueMessage
 * updates the SAME message in place (chat.update) after the first decision
 * ever staged to an approver, and Slack does not push-notify or re-surface a
 * channel as unread for a message edit the way it does for a genuinely new
 * message. Call this right after upsertApproverQueueMessage on every NEW
 * decision (never on resolution — postDecisionResolvedNotice already covers
 * that) so a second/third/etc. pending decision still produces a real,
 * always-new chat.postMessage — a real notification, not a silent edit.
 */
export async function postDecisionAddedNotice(approver: ApprovalDecisionApprover, decision: ApprovalDecision): Promise<void> {
  await postApproverNotice(
    approver,
    async () => {
      const slackUserId = await getApproverSlackUserId(approver);
      const mention = slackUserId ? `<@${slackUserId}>` : approver;
      return `🔔 ${mention} — new decision: ${decision.businessImpact}`;
    },
    'new-decision notice',
  );
}

/**
 * Review fix: the expiry sweep was only re-rendering the queue message
 * (chat.update) when a decision expired — the exact "an edit alone doesn't
 * notify" gap postDecisionAddedNotice exists to close, left open for
 * expiry. Without this, an approver has no way to tell "this expired" apart
 * from "someone else already claimed it" or a rendering glitch — the item
 * just silently vanishes from the queue.
 */
export async function postDecisionExpiredNotice(approver: ApprovalDecisionApprover, decision: ApprovalDecision): Promise<void> {
  await postApproverNotice(approver, () => `⏳ Expired with no answer: ${decision.businessImpact}`, 'expiry notice');
}
