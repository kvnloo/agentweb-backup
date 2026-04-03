import { LeadEvent, CRMTrigger } from '../types/crmTriggers';
import { crmTriggerCache } from './crmTriggerCache';
import { crmTriggerDb } from './crmTriggerDb';
import { evaluateExpression } from './crmTriggerEvaluator';
import { runTriggerAction } from './crmTriggerActionRunner';
import { crmDb, userDb } from './db';

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

/**
 * Fire all enabled triggers configured for this listId and event.
 * Called asynchronously after the HTTP response is sent (never throws).
 */
export async function fireTriggers(
  event: LeadEvent,
  listId: string,
  userId: string,
  lead: Record<string, any>,
  previousLead?: Record<string, any>
): Promise<void> {
  try {
    const allTriggers = await crmTriggerCache.getTriggersForList(listId);
    const activeTriggers = allTriggers.filter(
      (t) => t.enabled && t.event === event
    );

    if (activeTriggers.length === 0) return;

    // Fetch list and user once (for action runner context)
    const [list, user] = await Promise.all([
      crmDb.getLeadListById(listId).catch(() => null),
      userDb.getUserById(userId).catch(() => null),
    ]);

    const results = await Promise.allSettled(
      activeTriggers.map((trigger) => evalAndRun(trigger, lead, previousLead, list, user))
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

async function evalAndRun(
  trigger: CRMTrigger,
  lead: Record<string, any>,
  previousLead: Record<string, any> | undefined,
  list: any,
  user: any
): Promise<boolean> {
  let expressionResult: boolean;

  try {
    expressionResult = await evaluateExpression(
      trigger.conditionExpression,
      lead,
      previousLead
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
    const result = await runTriggerAction(trigger, lead, list || {}, user || {});
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
