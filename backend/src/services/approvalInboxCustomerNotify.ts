import { emailService } from './emailService';
import { userDb } from './db';
import { approvalInboxService, type ApprovalDecision } from './approvalInboxService';
import { executeResolvedDecision } from './approvalInboxExecution';

/**
 * ENG-1644 Phase E (narrow scope): customer-facing delivery for
 * gateType === 'customer_credential' decisions only. customer_confirmation
 * has zero existing UI/notification precedent in this codebase (confirmed
 * by a scoping pass — no generic customer inbox exists anywhere) and is
 * deliberately NOT handled here; stage_pending_decision refuses it outright
 * rather than accept it into a dead end (same treatment meta_write gets in
 * Phase B/D).
 *
 * Generalizes linkedInDisconnectNotifyService.ts's proven pattern (email
 * with a deep link into the existing connected-accounts settings UI) rather
 * than inventing a new customer-portal page: the caller supplies the exact
 * `customerActionUrl` (e.g. `/settings?tab=connected-accounts&platform=...`)
 * instead of this module knowing how to build one per platform. No
 * cooldown/dedup state is needed here unlike that service — this fires
 * once at decision-create time, not repeatedly from a flapping cron, and
 * createDecision's own idempotent-by-digest-or-UUID create already makes
 * "notify twice for the same decision" a non-issue.
 */

async function alertNoResolvableCustomer(decision: ApprovalDecision): Promise<void> {
  await emailService.sendOncallAlert(
    `Approval inbox: no resolvable email for customer ${decision.customerId}`,
    `Decision ${decision.decisionId} (${decision.businessImpact}) needs the customer to act, ` +
      `but no email could be resolved for customerId=${decision.customerId}. ` +
      `The customer cannot be notified; this needs manual follow-up.`,
    { decisionId: decision.decisionId, customerId: decision.customerId },
  );
}

export async function notifyCustomerOfPendingCredentialDecision(decision: ApprovalDecision): Promise<void> {
  if (decision.gateType !== 'customer_credential') return;
  if (!decision.customerId || !decision.customerActionUrl) return;

  const user = await userDb.getUserById(decision.customerId);
  const customerEmail = decision.customerEmail || (user as any)?.email;

  if (!customerEmail) {
    await alertNoResolvableCustomer(decision);
    return;
  }

  const subject = 'Action needed on your AgentWeb account';
  const text =
    `${decision.businessImpact}\n\n` +
    `Please take care of this here: ${decision.customerActionUrl}\n\n` +
    `If you weren't expecting this, reply to this email and we'll help.`;
  const html =
    `<p>${decision.businessImpact}</p>` +
    `<p><a href="${decision.customerActionUrl}">Take care of this now</a></p>` +
    `<p>If you weren't expecting this, reply to this email and we'll help.</p>`;

  await emailService.sendEmail(customerEmail, subject, text, html);
}

/**
 * Gap-closing round: called from a real OAuth reconnect callback (Meta,
 * LinkedIn) once a connection is genuinely re-established. Finds the
 * matching pending customer_credential decision (if any) and auto-claims
 * it — closes the loop that previously left every customer_credential
 * decision as a one-way notification that could never resolve to "done".
 * Self-contained (own try/catch, never throws) since this is called from
 * inside a real reconnect handler — a failure here must never break the
 * actual reconnect response.
 */
export async function autoResolveCredentialDecisionOnReconnect(
  customerId: string,
  platform: string,
  accountId: string,
): Promise<void> {
  try {
    const decision = await approvalInboxService.findPendingCredentialDecision(customerId, platform, accountId);
    if (!decision) return;

    const result = await approvalInboxService.claimDecision(decision.decisionId, 'approve', 'system:auto-reconnect');
    if (!result.claimed) {
      // Lost a race — already resolved some other way, or expired. Nothing
      // left to do; not an error.
      return;
    }
    await executeResolvedDecision(result.decision);
  } catch (err: any) {
    console.warn(
      '[approval-inbox-customer-notify] failed to auto-resolve credential decision on reconnect:',
      { customerId, platform, accountId },
      err?.message || err,
    );
  }
}
