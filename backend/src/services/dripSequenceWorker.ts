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

import { dripSequenceDb, DripSequence, SequenceEnrollment, StepCondition } from './dripSequenceDb';
import { resendService } from './resendService';
import { crmDb, userDb } from './db';
import { emailEventsDb } from './emailEventsDb';
import { substituteVariables, injectUnsubscribeUrl, rewriteS3ImageUrls } from '../utils/emailVariables';
import { settingsService } from './settingsService';

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
    stats.processed++;
    try {
      await processEnrollment(enrollment, stats);
    } catch (err) {
      stats.errors++;
      console.error(`[dripWorker] Error processing enrollment ${enrollment.enrollmentId}:`, err);
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

  // Build email context for variable substitution
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

  // Load configured senders for this user
  const senderConfig = await loadSenderConfig(enrollment.userId);

  const emailVars: Record<string, string> = {
    firstName: lead?.firstName ?? '',
    lastName: lead?.lastName ?? '',
    email: enrollment.leadEmail,
    company: lead?.company ?? '',
    senderName: user?.displayName ?? user?.name ?? '',
    senderEmail: user?.email ?? '',
  };

  const subject = substituteVariables(step.subject, emailVars);
  let bodyHtml = substituteVariables(step.bodyHtml, emailVars);

  // Rewrite S3 image URLs through the /asset/ proxy so image hostnames match the
  // sending domain — reduces spam filtering by Gmail and other providers.
  // Use EMAIL_ASSET_BASE_URL so emails always contain publicly accessible URLs,
  // even when sent from a dev environment where BACKEND_URL is a private IP.
  const assetBaseUrl = process.env.EMAIL_ASSET_BASE_URL || 'https://api.agentweb.pro';
  bodyHtml = rewriteS3ImageUrls(bodyHtml, assetBaseUrl);

  // Inject unsubscribe URL — replaces {{unsubscribeUrl}} variable, updates an existing
  // unsubscribe anchor href, or appends a footer if no unsubscribe link is present.
  const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
  const unsubscribeUrl = `${CUSTOMER_FRONTEND_URL}/crm-unsubscribe?listId=${encodeURIComponent(enrollment.listId)}&leadId=${encodeURIComponent(enrollment.leadId)}&email=${encodeURIComponent(enrollment.leadEmail)}`;
  bodyHtml = injectUnsubscribeUrl(bodyHtml, unsubscribeUrl);

  // Resolve sender config — use step's senderId if set, else account default
  const senderEmail = resolveSenderEmail(user, senderConfig, step.senderId);
  const senderName = resolveSenderName(user, senderConfig, step.senderId);

  if (!senderEmail) {
    console.error(`[dripWorker] Skipping enrollment ${enrollment.enrollmentId}: user ${enrollment.userId} has no email sender configured (emailDomain + defaultSenderUsername + fromName required)`);
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

  console.log(`[dripWorker] Sent step ${step.stepNumber} to ${enrollment.leadEmail} (id: ${sendResult.id})`);

  // Advance or complete only after confirmed send
  const nextStepIndex = enrollment.currentStep + 1;
  if (nextStepIndex >= sequence.steps.length) {
    await dripSequenceDb.completeEnrollment(enrollment.enrollmentId, 'completed');
  } else {
    const nextStep = sequence.steps[nextStepIndex];
    const nextSendAt = addDays(new Date(), nextStep.delayDays).toISOString();
    await dripSequenceDb.advanceEnrollment(enrollment.enrollmentId, nextStepIndex, nextSendAt);
  }

  stats.sent++;
}

async function checkExitConditions(
  enrollment: SequenceEnrollment,
  sequence: DripSequence,
): Promise<'converted' | 'engagement' | 'unsubscribed' | null> {
  const { exitConditions } = sequence;

  // Check lifecycle-based exit (e.g. lead became "paying")
  if (exitConditions.onLifecycleChange?.length) {
    const lead = await crmDb.getLeadById(enrollment.listId, enrollment.leadId).catch(() => null);
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
