import { LeadEvent, CRMTrigger } from '../types/crmTriggers';
import { crmTriggerCache } from './crmTriggerCache';
import { crmTriggerDb } from './crmTriggerDb';
import { evaluateExpression } from './crmTriggerEvaluator';
import { runTriggerAction } from './crmTriggerActionRunner';
import { crmDb, userDb } from './db';
import { leadListAlertService } from './leadListAlertService';

let _io: any = null;

function getIo(): any {
  if (!_io) {
    try {
      _io = require('../server').io;
    } catch {
      // server not loaded yet (e.g. in tests)
    }
  }
  return _io;
}

const normalizeEvent = (e: string) => e.trim().toLowerCase();

const isSystemEmail = (email: string): boolean => {
  const lower = email.toLowerCase();
  return [
    'no-reply@', 'noreply@', 'do-not-reply@',
    'donotreply@', 'mailer-daemon@', 'postmaster@',
  ].some((p) => lower.startsWith(p));
};

/**
 * Fire all enabled triggers configured for this listId and event.
 * Falls back to the legacy alertEvents[] behaviour when no explicit trigger
 * is configured for the event on this list.
 * Called asynchronously after the HTTP response is sent (never throws).
 */
export async function fireTriggers(
  event: LeadEvent,
  listId: string,
  userId: string,
  lead: Record<string, any>,
  previousLead?: Record<string, any>,
  eventData?: Record<string, any>,
  list?: Record<string, any>
): Promise<void> {
  try {
    const allTriggers = await crmTriggerCache.getTriggersForList(listId);
    const activeTriggers = allTriggers.filter(
      (t) => t.enabled && normalizeEvent(t.event) === normalizeEvent(event)
    );

    // Fetch list and user once (needed for action runner context and legacy fallback)
    const [resolvedList, resolvedUser] = await Promise.all([
      list ? Promise.resolve(list) : crmDb.getLeadListById(listId).catch(() => null),
      userDb.getUserById(userId).catch(() => null),
    ]);

    if (activeTriggers.length === 0) {
      // No explicit triggers — run legacy alertEvents[] fallback if configured
      await runLegacyFallback(event, resolvedList, lead, eventData);
      return;
    }

    const results = await Promise.allSettled(
      activeTriggers.map((trigger) =>
        evalAndRun(trigger, lead, previousLead, eventData, resolvedList, resolvedUser)
      )
    );

    const firedCount = results.filter(
      (r) => r.status === 'fulfilled' && r.value === true
    ).length;

    if (firedCount > 0) {
      const io = getIo();
      if (io) {
        io.to(`user:${userId}`).emit('crm:trigger-fired', {
          listId,
          event,
          leadId: lead.leadId,
          leadEmail: lead.email,
        });
      }
    }
  } catch (err) {
    console.error('[CRMTrigger] fireTriggers error:', err);
  }
}

/**
 * Fan-out entry point for email webhook events.
 * Replaces leadListAlertService.notifyForEmailEvent() — looks up all users
 * matching the email domain, finds their lists, resolves the lead, then
 * calls fireTriggers() per list.
 */
export async function fireTriggersByEmailEvent(emailEvent: {
  eventType: string;
  leadEmail?: string;
  emailDomain: string;
  data?: Record<string, any> | any;
  createdAt: string;
}): Promise<void> {
  try {
    const { eventType, leadEmail, emailDomain, data, createdAt } = emailEvent;
    if (!leadEmail || !eventType || !emailDomain) return;
    if (isSystemEmail(leadEmail)) return;

    const users = await userDb.getUsersByEmailDomain(emailDomain);
    const normalizedLeadEmail = leadEmail.toLowerCase();
    const normalizedEventType = normalizeEvent(eventType);

    for (const user of users) {
      const lists = await crmDb.getLeadListsByUserId(user.userId).catch(() => []);
      for (const list of lists || []) {
        const lead = await crmDb.getLeadByEmail(list.listId, normalizedLeadEmail).catch(() => null);
        if (!lead) continue;

        // Skip if user's emailDomain doesn't match (same guard as legacy service)
        if (user.emailDomain && user.emailDomain !== emailDomain) continue;

        await fireTriggers(
          normalizedEventType as LeadEvent,
          list.listId,
          user.userId,
          lead,
          undefined,
          data,
          list
        );
      }
    }
  } catch (err) {
    console.error('[CRMTrigger] fireTriggersByEmailEvent error:', err);
  }
}

/**
 * Legacy fallback: when no explicit trigger is configured for this event,
 * honour the list's alertEvents[] checkbox setting via the old alert service.
 */
async function runLegacyFallback(
  event: LeadEvent,
  list: Record<string, any> | null,
  lead: Record<string, any>,
  eventData?: Record<string, any>
): Promise<void> {
  if (!list) return;
  const alertEvents: string[] = Array.isArray(list.alertEvents) ? list.alertEvents : ['email.received'];
  const normalizedEvent = normalizeEvent(event as string);
  if (!alertEvents.map(normalizeEvent).includes(normalizedEvent)) return;

  try {
    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      list,
      lead,
      event as string,
      eventData ?? null,
      new Date().toISOString()
    );
  } catch (err) {
    console.error('[CRMTrigger] legacy fallback error:', err);
  }
}

async function evalAndRun(
  trigger: CRMTrigger,
  lead: Record<string, any>,
  previousLead: Record<string, any> | undefined,
  eventData: Record<string, any> | undefined,
  list: any,
  user: any
): Promise<boolean> {
  let expressionResult: boolean;

  try {
    expressionResult = await evaluateExpression(
      trigger.conditionExpression,
      lead,
      previousLead,
      eventData
    );
  } catch (err: any) {
    await logResult(trigger, lead, 'error', err?.message || 'Expression evaluation failed', false);
    return false;
  }

  if (!expressionResult) {
    return false; // condition not met — skip silently
  }

  let actionTaken = '';
  let errorMessage: string | undefined;

  try {
    const result = await runTriggerAction(trigger, lead, list || {}, user || {}, eventData);
    actionTaken = result.actionTaken;
    if (result.error) {
      errorMessage = result.error;
    }
  } catch (err: any) {
    errorMessage = err?.message || 'Action execution failed';
  }

  await logResult(
    trigger,
    lead,
    errorMessage ? 'error' : 'fired',
    errorMessage,
    expressionResult,
    actionTaken
  );

  return !errorMessage;
}

async function logResult(
  trigger: CRMTrigger,
  lead: Record<string, any>,
  status: 'fired' | 'skipped' | 'error',
  errorMessage?: string,
  expressionResult?: boolean,
  actionTaken?: string
): Promise<void> {
  try {
    await crmTriggerDb.writeTriggerLog({
      triggerId: trigger.triggerId,
      listId: trigger.listId,
      userId: trigger.userId,
      event: trigger.event,
      leadId: lead.leadId || '',
      leadEmail: lead.email,
      status,
      errorMessage,
      expressionResult,
      actionTaken,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CRMTrigger] failed to write trigger log:', err);
  }
}
