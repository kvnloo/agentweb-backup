/**
 * Drip sequence worker — advances due enrollment steps.
 *
 * Call `processDueEnrollments()` on a regular interval (e.g. every 5 minutes)
 * from the task monitor or a separate cron.  Each invocation:
 *   1. Fetches all active enrollments whose nextSendAt <= now
 *   2. For each enrollment:
 *      a. Load the sequence definition
 *      b. Check exit conditions (lifecycle change, email engagement, unsubscribe)
 *      c. If exiting: mark exited
 *      d. Otherwise: send the email via Resend, advance to next step (or complete)
 */

import { dripSequenceDb, DripSequence, SequenceEnrollment, StepCondition, SequenceChannel } from './dripSequenceDb';
import { isReachableEmail, canonicalLinkedInProfile } from '../utils/leadReachability';
import { isPushedToSmartlead } from './smartleadMarkers';
import { sendAsSender, SenderDailyLimitExceededError } from './sendAsSender';
import { linkedInOutreachService } from './linkedInOutreachService';
import { crmDb, userDb } from './db';
import { emailEventsDb } from './emailEventsDb';
import { isDoNotContact } from '../utils/leadContactStatus';
import { substituteVariables, injectUnsubscribeUrl, rewriteS3ImageUrls, normalizeYoutubeUrls } from '../utils/emailVariables';
import { loadSenderConfig as loadCrmSenderConfig } from './crmSenderService';
import { CrmSender } from './crmSenderTypes';
import { settingsService } from './settingsService';
import { v4 as uuidv4 } from 'uuid';
import { isSuspectedMachineEngagement, parseResendTimestamp } from './machineEngagement';
import { selectEngagementExitTrigger } from './dripEngagementExit';

// Identifies this process for the claimedBy field — mirrors
// socialEngagementExecutor.ts's INSTANCE_ID, used for log correlation only.
const INSTANCE_ID = uuidv4();

const PINNED_ACCOUNT_SNOOZE_MS = 30 * 60 * 1000;

/**
 * ENG-2529: the shared LinkedIn write gate (daily volume cap + hourly pacer) refused this step's send.
 * Not a failure of the step: the enrollment is deferred (snoozed, step NOT advanced) and retried later.
 */
export class LinkedInWriteDeferredError extends Error {
  constructor(public readonly gate: string, public readonly reason: string, public readonly accountId: string) {
    super(`LinkedIn write deferred by ${gate} on account ${accountId}: ${reason}`);
    this.name = 'LinkedInWriteDeferredError';
  }
}

/** How long to defer an enrollment whose LinkedIn send was refused by the hourly pacer. */
export const LINKEDIN_PACER_DEFER_MS = 30 * 60 * 1000;

/** Retry time for a deferred LinkedIn send: next UTC midnight for the daily cap, else a short pacer backoff. */
export function linkedInDeferRetryAt(gate: string, now: Date = new Date()): string {
  if (gate === 'daily_volume') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  }
  return new Date(now.getTime() + LINKEDIN_PACER_DEFER_MS).toISOString();
}

/** A LinkedIn step pins an account the sequence owner no longer owns or shares. */
export class PinnedLinkedInAccountNotConnectedError extends Error {
  constructor(stepNumber: number, userId: string) {
    super(`LinkedIn step ${stepNumber} references an account that is not connected to user ${userId}`);
    this.name = 'PinnedLinkedInAccountNotConnectedError';
  }
}

export async function processDueEnrollments(): Promise<{
  processed: number;
  sent: number;
  /** Steps the LEAD could not receive. Distinct from `errors`: nothing is wrong. */
  skipped: number;
  exited: number;
  errors: number;
}> {
  const stats = { processed: 0, sent: 0, skipped: 0, exited: 0, errors: 0 };

  let due: SequenceEnrollment[];
  try {
    due = await dripSequenceDb.getAllDueEnrollments();
  } catch (err) {
    console.error('[dripWorker] Failed to fetch due enrollments:', err);
    return stats;
  }

  for (const enrollment of due) {
    // Claim before sending so a process killed between the send and the
    // advance/complete write doesn't get its step re-sent by the very next
    // tick (or by another instance). A claim self-heals after its stale
    // window, so a crash never strands the enrollment permanently.
    let claimed: boolean;
    try {
      claimed = await dripSequenceDb.claimEnrollment(enrollment.enrollmentId, INSTANCE_ID);
    } catch (err) {
      console.error(`[dripWorker] Failed to claim enrollment ${enrollment.enrollmentId}:`, err);
      continue;
    }
    if (!claimed) continue; // another instance or a recent crash still holds this enrollment

    stats.processed++;
    try {
      await processEnrollment(enrollment, stats);
    } catch (err: any) {
      stats.errors++;
      console.error(`[dripWorker] Error processing enrollment ${enrollment.enrollmentId}:`, err);
      // Not-connected: snooze 6 hours so we stop hammering every 5 minutes.
      // The LinkedIn connection sync will re-enroll via auto-enroll once the
      // connection is accepted, but for manually enrolled leads we use backoff.
      if (err?.message?.includes('not a 1st-degree connection')) {
        const retryAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
        await dripSequenceDb.snoozeEnrollment(enrollment.enrollmentId, retryAt).catch(() => {});
        console.log(`[dripWorker] Snoozed enrollment ${enrollment.enrollmentId} until ${retryAt} (not yet connected)`);
      } else if (err instanceof PinnedLinkedInAccountNotConnectedError) {
        // A config problem the owner has to fix (re-pick or reconnect the account). Retrying every 5-minute
        // tick cannot succeed and only burns claims and log noise, so back off. Deliberately SHORT (30 min,
        // not the 6h used for 'not yet connected'): editing a sequence does not reset an enrollment's
        // nextSendAt, so a long snooze would delay sending long after the user has fixed the step.
        const retryAt = new Date(Date.now() + PINNED_ACCOUNT_SNOOZE_MS).toISOString();
        await dripSequenceDb.snoozeEnrollment(enrollment.enrollmentId, retryAt).catch(() => {});
        console.log(`[dripWorker] Snoozed enrollment ${enrollment.enrollmentId} until ${retryAt} (pinned LinkedIn account not connected)`);
      } else if (err instanceof LinkedInWriteDeferredError) {
        // ENG-2529: the shared LinkedIn gate refused the send. Defer — do not fail, do not advance —
        // so the step is sent once the pacer/daily cap has room.
        const retryAt = linkedInDeferRetryAt(err.gate);
        await dripSequenceDb.snoozeEnrollment(enrollment.enrollmentId, retryAt).catch(() => {});
        console.log(`[dripWorker] Deferred enrollment ${enrollment.enrollmentId} until ${retryAt} (LinkedIn ${err.gate} refused on ${err.accountId}: ${err.reason})`);
      } else if (err instanceof SenderDailyLimitExceededError) {
        // ENG-265: the sender's daily counter resets at UTC midnight — releasing
        // the claim here would just re-fail on the very next 5-minute tick until
        // then. Snooze straight to the reset instead of hammering.
        const now = new Date();
        const nextUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
        await dripSequenceDb.snoozeEnrollment(enrollment.enrollmentId, nextUtcMidnight).catch(() => {});
        console.log(`[dripWorker] Snoozed enrollment ${enrollment.enrollmentId} until ${nextUtcMidnight} (sender ${err.senderId} hit its daily limit)`);
      } else {
        // Generic/transient error: release the claim so this enrollment is
        // retried on the very next tick, same as today's behavior, instead
        // of waiting out the stale-claim window.
        await dripSequenceDb.releaseEnrollmentClaim(enrollment.enrollmentId).catch(() => {});
      }
    }
  }

  if (stats.processed > 0) {
    console.log(`[dripWorker] Done: ${JSON.stringify(stats)}`);
  }

  return stats;
}

async function processEnrollment(
  enrollment: SequenceEnrollment,
  stats: { sent: number; skipped: number; exited: number },
): Promise<void> {
  const sequence = await dripSequenceDb.getSequence(enrollment.sequenceId);
  if (!sequence || sequence.status === 'archived') {
    await dripSequenceDb.exitEnrollment(enrollment.enrollmentId, 'manual');
    stats.exited++;
    return;
  }

  // Draft/paused sequences: skip silently (don't exit, just don't advance)
  if (sequence.status === 'draft' || sequence.status === 'paused') return;

  // Check exit conditions before sending
  const shouldExit = await checkExitConditions(enrollment, sequence);
  if (shouldExit) {
    await dripSequenceDb.exitEnrollment(enrollment.enrollmentId, shouldExit);
    stats.exited++;
    return;
  }

  const step = sequence.steps[enrollment.currentStep];
  if (!step) {
    // No more steps — sequence complete. delivered=false: this branch sends nothing, it
    // just notices there is nothing left to send.
    //
    // Same everDelivered test as the completion branch below. Writing a flat 'completed'
    // here contradicted it: an enrollment that reached this branch having sent nothing
    // (its sequence was shortened under it, say) was recorded as fully delivered AND
    // permanently barred from re-enrolment, which is the pair of defects
    // 'completed_no_sends' exists to separate.
    const everDelivered = !!(enrollment as any).lastEmailSentAt || !!(enrollment as any).lastLinkedInSentAt;
    await dripSequenceDb.completeEnrollment(
      enrollment.enrollmentId,
      everDelivered ? 'completed' : 'completed_no_sends',
      'completed',
      'email',
      false,
    );
    stats.exited++;
    return;
  }

  // Normalised the same way requiredChannels does in the route. Lower-casing only there
  // turned a dead misconfiguration into a live one: a step authored as 'LinkedIn' passed
  // the route's reachability test, then failed `channel === 'linkedin'` here and was sent
  // down the EMAIL branch — a blank email, counted as sent, stamped into lastEmailSentAt.
  const channel: SequenceChannel =
    (String(step.channel ?? 'email').trim().toLowerCase() as SequenceChannel);

  // Build variable context for substitution (shared by both channels)
  // A failed READ is not "no such lead": sending on with no lead would skip every per-lead check (do-not-contact, a Smartlead marker). It throws,
  // so the enrollment is neither sent nor advanced and is retried on the next pass. (A lead that is simply gone still reads as null.)
  let leadReadFailed = false;
  const lead = await crmDb.getLeadById(enrollment.listId, enrollment.leadId, { consistentRead: true }).catch(() => { leadReadFailed = true; return null; });
  if (leadReadFailed) throw new Error(`Could not read lead ${enrollment.leadId} for enrollment ${enrollment.enrollmentId}; will retry`);

  // ENG-673: this send must not reach a contact that is gone or marked do-not-contact, whatever the sequence's exit settings say (a sequence saved
  // with onUnsubscribe off, or an older one without the field, used to skip the check in checkExitConditions). Checked on the lead just read,
  // right before the send, so it cannot be skipped by a second read failing.
  if (!lead || isDoNotContact(lead)) {
    console.log(`[dripWorker] Enrollment ${enrollment.enrollmentId} exited: ${lead ? 'lead is marked do-not-contact' : 'lead no longer exists'}`);
    await dripSequenceDb.exitEnrollment(enrollment.enrollmentId, lead ? 'unsubscribed' : 'manual');
    stats.exited++;
    return;
  }

  // Check enrollment condition — exit (not just skip) if lead no longer meets it
  if (sequence.enrollmentCondition) {
    if (!evaluateCondition(sequence.enrollmentCondition, lead)) {
      console.log(`[dripWorker] Enrollment ${enrollment.enrollmentId} exited: condition not met (${sequence.enrollmentCondition.field} ${sequence.enrollmentCondition.operator} ${sequence.enrollmentCondition.value})`);
      await dripSequenceDb.exitEnrollment(enrollment.enrollmentId, 'manual');
      stats.exited++;
      return;
    }
  }

  const user = await userDb.getUserById(enrollment.userId).catch(() => null);

  const msgVars: Record<string, any> = {
    firstName: lead?.firstName ?? '',
    lastName: lead?.lastName ?? '',
    // NOT enrollment.leadEmail — that is the dedup IDENTITY, and for a lead with no
    // address it holds the LinkedIn URL. msgVars is shared by both channels, so a
    // {{email}} token in a LinkedIn DM rendered the recipient their own profile URL.
    email: lead?.email ?? '',
    company: lead?.company ?? '',
    title: lead?.title ?? '',
    senderName: user?.displayName ?? user?.name ?? '',
    senderEmail: user?.email ?? '',
    customFields: lead?.customFields ?? {},
  };

  // A step the LEAD cannot receive is skipped, not failed. It used to throw, and the
  // throw propagated out of here, so the enrollment retried the same undeliverable step
  // forever and never reached the steps it COULD receive: an email-only lead in a
  // mixed sequence got its email and then jammed. Configuration problems (no sender, no
  // LinkedIn account, empty message text) still throw, because those are worth retrying
  // once the user fixes them.
  const delivered = channel === 'linkedin'
    ? await sendLinkedInStep(enrollment, step, lead, msgVars)
    : await sendEmailStep(enrollment, step, user, msgVars, lead);

  // Advance or complete either way — a skipped step is done with, not pending.
  const nextStepIndex = enrollment.currentStep + 1;
  if (nextStepIndex >= sequence.steps.length) {
    // Did this enrollment EVER send anything? The send timestamps are stamped only on
    // delivery, so their absence — plus this final step also being skipped — means the
    // lead received nothing at all. Recording that as plain 'completed' barred it from
    // ever being re-enrolled (getExistingEnrollment matches regardless of status), which
    // is what this distinction is for.
    //
    // It does NOT yet change any dashboard: getEnrollmentStats buckets on `status`, and
    // these rows keep `status: 'completed'`. Nothing outside dripSequenceDb reads
    // `exitReason` today. Surfacing "enrolled but never reachable" in the UI is a
    // separate change; this one only unblocks re-enrolment.
    const everDelivered = delivered
      || !!(enrollment as any).lastEmailSentAt
      || !!(enrollment as any).lastLinkedInSentAt;
    await dripSequenceDb.completeEnrollment(
      enrollment.enrollmentId,
      everDelivered ? 'completed' : 'completed_no_sends',
      'completed',
      channel,
      delivered,
    );
  } else {
    const nextStep = sequence.steps[nextStepIndex];
    const nextSendAt = addDays(new Date(), nextStep.delayDays).toISOString();
    await dripSequenceDb.advanceEnrollment(enrollment.enrollmentId, nextStepIndex, nextSendAt, channel, delivered);
  }

  if (delivered) stats.sent++;
  else stats.skipped++;
}

async function sendEmailStep(
  enrollment: SequenceEnrollment,
  step: any,
  user: any,
  msgVars: Record<string, any>,
  lead: any,
): Promise<boolean> {
  // The enrollment's `leadEmail` is its dedup IDENTITY, not necessarily an address: a
  // lead with no email carries its LinkedIn URL there (see sequences.ts
  // enrollmentIdentity). Sending to that would hand a profile URL to the mail provider.
  //
  // Prefer the LIVE row. The identity is frozen at enrolment, so a lead that has GAINED
  // an address since would otherwise have its email step skipped forever and consumed —
  // a silent lost send, which is exactly what this whole change set out to stop. The
  // LinkedIn step already reads the live lead; this makes the two consistent.
  //
  // And the check is a SHAPE, not `includes('@')`: db.ts stores `lead.linkedin`
  // verbatim for anything that is not a personal /in/ profile, so a handle like
  // `@ada-lovelace` passed the old test and reached the mail provider. Shared with the
  // enrol routes so the two cannot disagree about who is reachable.
  const recipient = String(lead?.email ?? enrollment.leadEmail ?? '').trim();
  if (!isReachableEmail(recipient)) {
    console.log(`[dripWorker] Email step ${step.stepNumber} skipped for enrollment ${enrollment.enrollmentId}: lead has no email address`);
    return false;
  }

  // ENG-673: a lead pushed to a customer's Smartlead campaign is being emailed from there. AgentWeb's own sequence must not also write to
  // them (two senders, and Smartlead's unsubscribe and bounce handling would not see these emails). Checked HERE, at send time, not at
  // enrolment, because a lead can be pushed after it was enrolled. The step is skipped like any step the lead cannot receive; LinkedIn
  // steps are unaffected.
  if (isPushedToSmartlead(lead)) {
    console.log(`[dripWorker] Email step ${step.stepNumber} skipped for enrollment ${enrollment.enrollmentId}: lead is being emailed through Smartlead`);
    return false;
  }

  // Load configured senders for this user
  const senderConfig = await loadSenderConfig(enrollment.userId);

  const subject = substituteVariables(step.subject ?? '', msgVars);
  let bodyHtml = substituteVariables(step.bodyHtml ?? '', msgVars);

  const assetBaseUrl = process.env.EMAIL_ASSET_BASE_URL || 'https://api.agentweb.pro';
  bodyHtml = rewriteS3ImageUrls(bodyHtml, assetBaseUrl);
  bodyHtml = normalizeYoutubeUrls(bodyHtml);

  const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
  // `recipient`, NOT enrollment.leadEmail. The identity is the LinkedIn URL for a lead
  // that had no address at enrolment, and crmPublic's unsubscribe handler compares the
  // `email` param against lead.email — so the link in a cold email 403'd and the
  // recipient could not unsubscribe. This became reachable the moment the email step
  // started sending to the live address instead of skipping.
  const unsubscribeUrl = `${CUSTOMER_FRONTEND_URL}/crm-unsubscribe?listId=${encodeURIComponent(enrollment.listId)}&leadId=${encodeURIComponent(enrollment.leadId)}&email=${encodeURIComponent(recipient)}`;
  bodyHtml = injectUnsubscribeUrl(bodyHtml, unsubscribeUrl);

  const selectedSender = senderConfig.senders.find(
    (s) => s.id === (step.senderId ?? senderConfig.defaultSenderId),
  );
  const sender = selectedSender ?? legacyDefaultSender(user);

  if (!sender) {
    console.error(`[dripWorker] Skipping enrollment ${enrollment.enrollmentId}: user ${enrollment.userId} has no email sender configured`);
    throw new Error(`No email sender configured for user ${enrollment.userId}`);
  }

  let sendResult;
  try {
    sendResult = await sendAsSender(enrollment.userId, sender, {
      to: recipient,
      subject,
      html: bodyHtml,
    });
  } catch (error) {
    console.error(`[dripWorker] Send failed for step ${step.stepNumber} to ${recipient}:`, error);
    throw error;
  }

  console.log(`[dripWorker] Sent email step ${step.stepNumber} to ${recipient} via ${sendResult.provider} (id: ${sendResult.messageId})`);
  return true;
}

async function sendLinkedInStep(
  enrollment: SequenceEnrollment,
  step: any,
  lead: any,
  msgVars: Record<string, any>,
): Promise<boolean> {
  // SEND THE CANONICAL URL, NOT THE RAW FIELD.
  //
  // Must be a PERSONAL profile. db.ts stores `lead.linkedin` verbatim for anything that
  // is not a /in/ URL — company and school pages, handles, free text from a CSV — and
  // sendMessage throws on those. That throw is not a lead-data skip, so it retried
  // forever: the exact failure this whole change set out to kill, surviving in the one
  // case the emptiness check does not catch.
  //
  // The predicate normalises before judging (it strips query/fragment and lower-cases),
  // so it accepts `?originalSubdomain=uk`, `#about` and `/IN/Ada`. Gating on the
  // normalised value and then sending the RAW one reopened that same retry-forever jam
  // on every URL the widening newly admitted: linkedInOutreachService.getLinkedInProfile
  // does a plain case-sensitive `split('/in/')` and passes the tail to Unipile verbatim,
  // so the raw value arrives as `ada?originalSubdomain=uk` (404) or, for `/IN/Ada`,
  // fails `parts.length < 2` and throws outright. leadLinkedinCanonicalizer exists
  // because pre-ENG-787 rows hold exactly these shapes, so the population is real.
  //
  // Take the value the predicate actually validated.
  const linkedInUrl = canonicalLinkedInProfile(lead?.linkedin);
  if (!linkedInUrl) {
    // A LEAD-DATA gap, not a failure. Throwing here rethrew out of processEnrollment, so the
    // enrollment retried this step forever and never reached the steps it COULD receive.
    // The configuration throws below are deliberately left as throws: retrying those is
    // correct, because they start working the moment the user fixes the config.
    console.log(`[dripWorker] LinkedIn step ${step.stepNumber} skipped for enrollment ${enrollment.enrollmentId}: lead has no personal LinkedIn profile URL (${String(lead?.linkedin ?? '').trim() || 'empty'})`);
    return false;
  }

  // Resolve which LinkedIn account to send from
  if (step.linkedInAccountId) {
    // ENG-2205: a pinned account must be the sequence owner's own or org-shared one. Checked here
    // as well as on sequence write because sequences saved before that check may name any account.
    // A config problem, so it throws (retried once the user fixes the step) rather than skipping.
    const { resolveLinkedInAccountForWrite } = await import('./agentMode/linkedInDailyVolumeGate');
    if (!(await resolveLinkedInAccountForWrite(enrollment.userId, step.linkedInAccountId))) {
      console.error(`[dripWorker] LinkedIn step ${step.stepNumber} for enrollment ${enrollment.enrollmentId}: pinned account is not connected to user ${enrollment.userId}`);
      throw new PinnedLinkedInAccountNotConnectedError(step.stepNumber, enrollment.userId);
    }
  }
  const accountId = step.linkedInAccountId
    || await linkedInOutreachService.resolveAccountId(enrollment.userId);

  if (!accountId) {
    console.error(`[dripWorker] LinkedIn step failed for enrollment ${enrollment.enrollmentId}: no LinkedIn account available`);
    throw new Error(`No LinkedIn account available for user ${enrollment.userId}`);
  }

  const messageText = substituteVariables(step.messageText ?? '', msgVars);
  if (!messageText.trim()) {
    throw new Error(`LinkedIn step ${step.stepNumber} has empty message text`);
  }

  const releaseSlot = await paceDripLinkedInWrite(enrollment.userId, accountId, 'send-message');

  try {
    await linkedInOutreachService.sendMessage(accountId, linkedInUrl, true, messageText);
  } catch (err) {
    // ENG-2529: a send that failed must not keep its daily slot, or a repeatedly failing
    // enrollment drains the account's daily budget with nothing sent.
    await releaseSlot();
    throw err;
  }
  console.log(`[dripWorker] Sent LinkedIn step ${step.stepNumber} to ${linkedInUrl} (account: ${accountId})`);

  // Cache the provider_id so reply-exit checks don't need to re-resolve the URL
  if (!enrollment.linkedInProviderId) {
    try {
      const providerId = await linkedInOutreachService.resolveProviderId(linkedInUrl, true, accountId);
      if (providerId) await dripSequenceDb.setEnrollmentLinkedInProviderId(enrollment.enrollmentId, providerId);
    } catch { /* non-critical */ }
  }
  return true;
}

/**
 * ENG-2529: every drip LinkedIn write goes through the same gate as the agent tool and CRM routes.
 * An account the sequence owner owns or shares gets the full gate (daily cap + hourly pacer);
 * a shared-pool fallback account has no owner record to reserve a daily slot against, so it is
 * still held to the per-account hourly pacer. Which account is used stays with ENG-1759/ENG-2347.
 * Throws LinkedInWriteDeferredError on refusal so the caller never sends.
 */
export async function paceDripLinkedInWrite(userId: string, accountId: string, action: 'send-message' | 'send-invite'): Promise<() => Promise<void>> {
  const { resolveLinkedInAccountForWrite, paceLinkedInWrite, releaseLinkedInDailySlot } = await import('./agentMode/linkedInDailyVolumeGate');
  const resolved = await resolveLinkedInAccountForWrite(userId, accountId);
  if (resolved) {
    const paced = await paceLinkedInWrite(action, resolved, accountId);
    if (paced.refusal) {
      throw new LinkedInWriteDeferredError(paced.refusal.gate, paced.refusal.error.split('\n')[0], accountId);
    }
    return () => releaseLinkedInDailySlot(action, resolved, accountId, paced.reservedWindowStartedAt);
  }
  const { reserveWriteSlot } = await import('./linkedInWritePacer');
  const slot = await reserveWriteSlot(accountId);
  if (!slot.allowed) {
    throw new LinkedInWriteDeferredError('write_pacer', String(slot.reason ?? 'write pacer refused'), accountId);
  }
  return async () => {};
}

async function checkExitConditions(
  enrollment: SequenceEnrollment,
  sequence: DripSequence,
): Promise<'converted' | 'engagement' | 'unsubscribed' | null> {
  const { exitConditions } = sequence;

  // Fetch lead once — needed for lifecycle, unsubscribe AND the engagement key.
  // onEmailEngagement was NOT in this condition, so for a sequence configured with only
  // that exit the lead was null and the engagement lookup fell back to the enrollment
  // identity — which for an address-less lead is its LinkedIn URL, and matches no Resend
  // event. The exit could never fire.
  let lead: any = null;
  if (
    exitConditions.onLifecycleChange?.length
    || exitConditions.onUnsubscribe
    || exitConditions.onEmailEngagement?.length
  ) {
    lead = await crmDb.getLeadById(enrollment.listId, enrollment.leadId).catch(() => null);
  }

  // Check if lead has unsubscribed. (processEnrollment also checks right before the send, whatever this setting says.)
  if (exitConditions.onUnsubscribe && lead && isDoNotContact(lead)) {
    console.log(`[dripWorker] Enrollment ${enrollment.enrollmentId} exited: lead ${enrollment.leadEmail} has unsubscribed`);
    return 'unsubscribed';
  }

  // Check lifecycle-based exit (e.g. lead became "paying")
  if (exitConditions.onLifecycleChange?.length) {
    if (lead?.lifecycle && exitConditions.onLifecycleChange.includes(lead.lifecycle as any)) {
      return 'converted';
    }
  }

  // Check email engagement exit
  //
  // This used to pass '' as the emailDomain — which is the GSI PARTITION KEY. DynamoDB
  // rejects empty key values, and the .catch() swallowed it, so the query could never
  // match and these exits never fired for anyone (ENG-298). It also only ever evaluated
  // 'opened' and 'clicked': a sequence set to stop when a lead REPLIED kept on sending.
  if (exitConditions.onEmailEngagement?.length) {
    const user = await userDb.getUserById(enrollment.userId).catch(() => null);
    // Opslane run 1268 P2: CRM sending domains live in emailDomains[] (ENG-265); the
    // legacy single emailDomain may be empty for accounts set up after that. Read events
    // for every domain the account sends from, deduped.
    const domainSet = new Set<string>();
    const legacyDomain = String((user as any)?.emailDomain ?? '').trim();
    if (legacyDomain) domainSet.add(legacyDomain);
    for (const d of ((user as any)?.emailDomains ?? []) as Array<{ domain?: string }>) {
      const name = String(d?.domain ?? '').trim();
      if (name) domainSet.add(name);
    }
    const emailDomains = [...domainSet];
    const emailDomain = emailDomains[0];

    // A mailbox-only sender (Gmail/Outlook) has no Resend domain, and Resend webhooks are
    // the only source of these events — so there is nothing to find. Skip rather than
    // query with a key we know is invalid.
    if (!emailDomain) {
      console.log(
        `[dripWorker] Skipping engagement exit check for enrollment ${enrollment.enrollmentId}: ` +
        `user ${enrollment.userId} has no sending domain, so no email events exist`,
      );
    } else {
      // Keyed on the address Resend actually saw, not on the enrollment identity. For a
      // lead enrolled without an address the identity is its LinkedIn URL, so this query
      // matched nothing and a sequence set to stop on 'replied' kept sending to someone
      // who had already replied. `lead` is loaded above for the unsubscribe check.
      const engagementKey = String((lead as any)?.email ?? '').trim() || enrollment.leadEmail;
      const events = (
        await Promise.all(
          emailDomains.map((d) =>
            emailEventsDb.getEventsByEmailDomainAndLeadEmail(d, engagementKey).catch(() => []),
          ),
        )
      ).flat();

      // Scope to engagement that happened AFTER this enrollment started.
      //
      // The query returns EVERY event for that lead, ever — it is not scoped to a sequence
      // or a time window. Without this bound, a lead who opened some unrelated email months
      // ago would exit a sequence enrolled yesterday before it ever sent them anything. The
      // LinkedIn reply exit below already does exactly this.
      //
      // An event with no createdAt cannot be proven to post-date enrollment, so it does not
      // count — better to keep sending than to silently kill a live sequence.
      const enrolledAt = new Date(enrollment.enrolledAt).getTime();
      const wanted = exitConditions.onEmailEngagement;
      // ENG-2548: opens/clicks go through dripEngagementClassifier — link scanners and
      // image proxies no longer exit a lead. Replies always count.
      const { trigger, suppressed } = selectEngagementExitTrigger(events, enrolledAt, wanted, {
        emailEverSent: !!(enrollment as any).lastEmailSentAt,
      });
      for (const s of suppressed) {
        const detail = s.event?.data?.click || s.event?.data?.open || {};
        console.warn('[dripWorker] suspected_machine_engagement', JSON.stringify({
          enrollmentId: enrollment.enrollmentId,
          sequenceId: enrollment.sequenceId,
          eventType: s.event?.eventType,
          reason: s.reason,
          exitSuppressed: true,
          userAgent: detail.userAgent || null,
        }));
      }

      if (trigger) {
        // Name the exact event that caused this, and carry the two fields that would expose
        // a false positive.
        //
        // Opens and clicks can be machine-generated: corporate link scanners (Microsoft Safe
        // Links, Proofpoint, Mimecast) click every link on delivery, and Apple Mail
        // pre-fetches tracking pixels. Neither is visible in today's traffic — sampled prod
        // clicks sit 18s–250s after send, and the dominant open user-agent is Gmail's image
        // proxy, which represents a REAL human open. But cold outreach into corporate M365
        // tenants is exactly the workload that produces scanner engagement, and we do not
        // have any of that yet.
        //
        // So instead of guessing at a filter we cannot calibrate, log the evidence. A
        // scanner shows up here as a sub-second gap and a datacenter user-agent. If that
        // starts appearing, we will know rather than infer. Tracked separately.
        const t = trigger as any;
        const detail = t.data?.click || t.data?.open || {};
        const sentAt = parseResendTimestamp(t.data?.created_at) ?? NaN;
        const eventAt = new Date(t.createdAt).getTime();
        const gapSeconds = Number.isFinite(sentAt) ? Math.round((eventAt - sentAt) / 1000) : null;

        console.log(
          `[dripWorker] Enrollment ${enrollment.enrollmentId} exited: engagement — ` +
          `lead ${enrollment.leadEmail} triggered "${t.eventType}" at ${t.createdAt} ` +
          `(enrolled ${enrollment.enrolledAt}; sequence exits on: ${wanted.join(', ')}; ` +
          `gapFromSend=${gapSeconds === null ? 'unknown' : `${gapSeconds}s`}; ` +
          `userAgent=${detail.userAgent || 'n/a'})`,
        );
        // ENG-2524: make the tripwire observable. Logging only — the exit is unchanged.
        const gapMs = Number.isFinite(sentAt) ? eventAt - sentAt : null;
        if (isSuspectedMachineEngagement(t.eventType, gapMs)) {
          console.warn('[dripWorker] suspected_machine_engagement', JSON.stringify({
            enrollmentId: enrollment.enrollmentId,
            sequenceId: enrollment.sequenceId,
            eventType: t.eventType,
            gapFromSendMs: gapMs,
            userAgent: detail.userAgent || null,
            ipAddress: detail.ipAddress || null,
          }));
        }
        return 'engagement';
      }
    }
  }

  // Check LinkedIn reply exit — fetch messages and look for inbound after enrollment
  if (exitConditions.onLinkedInReply) {
    // Same canonical URL the send path uses, not a third predicate.
    //
    // This was `includes('linkedin.com')` over the RAW field, and it handed that raw
    // value to resolveProviderId. For a profile carrying `?originalSubdomain=uk` the
    // resolve is `.catch(() => null)`-wrapped, so it failed silently and the reply-exit
    // never fired at all — a sequence set to stop on a LinkedIn reply kept DMing someone
    // who had already replied. The `linkedInProviderId` cache does not save it: the send
    // that would populate the cache is the one that was throwing.
    //
    // `enrollment.leadEmail` is still the fallback because for an address-less lead that
    // field holds the canonical profile URL — it IS the dedup identity.
    const linkedInUrl = canonicalLinkedInProfile(lead?.linkedin)
      ?? canonicalLinkedInProfile(enrollment.leadEmail);
    if (linkedInUrl) {
      try {
        const accountId = await linkedInOutreachService.resolveAccountId(enrollment.userId);
        if (accountId) {
          const providerId = enrollment.linkedInProviderId
            || await linkedInOutreachService.resolveProviderId(linkedInUrl, true, accountId).catch(() => null);
          if (providerId) {
            const messages = await linkedInOutreachService.getMessagesWithContact(providerId, accountId);
            const enrolledAt = new Date(enrollment.enrolledAt).getTime();
            const hasReply = messages.some(
              (m) => m.is_sender === 0 && new Date(m.timestamp).getTime() > enrolledAt,
            );
            if (hasReply) {
              console.log(`[dripWorker] Enrollment ${enrollment.enrollmentId} exited: LinkedIn reply detected from ${linkedInUrl}`);
              return 'engagement';
            }
          }
        }
      } catch (err) {
        console.error(`[dripWorker] LinkedIn reply check failed for enrollment ${enrollment.enrollmentId}:`, err);
        // Don't exit on error — fail open (continue sending)
      }
    }
  }

  return null;
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

function evaluateCondition(condition: StepCondition, lead: any): boolean {
  const actual = getNestedValue(lead, condition.field);
  switch (condition.operator) {
    case 'exists':     return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    case 'eq':         return String(actual) === String(condition.value);
    case 'neq':        return String(actual) !== String(condition.value);
    case 'contains':   return typeof actual === 'string' && actual.includes(String(condition.value));
    default:           return false;
  }
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

async function loadSenderConfig(userId: string): Promise<{ senders: CrmSender[]; defaultSenderId: string | null }> {
  const config = await loadCrmSenderConfig(userId);
  return { senders: config.senders, defaultSenderId: config.defaultSenderId };
}

/**
 * Pre-dates CRM senders entirely: a user with no sender configured at all still
 * gets a best-effort custom-domain address built from their own account fields.
 * Synthesized as a resend CrmSender so it can go through sendAsSender like any
 * other sender.
 */
function legacyDefaultSender(user: any): CrmSender | null {
  if (!user?.emailDomain || !user?.defaultSenderUsername) {
    return null;
  }
  return {
    id: '__legacy_user_default__',
    email: `${user.defaultSenderUsername}@${user.emailDomain}`,
    fromName: user?.fromName ?? user?.displayName ?? user?.name ?? '',
    senderProvider: 'resend',
  };
}
