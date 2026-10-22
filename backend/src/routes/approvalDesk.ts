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

// ENG-1853 follow-up: manifestId is the execution grouping (one Approve All
// dispatches one manifest together) but Matt's own mental model is "which
// ACCOUNTS need me" — the account-vs-manifest distinction only matters
// operationally, not to how a reviewer wants to scan the queue. Real
// account id already lives on every meta_write decision's own dispatch
// payload (resolvedAccountId is the frozen, already-tenancy-checked value —
// never account_id, the raw/unverified one); this just surfaces it instead
// of leaving callers to regex it out of a free-text subjectLabel.
function normalizeAccountId(id: unknown): string | null {
  const v = typeof id === 'string' ? id.replace(/^act_/, '').trim() : '';
  return v || null;
}

// Producers have stored resolvedAccountId both as "act_333" and "333", so groups key on the bare id.
// A packet written by an older build can span several accounts: report every account it touches
// instead of silently filing the whole packet under the first one.
function accountIdsForManifest(decisions: ApprovalDecision[]): string[] {
  const ids = new Set<string>();
  for (const d of decisions) {
    const id = normalizeAccountId(d.metaWriteDispatch?.resolvedAccountId);
    if (id) ids.add(id);
  }
  return [...ids];
}

// subjectLabel is producer-authored free text (see agentModeService.ts's
// stageApprovalInboxMetaWriteManifest), typically "<Company> · Meta Ad
// Account <id>" — strip the account-id suffix for a group header that reads
// as a company/account name, not a repeat of the raw id shown right next to
// it. Falls back to the raw account id if the label doesn't match that
// shape (never blocks grouping on a label-parsing miss).
function accountLabelForManifest(decisions: ApprovalDecision[], accountId: string | null): string {
  const label = decisions.find((d) => normalizeAccountId(d.metaWriteDispatch?.resolvedAccountId) === accountId)?.subjectLabel;
  // The meta_write producer labels decisions "Meta Ads · Account <id>" (no company name available there).
  const producerLabel = label?.match(/^Meta Ads\s*·\s*Account\s+(\S+)/i);
  if (producerLabel) return `Ad account ${producerLabel[1]}`;
  const stripped = label?.split(/\s*·\s*Meta Ad Account\s/i)[0]?.trim();
  return stripped || `Account ${accountId}`;
}

// chatUrl is agent-authored on the plan_choice path (taken from a model tool call) and is rendered
// to an admin as a trusted "View the full conversation" link, so only a link back to our own
// customer portal is passed through; anything else is dropped rather than shown.
function customerPortalOrigin(): string {
  try {
    return new URL(process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174').origin;
  } catch {
    return '';
  }
}
function withSafeChatUrl(decision: ApprovalDecision): ApprovalDecision {
  const chatUrl = decision.evidencePacket?.chatUrl;
  if (!chatUrl) return decision;
  try {
    if (new URL(chatUrl).origin === customerPortalOrigin()) return decision;
  } catch {
    // unparseable -> drop below
  }
  return { ...decision, evidencePacket: { ...decision.evidencePacket, chatUrl: undefined } };
}

// A meta_write summary reads "<verb> <entity> … in ad account X. Changes: key: before → after."
// — the part a reviewer scans for is the TAIL, so a plain head-slice cut exactly that off for a
// long campaign name. Keep a short head and the Changes tail; Array.from keeps surrogate pairs whole.
const PREVIEW_MAX = 220;
function previewOf(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= PREVIEW_MAX) return text;
  const at = text.indexOf('Changes:');
  if (at > 0) {
    const head = Array.from(text.slice(0, at).trim());
    const tail = Array.from(text.slice(at));
    const tailPart = tail.slice(0, 120).join('') + (tail.length > 120 ? '…' : '');
    return `${head.slice(0, PREVIEW_MAX - 120 - 2).join('')}… ${tailPart}`;
  }
  return `${chars.slice(0, PREVIEW_MAX - 1).join('')}…`;
}

/** GET /api/approval-desk/queue — the caller's own pending decisions, grouped
 *  by manifestId (the "one decision surface per campaign/account" the ticket
 *  asks for, not a flat list of individual calls), with each manifest's real
 *  account id/label attached so the frontend can group manifests under
 *  accounts (Matt's own mental model) without re-deriving it from decisions
 *  it doesn't have here. */
router.get('/queue', authenticateToken, isAdmin, async (req, res) => {
  try {
    const approver = await resolveApprover(req as AuthenticatedRequest);
    if (!approver) {
      return res.status(403).json({ success: false, error: 'This login is not a named Approval Desk reviewer (matt/harsha/fangfang).' });
    }
    // Pending items PLUS approved-but-undispatched meta_write items, so a packet whose every card
    // was answered stays reachable until Approve All has run (or it expires).
    const [pendingItems, awaitingDispatch] = await Promise.all([
      approvalInboxService.listPendingForApprover(approver),
      approvalInboxService.listAwaitingDispatchForApprover(approver),
    ]);
    const pending = [...pendingItems, ...awaitingDispatch];
    const byManifest = new Map<string, ApprovalDecision[]>();
    for (const decision of pending) {
      // Live-verified on env1 (2026-09-28): real decisions created before
      // this PR (ENG-1644's own earlier testing) have no manifestId at all —
      // the field is additive, not backfilled. Such a row can never appear
      // in a ManifestIndex query (listByManifest), so surfacing it here
      // would only produce a queue entry whose "Review" link 404s. These
      // stay reachable exactly as before, through Slack — this is a NEW
      // surface, not a replacement, so a pre-existing item simply isn't
      // part of it yet.
      if (!decision.manifestId) continue;
      const list = byManifest.get(decision.manifestId) || [];
      list.push(decision);
      byManifest.set(decision.manifestId, list);
    }
    const manifests = [...byManifest.entries()].map(([manifestId, decisions]) => {
      const accountIds = accountIdsForManifest(decisions);
      // Exactly one account -> group under it; several (legacy mixed packet) -> no single account.
      const accountId = accountIds.length === 1 ? accountIds[0] : null;
      return {
        manifestId,
        // Display-only summary fields — the manifest detail route below is the
        // source of truth for a reviewer actually acting on one.
        subjectLabel: decisions[0]?.subjectLabel,
        itemCount: decisions.length,
        // How many still need an individual answer vs are answered and waiting on Approve All.
        pendingCount: decisions.filter((d) => d.status === 'pending_team_review').length,
        readyToDispatchCount: decisions.filter((d) => d.status === 'approved' || d.status === 'dispatching').length,
        // One line per item so a packet row can say WHAT is inside instead of
        // repeating the account name its accordion already shows.
        itemPreviews: decisions.slice(0, 3).map((d) => previewOf(d.businessImpact)),
        earliestExpiresAt: decisions.reduce((min, d) => (d.expiresAt < min ? d.expiresAt : min), decisions[0].expiresAt),
        // null for a manifest with no meta_write items (e.g. a pure
        // plan_choice packet) — those have no account to group under and
        // the frontend buckets them separately rather than forcing a fake one.
        accountId,
        // Every account the packet touches; more than one means an older mixed packet that is shown
        // on its own rather than filed under a single account.
        accountIds,
        accountLabel: accountId ? accountLabelForManifest(decisions, accountId) : null,
      };
    });
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
    return res.json({ success: true, manifestId: req.params.manifestId, decisions: decisions.map(withSafeChatUrl) });
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
    return res.json({ success: true, decision: withSafeChatUrl(updated || claim.decision) });
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

    const outcome = await agentModeService.executeApprovalInboxMetaWriteManifest(req.params.manifestId, approver);
    if (outcome.outcome === 'executed') {
      return res.json({ success: true, ...outcome });
    }
    // no_meta_write_items: every item in this reviewer's slice was
    // plan_choice/etc — already resumed individually, nothing left to
    // dispatch. Treated as a successful no-op, not an error.
    if (outcome.outcome === 'no_meta_write_items') {
      return res.json({ success: true, outcome: outcome.outcome, summary: null });
    }
    // Second-review fix: every other outcome used to come back with no
    // message/error field at all, so the frontend's generic
    // "Failed to execute this manifest." was the only thing a reviewer ever
    // saw — including for 'not_all_resolved', which can legitimately
    // recur if an earlier verdict call's markDispatching transiently
    // failed (that decision self-heals here now, but a genuinely repeated
    // failure still deserves a real message instead of a silent 409).
    const message =
      outcome.outcome === 'not_all_resolved'
        ? `${outcome.unresolved.length} item(s) in your slice of this manifest are approved but not yet ready to dispatch — retrying usually resolves this; if it keeps happening, contact engineering with decision id(s) ${outcome.unresolved.join(', ')}.`
        : outcome.outcome === 'mixed_origin_sessions'
        ? 'This manifest’s items disagree on which chat session they came from — cannot safely resume any one session. Contact engineering.'
        : outcome.outcome === 'no_origin_session'
        ? 'The chat session this manifest came from could not be found — the writes were not dispatched.'
        : outcome.outcome === 'already_executed'
        ? 'This manifest was already dispatched.'
        : 'Another request for this manifest is already in progress — try again shortly.';
    return res.status(409).json({ success: false, message, ...outcome });
  } catch (error: any) {
    console.error('[approval-desk] failed to execute approve-all:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to execute this manifest.' });
  }
});

export default router;
