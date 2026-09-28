import { Router } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { approvalInboxService, type ApprovalDecision } from '../services/approvalInboxService';
import { executeResolvedDecision } from '../services/approvalInboxExecution';
import { agentModeService } from '../services/agentModeService';
import { getApproverForEmail } from '../services/approverDirectory';

/**
 * ENG-1853: the Approval Desk — the first HTTP surface over
 * approvalInboxService, which until now was only reachable from
 * routes/slack.ts and Emma's own tool code. Partner-portal only
 * (AdminRoute-gated on the frontend, isAdmin-gated here) — this is a
 * team-review surface, never customer-facing; a customer-audience decision
 * (customer_credential) is out of scope for every route below.
 *
 * Every route resolves the caller's OWN approver identity from their login
 * email (approverDirectory.getApproverForEmail) and scopes every read/write
 * to that identity — isAdmin alone grants no approver-specific access, and a
 * logged-in admin who isn't Matt/Harsha/Fangfang has no queue at all here.
 */
const router = Router();

async function resolveApprover(req: AuthenticatedRequest) {
  const email = req.user?.email;
  if (!email) return undefined;
  return getApproverForEmail(email);
}

/** GET /api/approval-desk/queue — the caller's own pending decisions, grouped
 *  by manifestId (the "one decision surface per campaign/account" the ticket
 *  asks for, not a flat list of individual calls). */
router.get('/queue', authenticateToken, isAdmin, async (req, res) => {
  try {
    const approver = await resolveApprover(req as AuthenticatedRequest);
    if (!approver) {
      return res.status(403).json({ success: false, error: 'This login is not a named Approval Desk reviewer (matt/harsha/fangfang).' });
    }
    const pending = await approvalInboxService.listPendingForApprover(approver);
    const byManifest = new Map<string, ApprovalDecision[]>();
    for (const decision of pending) {
      const list = byManifest.get(decision.manifestId) || [];
      list.push(decision);
      byManifest.set(decision.manifestId, list);
    }
    const manifests = [...byManifest.entries()].map(([manifestId, decisions]) => ({
      manifestId,
      // Display-only summary fields — the manifest detail route below is the
      // source of truth for a reviewer actually acting on one.
      subjectLabel: decisions[0]?.subjectLabel,
      itemCount: decisions.length,
      earliestExpiresAt: decisions.reduce((min, d) => (d.expiresAt < min ? d.expiresAt : min), decisions[0].expiresAt),
    }));
    return res.json({ success: true, manifests });
  } catch (error: any) {
    console.error('[approval-desk] failed to list queue:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to load the approval queue.' });
  }
});

/** GET /api/approval-desk/manifest/:manifestId — one packet's full decision
 *  set. Scoped to the caller's own decisions within it — a manifest that
 *  mixes approvers (not expected today, but not structurally impossible)
 *  only ever shows the caller their own items, never someone else's. */
router.get('/manifest/:manifestId', authenticateToken, isAdmin, async (req, res) => {
  try {
    const approver = await resolveApprover(req as AuthenticatedRequest);
    if (!approver) {
      return res.status(403).json({ success: false, error: 'This login is not a named Approval Desk reviewer (matt/harsha/fangfang).' });
    }
    const all = await approvalInboxService.listByManifest(req.params.manifestId);
    const decisions = all.filter((d) => d.approver === approver);
    if (decisions.length === 0) {
      return res.status(404).json({ success: false, error: 'No decisions in this manifest are assigned to you.' });
    }
    return res.json({ success: true, manifestId: req.params.manifestId, decisions });
  } catch (error: any) {
    console.error('[approval-desk] failed to load manifest:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to load this manifest.' });
  }
});

/** POST /api/approval-desk/decision/:decisionId/verdict — approve/reject/edit
 *  ONE item. Reuses claimDecision as-is (already atomic, race-free) then runs
 *  the same execution path Slack's own click handler runs
 *  (executeResolvedDecision) — one behavior regardless of which surface
 *  answered the decision. */
router.post('/decision/:decisionId/verdict', authenticateToken, isAdmin, async (req, res) => {
  try {
    const approver = await resolveApprover(req as AuthenticatedRequest);
    if (!approver) {
      return res.status(403).json({ success: false, error: 'This login is not a named Approval Desk reviewer (matt/harsha/fangfang).' });
    }
    const { verdict, freeText } = req.body || {};
    if (verdict !== 'approve' && verdict !== 'reject' && verdict !== 'edit') {
      return res.status(400).json({ success: false, error: 'verdict must be one of: approve, reject, edit' });
    }

    const existing = await approvalInboxService.getDecision(req.params.decisionId);
    if (!existing) return res.status(404).json({ success: false, error: 'Decision not found.' });
    if (existing.audience !== 'team' || existing.approver !== approver) {
      // Same response for "not yours" and "not a team decision at all" —
      // never confirms a decision id exists in someone else's queue.
      return res.status(404).json({ success: false, error: 'Decision not found.' });
    }

    const claim = await approvalInboxService.claimDecision(req.params.decisionId, verdict, approver, freeText);
    if (!claim.claimed) {
      const statusCode = claim.reason === 'not_found' ? 404 : 409;
      return res.status(statusCode).json({ success: false, error: `Could not record this verdict (${claim.reason}).` });
    }

    await executeResolvedDecision(claim.decision);
    const updated = await approvalInboxService.getDecision(req.params.decisionId);
    return res.json({ success: true, decision: updated || claim.decision });
  } catch (error: any) {
    console.error('[approval-desk] failed to record verdict:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to record this verdict.' });
  }
});

/** POST /api/approval-desk/manifest/:manifestId/approve-all — dispatches the
 *  manifest's approved meta_write items together, as one packet, and reads
 *  every one of them back. Server-enforced gate (not just UI-disabled):
 *  refuses unless every one of the caller's own items in this manifest has
 *  already been individually answered — approving item 3 of 5 must not let
 *  approve-all silently skip the other two as if they'd been decided. */
router.post('/manifest/:manifestId/approve-all', authenticateToken, isAdmin, async (req, res) => {
  try {
    const approver = await resolveApprover(req as AuthenticatedRequest);
    if (!approver) {
      return res.status(403).json({ success: false, error: 'This login is not a named Approval Desk reviewer (matt/harsha/fangfang).' });
    }
    const all = await approvalInboxService.listByManifest(req.params.manifestId);
    const decisions = all.filter((d) => d.approver === approver);
    if (decisions.length === 0) {
      return res.status(404).json({ success: false, error: 'No decisions in this manifest are assigned to you.' });
    }
    const stillPending = decisions.filter((d) => d.status === 'pending_team_review');
    if (stillPending.length > 0) {
      return res.status(409).json({
        success: false,
        error: `${stillPending.length} item(s) in this manifest still need an individual answer before Approve All can run.`,
        unresolved: stillPending.map((d) => d.decisionId),
      });
    }

    const outcome = await agentModeService.executeApprovalInboxMetaWriteManifest(req.params.manifestId);
    if (outcome.outcome === 'executed') {
      return res.json({ success: true, ...outcome });
    }
    // no_meta_write_items: every item in this reviewer's slice was
    // plan_choice/etc — already resumed individually, nothing left to
    // dispatch. Treated as a successful no-op, not an error.
    if (outcome.outcome === 'no_meta_write_items') {
      return res.json({ success: true, outcome: outcome.outcome, summary: null });
    }
    return res.status(409).json({ success: false, ...outcome });
  } catch (error: any) {
    console.error('[approval-desk] failed to execute approve-all:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to execute this manifest.' });
  }
});

export default router;
