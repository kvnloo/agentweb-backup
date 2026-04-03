import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { crmDb } from '../services/db';
import { crmTriggerDb } from '../services/crmTriggerDb';
import { crmTriggerCache } from '../services/crmTriggerCache';
import { validateExpression } from '../services/crmTriggerEvaluator';
import { LeadEvent, TriggerAction } from '../types/crmTriggers';

const router = express.Router();

const STANDARD_EVENTS: LeadEvent[] = [
  'lead.created', 'lead.updated', 'lead.deleted',
  'email.received', 'email.opened', 'email.clicked',
  'email.delivered', 'email.bounced', 'email.complained',
  'api.lead_added', 'api.lead_updated', 'api.lead_failed',
];
const MAX_TRIGGERS_PER_LIST = 20;

function isValidEvent(event: string): boolean {
  return STANDARD_EVENTS.includes(event as LeadEvent) || event.startsWith('custom.');
}

router.use(authenticateToken);

async function verifyListOwnership(
  listId: string,
  userId: string,
  res: Response
): Promise<boolean> {
  const list = await crmDb.getLeadListById(listId);
  if (!list) {
    res.status(404).json({ message: 'Lead list not found' });
    return false;
  }
  if (list.userId !== userId) {
    res.status(403).json({ message: 'Access denied' });
    return false;
  }
  return true;
}

function validateAction(action: any): string | null {
  if (!action || typeof action !== 'object') return 'action is required';
  if (!action.type) return 'action.type is required';

  if (action.type === 'send_email') {
    if (!action.toType || !['list_owner', 'custom'].includes(action.toType)) {
      return 'action.toType must be "list_owner" or "custom"';
    }
    if (action.toType === 'custom') {
      if (!Array.isArray(action.toEmails) || action.toEmails.length === 0) {
        return 'action.toEmails must be a non-empty array when toType is "custom"';
      }
    }
    if (!action.subjectTemplate || typeof action.subjectTemplate !== 'string') {
      return 'action.subjectTemplate is required';
    }
    if (!action.bodyTemplate || typeof action.bodyTemplate !== 'string') {
      return 'action.bodyTemplate is required';
    }
    return null;
  }

  if (action.type === 'linkedin_connect') {
    return null;
  }

  return `Unknown action type: ${action.type}`;
}

/**
 * @route POST /api/crm/lists/:listId/triggers/validate-expression
 * @desc Validate a jexl expression without saving
 */
router.post(
  '/lists/:listId/triggers/validate-expression',
  async (req: Request, res: Response) => {
    try {
      const { expression } = req.body;
      if (typeof expression !== 'string') {
        return res.status(400).json({ valid: false, error: 'expression must be a string' });
      }
      const result = await validateExpression(expression);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ valid: false, error: err.message });
    }
  }
);

/**
 * @route GET /api/crm/lists/:listId/triggers
 */
router.get('/lists/:listId/triggers', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!(await verifyListOwnership(listId, userId, res))) return;

    const triggers = await crmTriggerDb.getTriggersByListId(listId);
    res.json(triggers);
  } catch (err: any) {
    res.status(500).json({ message: err.message || 'Failed to fetch triggers' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/triggers
 */
router.post('/lists/:listId/triggers', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!(await verifyListOwnership(listId, userId, res))) return;

    const { name, description, event, conditionExpression, action, enabled } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ message: 'name is required' });
    }
    if (!isValidEvent(event)) {
      return res.status(400).json({ message: `event must be one of the standard events or start with "custom."` });
    }

    const expr = conditionExpression || 'true';
    const exprValidation = await validateExpression(expr);
    if (!exprValidation.valid) {
      return res.status(400).json({ message: `Invalid conditionExpression: ${exprValidation.error}` });
    }

    const actionError = validateAction(action);
    if (actionError) {
      return res.status(400).json({ message: actionError });
    }

    // Enforce max triggers per list
    const existing = await crmTriggerDb.getTriggersByListId(listId);
    if (existing.length >= MAX_TRIGGERS_PER_LIST) {
      return res
        .status(400)
        .json({ message: `Maximum of ${MAX_TRIGGERS_PER_LIST} triggers per list` });
    }

    const trigger = await crmTriggerDb.createTrigger({
      listId,
      userId,
      event,
      name: name.trim(),
      description: description?.trim(),
      enabled: enabled !== false,
      conditionExpression: expr,
      action: action as TriggerAction,
    });

    crmTriggerCache.invalidate(listId);
    res.status(201).json(trigger);
  } catch (err: any) {
    res.status(500).json({ message: err.message || 'Failed to create trigger' });
  }
});

/**
 * @route GET /api/crm/lists/:listId/triggers/:triggerId
 */
router.get(
  '/lists/:listId/triggers/:triggerId',
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { listId, triggerId } = req.params;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });
      if (!(await verifyListOwnership(listId, userId, res))) return;

      const trigger = await crmTriggerDb.getTriggerById(triggerId);
      if (!trigger || trigger.listId !== listId) {
        return res.status(404).json({ message: 'Trigger not found' });
      }
      res.json(trigger);
    } catch (err: any) {
      res.status(500).json({ message: err.message || 'Failed to fetch trigger' });
    }
  }
);

/**
 * @route PUT /api/crm/lists/:listId/triggers/:triggerId
 */
router.put(
  '/lists/:listId/triggers/:triggerId',
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { listId, triggerId } = req.params;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });
      if (!(await verifyListOwnership(listId, userId, res))) return;

      const existing = await crmTriggerDb.getTriggerById(triggerId);
      if (!existing || existing.listId !== listId) {
        return res.status(404).json({ message: 'Trigger not found' });
      }

      const { name, description, event, conditionExpression, action, enabled } = req.body;
      const updates: Record<string, any> = {};

      if (name !== undefined) {
        if (typeof name !== 'string') return res.status(400).json({ message: 'name must be a string' });
        updates.name = name.trim();
      }
      if (description !== undefined) updates.description = description?.trim();
      if (enabled !== undefined) updates.enabled = Boolean(enabled);

      if (event !== undefined) {
        if (!isValidEvent(event)) {
          return res.status(400).json({ message: `event must be one of the standard events or start with "custom."` });
        }
        updates.event = event;
      }

      if (conditionExpression !== undefined) {
        const validation = await validateExpression(conditionExpression);
        if (!validation.valid) {
          return res.status(400).json({ message: `Invalid conditionExpression: ${validation.error}` });
        }
        updates.conditionExpression = conditionExpression;
      }

      if (action !== undefined) {
        const actionError = validateAction(action);
        if (actionError) return res.status(400).json({ message: actionError });
        updates.action = action;
      }

      const updated = await crmTriggerDb.updateTrigger(triggerId, updates);
      crmTriggerCache.invalidate(listId);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message || 'Failed to update trigger' });
    }
  }
);

/**
 * @route DELETE /api/crm/lists/:listId/triggers/:triggerId
 */
router.delete(
  '/lists/:listId/triggers/:triggerId',
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { listId, triggerId } = req.params;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });
      if (!(await verifyListOwnership(listId, userId, res))) return;

      const existing = await crmTriggerDb.getTriggerById(triggerId);
      if (!existing || existing.listId !== listId) {
        return res.status(404).json({ message: 'Trigger not found' });
      }

      await crmTriggerDb.deleteTrigger(triggerId);
      crmTriggerCache.invalidate(listId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || 'Failed to delete trigger' });
    }
  }
);

/**
 * @route GET /api/crm/lists/:listId/trigger-logs
 */
router.get(
  '/lists/:listId/trigger-logs',
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { listId } = req.params;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });
      if (!(await verifyListOwnership(listId, userId, res))) return;

      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const logs = await crmTriggerDb.getLogsByListId(listId, limit);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ message: err.message || 'Failed to fetch trigger logs' });
    }
  }
);

/**
 * @route GET /api/crm/lists/:listId/triggers/:triggerId/logs
 */
router.get(
  '/lists/:listId/triggers/:triggerId/logs',
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { listId, triggerId } = req.params;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });
      if (!(await verifyListOwnership(listId, userId, res))) return;

      const trigger = await crmTriggerDb.getTriggerById(triggerId);
      if (!trigger || trigger.listId !== listId) {
        return res.status(404).json({ message: 'Trigger not found' });
      }

      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const logs = await crmTriggerDb.getLogsByTriggerId(triggerId, limit);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ message: err.message || 'Failed to fetch trigger logs' });
    }
  }
);

export default router;
