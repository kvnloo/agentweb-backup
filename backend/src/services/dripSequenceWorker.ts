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
import { resendService } from './resendService';
import { linkedInOutreachService } from './linkedInOutreachService';
import { crmDb, userDb } from './db';
import { emailEventsDb } from './emailEventsDb';
import { isDoNotContact } from '../utils/leadContactStatus';
import { substituteVariables, injectUnsubscribeUrl, rewriteS3ImageUrls, normalizeYoutubeUrls } from '../utils/emailVariables';
import { settingsService } from './settingsService';
import { v4 as uuidv4 } from 'uuid';

// Identifies this process for the claimedBy field — mirrors
// socialEngagementExecutor.ts's INSTANCE_ID, used for log correlation only.
const INSTANCE_ID = uuidv4();

export async function processDueEnrollments(): Promise<{
  processed: number;
  sent: number;
  exited: number;
  errors: number;
}> {
  const stats = { processed: 0, sent: 0, exited: 0, errors: 0 };

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
  stats: { sent: number; exited: number },
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
    // No more steps — sequence complete
    await dripSequenceDb.completeEnrollment(enrollment.enrollmentId, 'completed');
    stats.exited++;
    return;
  }

  const channel: SequenceChannel = step.channel ?? 'email';

  // Build variable context for substitution (shared by both channels)
  const lead = await crmDb.getLeadById(enrollment.listId, enrollment.leadId).catch(() => null);

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
    email: enrollment.leadEmail,
    company: lead?.company ?? '',
    title: lead?.title ?? '',
    senderName: user?.displayName ?? user?.name ?? '',
    senderEmail: user?.email ?? '',
    customFields: lead?.customFields ?? {},
  };

  if (channel === 'linkedin') {
    await sendLinkedInStep(enrollment, step, lead, msgVars);
  } else {
    await sendEmailStep(enrollment, step, user, msgVars);
  }

  // Advance or complete only after confirmed send
  const nextStepIndex = enrollment.currentStep + 1;
  if (nextStepIndex >= sequence.steps.length) {
    await dripSequenceDb.completeEnrollment(enrollment.enrollmentId, 'completed', 'completed', channel);
  } else {
    const nextStep = sequence.steps[nextStepIndex];
    const nextSendAt = addDays(new Date(), nextStep.delayDays).toISOString();
    await dripSequenceDb.advanceEnrollment(enrollment.enrollmentId, nextStepIndex, nextSendAt, channel);
  }

  stats.sent++;
}

async function sendEmailStep(
  enrollment: SequenceEnrollment,
  step: any,
  user: any,
  msgVars: Record<string, any>,
): Promise<void> {
  // Load configured senders for this user
  const senderConfig = await loadSenderConfig(enrollment.userId);

  const subject = substituteVariables(step.subject ?? '', msgVars);
  let bodyHtml = substituteVariables(step.bodyHtml ?? '', msgVars);

  const assetBaseUrl = process.env.EMAIL_ASSET_BASE_URL || 'https://api.agentweb.pro';
  bodyHtml = rewriteS3ImageUrls(bodyHtml, assetBaseUrl);
  bodyHtml = normalizeYoutubeUrls(bodyHtml);

  const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
  const unsubscribeUrl = `${CUSTOMER_FRONTEND_URL}/crm-unsubscribe?listId=${encodeURIComponent(enrollment.listId)}&leadId=${encodeURIComponent(enrollment.leadId)}&email=${encodeURIComponent(enrollment.leadEmail)}`;
  bodyHtml = injectUnsubscribeUrl(bodyHtml, unsubscribeUrl);

  const senderEmail = resolveSenderEmail(user, senderConfig, step.senderId);
  const senderName = resolveSenderName(user, senderConfig, step.senderId);

  if (!senderEmail) {
    console.error(`[dripWorker] Skipping enrollment ${enrollment.enrollmentId}: user ${enrollment.userId} has no email sender configured`);
    throw new Error(`No email sender configured for user ${enrollment.userId}`);
  }

  const fromField = senderName ? `${senderName} <${senderEmail}>` : senderEmail;

  const sendResult = await resendService.sendEmail({
    from: fromField,
    to: [enrollment.leadEmail],
    subject,
    html: bodyHtml,
  });

  if (!sendResult) {
    console.error(`[dripWorker] Resend returned null for step ${step.stepNumber} to ${enrollment.leadEmail} — not advancing`);
    throw new Error(`Email send failed for ${enrollment.leadEmail}`);
  }

  console.log(`[dripWorker] Sent email step ${step.stepNumber} to ${enrollment.leadEmail} (id: ${sendResult.id})`);
}

async function sendLinkedInStep(
  enrollment: SequenceEnrollment,
  step: any,
  lead: any,
  msgVars: Record<string, any>,
): Promise<void> {
  const linkedInUrl = lead?.linkedin?.trim();
  if (!linkedInUrl) {
    console.error(`[dripWorker] LinkedIn step skipped for enrollment ${enrollment.enrollmentId}: lead has no LinkedIn URL`);
    throw new Error(`Lead ${enrollment.leadEmail} has no LinkedIn URL for LinkedIn step`);
  }

  // Resolve which LinkedIn account to send from
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

  await linkedInOutreachService.sendMessage(accountId, linkedInUrl, true, messageText);
  console.log(`[dripWorker] Sent LinkedIn step ${step.stepNumber} to ${linkedInUrl} (account: ${accountId})`);

  // Cache the provider_id so reply-exit checks don't need to re-resolve the URL
  if (!enrollment.linkedInProviderId) {
    try {
      const providerId = await linkedInOutreachService.resolveProviderId(linkedInUrl, true, accountId);
      if (providerId) await dripSequenceDb.setEnrollmentLinkedInProviderId(enrollment.enrollmentId, providerId);
    } catch { /* non-critical */ }
  }
}

async function checkExitConditions(
  enrollment: SequenceEnrollment,
  sequence: DripSequence,
): Promise<'converted' | 'engagement' | 'unsubscribed' | null> {
  const { exitConditions } = sequence;

  // Fetch lead once — needed for lifecycle and unsubscribe checks
  let lead: any = null;
  if (exitConditions.onLifecycleChange?.length || exitConditions.onUnsubscribe) {
    lead = await crmDb.getLeadById(enrollment.listId, enrollment.leadId).catch(() => null);
  }

  // Check if lead has unsubscribed — always enforced (onUnsubscribe is always true)
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
  if (exitConditions.onEmailEngagement?.length) {
    const events = await emailEventsDb
      .getEventsByEmailDomainAndLeadEmail('', enrollment.leadEmail)
      .catch(() => []);
    const engaged = events.some((e: any) => {
      if (exitConditions.onEmailEngagement!.includes('opened') && e.eventType === 'email.opened') return true;
      if (exitConditions.onEmailEngagement!.includes('clicked') && e.eventType === 'email.clicked') return true;
      return false;
    });
    if (engaged) return 'engagement';
  }

  // Check LinkedIn reply exit — fetch messages and look for inbound after enrollment
  if (exitConditions.onLinkedInReply) {
    const linkedInUrl = lead?.linkedin?.trim() || enrollment.leadEmail;
    if (linkedInUrl?.includes('linkedin.com')) {
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

async function loadSenderConfig(userId: string): Promise<{ senders: any[]; defaultSenderId: string | null }> {
  try {
    const setting = await settingsService.getSetting(`crm_sender_emails_${userId}`);
    if (!setting?.settingValue) return { senders: [], defaultSenderId: null };
    const config = JSON.parse(setting.settingValue);
    return { senders: config.senders ?? [], defaultSenderId: config.defaultSenderId ?? null };
  } catch {
    return { senders: [], defaultSenderId: null };
  }
}

function resolveSenderEmail(user: any, senderConfig: { senders: any[]; defaultSenderId: string | null }, senderId?: string): string | null {
  const id = senderId ?? senderConfig.defaultSenderId;
  if (id) {
    const match = senderConfig.senders.find((s: any) => s.id === id);
    if (match?.email) return match.email;
  }
  // Legacy fallback: user-level defaultSenderUsername
  if (user?.emailDomain && user?.defaultSenderUsername) {
    return `${user.defaultSenderUsername}@${user.emailDomain}`;
  }
  return null;
}

function resolveSenderName(user: any, senderConfig: { senders: any[]; defaultSenderId: string | null }, senderId?: string): string {
  const id = senderId ?? senderConfig.defaultSenderId;
  if (id) {
    const match = senderConfig.senders.find((s: any) => s.id === id);
    if (match?.fromName) return match.fromName;
  }
  return user?.fromName ?? user?.displayName ?? user?.name ?? '';
}
