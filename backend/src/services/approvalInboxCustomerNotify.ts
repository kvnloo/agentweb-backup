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
    `${decision.subjectLabel}\n` +
    (decision.subjectContactEmail ? `(${decision.subjectContactEmail})\n` : '') +
    `\n${decision.businessImpact}\n\n` +
    `Please take care of this here: ${decision.customerActionUrl}\n\n` +
    `If you weren't expecting this, reply to this email and we'll help.`;
  const html =
    `<p><strong>${decision.subjectLabel}</strong>` +
    (decision.subjectContactEmail ? ` (${decision.subjectContactEmail})` : '') +
    `</p>` +
    `<p>${decision.businessImpact}</p>` +
    `<p><a href="${decision.customerActionUrl}">Take care of this now</a></p>` +
    `<p>If you weren't expecting this, reply to this email and we'll help.</p>`;

  await emailService.sendEmail(customerEmail, subject, text, html);
}

/**
 * Review fix (round 4): notifyCustomerOfPendingCredentialDecision fires once
 * at creation, but nothing customer-facing ever fired again — a customer who
 * never reconnected got exactly one email, then silence. The expiry sweep's
 * own notice (notifyOriginSessionOfExpiry, approvalInboxExecution.ts) only
 * writes to the internal chat-session history, not something a customer
 * checking their email would ever see. Without this, the exact "dies
 * silently" gap this PR's title claims to close was left open for the one
 * audience most likely to actually be waiting on a real answer.
 */
export async function notifyCustomerOfExpiredCredentialDecision(decision: ApprovalDecision): Promise<void> {
  if (decision.gateType !== 'customer_credential') return;
  if (!decision.customerId) return;

  const user = await userDb.getUserById(decision.customerId);
  const customerEmail = decision.customerEmail || (user as any)?.email;

  if (!customerEmail) {
    await alertNoResolvableCustomer(decision);
    return;
  }

  const subject = 'Your AgentWeb reconnect window has closed';
  const text =
    `${decision.subjectLabel}\n` +
    (decision.subjectContactEmail ? `(${decision.subjectContactEmail})\n` : '') +
    `\n${decision.businessImpact}\n\n` +
    `The window to take care of this has closed without a response, so it's no longer active. ` +
    `If this still matters, let us know and we'll raise it again.\n\n` +
    `If you weren't expecting this, reply to this email and we'll help.`;
  const html =
    `<p><strong>${decision.subjectLabel}</strong>` +
    (decision.subjectContactEmail ? ` (${decision.subjectContactEmail})` : '') +
    `</p>` +
    `<p>${decision.businessImpact}</p>` +
    `<p>The window to take care of this has closed without a response, so it's no longer active. ` +
    `If this still matters, let us know and we'll raise it again.</p>` +
    `<p>If you weren't expecting this, reply to this email and we'll help.</p>`;

  await emailService.sendEmail(customerEmail, subject, text, html);
}

/**
 * Gap-closing round: called from a real OAuth reconnect callback (Meta,
 * LinkedIn) once a connection is genuinely re-established. Finds EVERY
 * matching pending customer_credential decision and auto-claims each one —
 * closes the loop that previously left every customer_credential decision
 * as a one-way notification that could never resolve to "done".
 * Self-contained (own try/catch, never throws) since this is called from
 * inside a real reconnect handler — a failure here must never break the
 * actual reconnect response.
 *
 * Resolves ALL matches, not just the first (real bug found live on prod,
 * 2026-09-25): a customer can end up with more than one pending decision for
 * the same platform+account (e.g. a duplicate staged before the first was
 * answered). One reconnect genuinely resolves every one of them — a customer
 * who reconnects once shouldn't have a second, newer decision sit stuck
 * until it silently expires and the sweep emails a false "your window
 * closed" notice, even though they already fixed the connection. Each
 * decision gets its own try/catch so one failing claim (a lost race, a
 * transient error) never stops the rest from being attempted.
 *
 * skipExpiryCheck:true (review fix) — this function only ever runs after a
 * REAL, just-succeeded reconnect; the expiry guard exists to reject stale
 * human UI clicks, not to invalidate ground truth that arrived a little
 * late. Without this, a reconnect landing in the ~1hr window between
 * expiresAt and the next sweep tick lost the claim silently, and the sweep
 * later emailed the customer a false "your window closed" despite them
 * having already fixed it.
 */
export async function autoResolveCredentialDecisionOnReconnect(
  customerId: string,
  platform: string,
  accountId: string,
): Promise<void> {
  try {
    const decisions = await approvalInboxService.findPendingCredentialDecisions(customerId, platform, accountId);

    for (const decision of decisions) {
      try {
        const result = await approvalInboxService.claimDecision(decision.decisionId, 'approve', 'system:auto-reconnect', undefined, { skipExpiryCheck: true });
        if (!result.claimed) {
          // Lost a race on THIS decision — already resolved some other way,
          // or the sweep beat this reconnect to expiring it outright (a
          // real, if now much narrower, remaining race). Not an error;
          // still attempt the rest of the matches.
          continue;
        }
        await executeResolvedDecision(result.decision);
      } catch (err: any) {
        console.warn(
          '[approval-inbox-customer-notify] failed to auto-resolve one credential decision on reconnect:',
          { customerId, platform, accountId, decisionId: decision.decisionId },
          err?.message || err,
        );
      }
    }
  } catch (err: any) {
    console.warn(
      '[approval-inbox-customer-notify] failed to auto-resolve credential decisions on reconnect:',
      { customerId, platform, accountId },
      err?.message || err,
    );
  }
}

/**
 * Review fix: this exact try/catch-and-log wrapper around
 * autoResolveCredentialDecisionOnReconnect was independently duplicated in
 * metaAuth.ts, linkedinAuth.ts, and linkedInAdsAuth.ts (3 near-identical
 * copies, flagged by 4 separate review passes across this PR) — any future
 * fix to the wrapping/logging behavior had to be applied in three places by
 * hand. autoResolveCredentialDecisionOnReconnect itself already never
 * throws; this wrapper exists only so a caller can label its own failures
 * distinctly (e.g. "[Meta Connect Ad Accounts]" vs "[LinkedIn Ads Connect]")
 * without re-implementing the try/catch shape at every call site. Callers
 * still reach this via a dynamic `await import(...)` (see any call site's
 * own comment for why — this module's own transitive chain is too heavy for
 * a route file's static load) and still wrap THAT import in their own
 * try/catch, since a module-load failure happens before this function is
 * ever reachable.
 */
export async function safeAutoResolveCredentialDecision(label: string, userId: string, platform: string, accountId: string): Promise<void> {
  try {
    await autoResolveCredentialDecisionOnReconnect(userId, platform, accountId);
  } catch (err: any) {
    console.warn(`[${label}] auto-resolve credential decision failed:`, err?.message || err);
  }
}
