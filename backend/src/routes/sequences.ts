/**
 * /api/crm/sequences — drip sequence CRUD + enrollment management
 *
 * All routes require authentication.  Users can only access their own sequences.
 */

import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  dripSequenceDb,
  SequenceNotFoundError,
  SequenceAuthError,
  CreateSequenceInput,
  UpdateSequenceInput,
} from '../services/dripSequenceDb';
import { crmDb } from '../services/db';

const router = express.Router();

// ─── Sequences CRUD ───────────────────────────────────────────────────────────

// GET /api/crm/sequences
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const sequences = await dripSequenceDb.listSequences(authReq.user!.userId);
    res.json({ sequences });
  } catch (err) {
    console.error('[sequences] listSequences error:', err);
    res.status(500).json({ error: 'Failed to fetch sequences' });
  }
});

// POST /api/crm/sequences
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { name, description, campaignType, enrollmentTrigger, exitConditions, steps, status } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const input: CreateSequenceInput = {
      userId: authReq.user!.userId,
      name: name.trim(),
      description,
      campaignType,
      enrollmentTrigger,
      exitConditions,
      steps,
      status,
    };
    const sequence = await dripSequenceDb.createSequence(input);
    res.status(201).json({ sequence });
  } catch (err) {
    console.error('[sequences] createSequence error:', err);
    res.status(500).json({ error: 'Failed to create sequence' });
  }
});

// GET /api/crm/sequences/:sequenceId
router.get('/:sequenceId', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
    res.json({ sequence });
  } catch (err) {
    console.error('[sequences] getSequence error:', err);
    res.status(500).json({ error: 'Failed to fetch sequence' });
  }
});

// PUT /api/crm/sequences/:sequenceId
router.put('/:sequenceId', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { name, description, campaignType, enrollmentTrigger, exitConditions, steps, status } = req.body;
  try {
    const input: UpdateSequenceInput = {
      name,
      description,
      campaignType,
      enrollmentTrigger,
      exitConditions,
      steps,
      status,
    };
    const sequence = await dripSequenceDb.updateSequence(
      req.params.sequenceId,
      authReq.user!.userId,
      input,
    );
    res.json({ sequence });
  } catch (err: any) {
    if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
    console.error('[sequences] updateSequence error:', err);
    res.status(500).json({ error: 'Failed to update sequence' });
  }
});

// DELETE /api/crm/sequences/:sequenceId
router.delete('/:sequenceId', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    await dripSequenceDb.deleteSequence(req.params.sequenceId, authReq.user!.userId);
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
    console.error('[sequences] deleteSequence error:', err);
    res.status(500).json({ error: 'Failed to delete sequence' });
  }
});

// ─── Enrollments ──────────────────────────────────────────────────────────────

// GET /api/crm/sequences/:sequenceId/enrollments
router.get(
  '/:sequenceId/enrollments',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });

      const status = req.query.status as any;
      const enrollments = await dripSequenceDb.listEnrollmentsForSequence(
        req.params.sequenceId,
        status,
      );
      const stats = await dripSequenceDb.getEnrollmentStats(req.params.sequenceId);
      res.json({ enrollments, stats });
    } catch (err) {
      console.error('[sequences] listEnrollments error:', err);
      res.status(500).json({ error: 'Failed to fetch enrollments' });
    }
  },
);

// POST /api/crm/sequences/:sequenceId/enrollments — bulk enroll leads
router.post(
  '/:sequenceId/enrollments',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { leads, startAt } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads array is required' });
    }

    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
      if (sequence.steps.length === 0) {
        return res.status(400).json({ error: 'Sequence has no steps' });
      }

      const inputs = leads.map((l: any) => ({
        sequenceId: req.params.sequenceId,
        userId: authReq.user!.userId,
        listId: l.listId,
        leadId: l.leadId,
        leadEmail: l.leadEmail,
        startAt: startAt ?? undefined,
      }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      res.json(result);
    } catch (err: any) {
      if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
      console.error('[sequences] bulkEnroll error:', err);
      res.status(500).json({ error: 'Failed to enroll leads' });
    }
  },
);

// POST /api/crm/sequences/:sequenceId/enrollments/by-list — enroll all leads from a list
router.post(
  '/:sequenceId/enrollments/by-list',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { listId, lifecycle, startAt } = req.body;
    if (!listId) return res.status(400).json({ error: 'listId is required' });

    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
      if (sequence.steps.length === 0) {
        return res.status(400).json({ error: 'Sequence has no steps' });
      }

      const leadsResult = lifecycle
        ? await crmDb.getLeadsByStatus(listId, lifecycle)
        : await crmDb.getLeadsByListId(listId);
      const leads = Array.isArray(leadsResult)
        ? leadsResult
        : ((leadsResult as any).items ?? (leadsResult as any).leads ?? []);

      const inputs = leads.map((l: any) => ({
        sequenceId: req.params.sequenceId,
        userId: authReq.user!.userId,
        listId,
        leadId: l.leadId,
        leadEmail: l.email,
        startAt: startAt ?? undefined,
      }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      res.json(result);
    } catch (err: any) {
      if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
      console.error('[sequences] enrollByList error:', err);
      res.status(500).json({ error: 'Failed to enroll leads from list' });
    }
  },
);

// DELETE /api/crm/sequences/:sequenceId/enrollments/:enrollmentId — manual exit
router.delete(
  '/:sequenceId/enrollments/:enrollmentId',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });

      await dripSequenceDb.exitEnrollment(req.params.enrollmentId, 'manual');
      res.json({ success: true });
    } catch (err) {
      console.error('[sequences] exitEnrollment error:', err);
      res.status(500).json({ error: 'Failed to exit enrollment' });
    }
  },
);

export default router;
