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
  SequenceStatus,
  SequenceAuthError,
  CreateSequenceInput,
  UpdateSequenceInput,
} from '../services/dripSequenceDb';
import { crmDb } from '../services/db';
import { isSessionList, SESSION_LIST_SEQUENCE_ERROR } from '../utils/sessionList';
import { resolveSenderForSend } from '../services/crmSenderService';
import { CrmSender } from '../services/crmSenderTypes';
import { sendAsSender } from '../services/sendAsSender';
import { fetchPublicHtml, SsrfBlockedError } from '../utils/ssrfGuard';
import { extractVariables, leadHasVariable, isSupportedVariable, injectUnsubscribeUrl, inlineEmailStyles, rewriteS3ImageUrls, normalizeYoutubeUrls } from '../utils/emailVariables';
import { LLMService } from '../utils/llmService';
import { LEAD_LIFECYCLES, defaultStatusConfigFor } from '../utils/leadSchema';
import { computeLifecycle, LifecycleStage } from '../services/lifecycleService';
import {
  requiredChannels, leadIsReachable, skipKeyForChannels, enrollmentIdentity,
  enrollmentIdentityCandidates,
} from '../utils/leadReachability';

/**
 * ENG-2127: the by-list enrol accepts a `lifecycle` filter and hands it to
 * crmDb.getLeadsByStatus, which queries the `status` attribute on listId-status-index and
 * never reads `lifecycle` at all. The two vocabularies are disjoint — measured against
 * production, `status` holds contacted/new/qualified/open/lost/closed/won/… while
 * `lifecycle` holds inbox/signed_up — so a lifecycle-filtered enrol can never match
 * anything. It returns an empty array, which is a legitimate result, so the caller reports
 * "0 leads enrolled" and nothing anywhere says why.
 *
 * Fixing it properly means deciding what the filter should mean (a listId-lifecycle-index,
 * or dropping the control) and is tracked on ENG-2127. Until then this at least refuses to
 * fail silently.
 */
const LIFECYCLE_STAGES: ReadonlySet<string> = new Set<string>(LEAD_LIFECYCLES);

function lifecycleForLead(lead: any): LifecycleStage {
  const currentLifecycle = LIFECYCLE_STAGES.has(lead?.lifecycle)
    ? lead.lifecycle as LifecycleStage
    : undefined;
  const computed = computeLifecycle({
    email: lead?.email ?? undefined,
    phone: lead?.phone ?? undefined,
    domain: lead?.domain ?? undefined,
    hasUserRecord: lead?.hasUserRecord ?? undefined,
    subscriptionState: lead?.subscriptionState ?? undefined,
    lastActivityAt: lead?.lastActivityAt ?? undefined,
    lastUsageAt: lead?.lastUsageAt ?? undefined,
    healthScore: lead?.healthScore ?? undefined,
    currentLifecycle,
    openDealStages: lead?.openDealStages ?? undefined,
  });

  if (!currentLifecycle || computed === currentLifecycle) return computed;

  const subscriptionIsDefinitive =
    lead?.subscriptionState === 'active' ||
    lead?.subscriptionState === 'trialing' ||
    lead?.subscriptionState === 'past_due' ||
    lead?.subscriptionState === 'canceled';
  const hasOpenDeal =
    Array.isArray(lead?.openDealStages) && lead.openDealStages.length > 0;
  const dealCanPromoteCurrent =
    hasOpenDeal &&
    (currentLifecycle === 'unknown' ||
      currentLifecycle === 'inbox' ||
      currentLifecycle === 'signed_up');
  const provesSignup =
    lead?.hasUserRecord === true &&
    (currentLifecycle === 'unknown' || currentLifecycle === 'inbox');

  const nowMs = Date.now();
  const ageDays = (value: unknown): number | null => {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed) || parsed > nowMs) return null;
    return (nowMs - parsed) / (24 * 60 * 60 * 1000);
  };
  const activityProvesChurn = (ageDays(lead?.lastActivityAt) ?? 0) > 60;
  const payingOrAtRisk =
    currentLifecycle === 'paying' || currentLifecycle === 'at_risk';
  const healthProvesRisk =
    payingOrAtRisk &&
    typeof lead?.healthScore === 'number' &&
    lead.healthScore < 40;
  const usageProvesRisk =
    payingOrAtRisk && (ageDays(lead?.lastUsageAt) ?? 0) > 30;

  return subscriptionIsDefinitive ||
    dealCanPromoteCurrent ||
    provesSignup ||
    activityProvesChurn ||
    healthProvesRisk ||
    usageProvesRisk
    ? computed
    : currentLifecycle;
}

async function getAllLeadsByStatus(
  listId: string,
  status: string,
  pageSize = 200,
): Promise<any[]> {
  const items: any[] = [];
  let lastKey: any = undefined;
  do {
    const page = await crmDb.getLeadsByStatus(listId, status, pageSize, lastKey);
    if (Array.isArray(page)) return page;
    items.push(...((page as any).items ?? (page as any).leads ?? []));
    lastKey = (page as any).lastEvaluatedKey;
  } while (lastKey);
  return items;
}

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

// ENG-2205: a step's linkedInAccountId is the Unipile account the drip worker will SEND from.
// It arrives in the request body, so it must be an account the caller owns or that is shared with
// their org — otherwise any user could name the site-wide pool account (whose id is disclosed in
// agent tool responses) or another customer's account and have the worker send from it. Same
// check send-linkedin-message/-invite, withdraw and accept-invitation already apply.
const LINKEDIN_STEP_ACCOUNT_ERROR = 'A LinkedIn step references an account that is not connected to your user.';

// `alreadyPinned` (PUT only) holds the account ids already stored on the caller's own sequence. Those are not
// re-validated: a user can legitimately have a sequence whose pinned account was later disconnected, and an
// unrelated edit must still save. They cannot be abused to send, because the drip worker re-checks the pin at
// send time. Only a NEW or CHANGED pin has to be an account the caller owns or shares.
// Mirrors the drip worker's channel derivation (dripSequenceWorker.ts): a step is a LinkedIn step only when its
// channel normalises to 'linkedin'. A pin left behind on an email step is never used to send, so it is neither
// validated here nor trusted as an already-stored pin.
const isLinkedInChannelStep = (step: any): boolean =>
  String(step?.channel ?? 'email').trim().toLowerCase() === 'linkedin';

async function stepsReferenceForeignLinkedInAccount(
  userId: string,
  steps: unknown,
  alreadyPinned: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  if (!Array.isArray(steps)) return false;
  const { resolveLinkedInAccountForWrite } = await import('../services/agentMode/linkedInDailyVolumeGate');
  for (const step of steps) {
    if (!isLinkedInChannelStep(step)) continue; // pin on a non-LinkedIn step is inert
    const id = step?.linkedInAccountId;
    if (id === undefined || id === null || id === '') continue; // auto-resolved by the worker
    if (typeof id !== 'string') return true;
    if (alreadyPinned.has(id)) continue;
    if (!(await resolveLinkedInAccountForWrite(userId, id))) return true;
  }
  return false;
}

// POST /api/crm/sequences
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { name, description, campaignType, enrollmentTrigger, enrollmentCondition, exitConditions, steps, status } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    if (await stepsReferenceForeignLinkedInAccount(authReq.user!.userId, steps)) {
      return res.status(403).json({ error: LINKEDIN_STEP_ACCOUNT_ERROR });
    }
    const input: CreateSequenceInput = {
      userId: authReq.user!.userId,
      name: name.trim(),
      description,
      campaignType,
      enrollmentTrigger,
      enrollmentCondition,
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
    // ENG-2573: read-only hint so UI/Emma can warn that open/click exits may be machine-triggered.
    const { machineSusceptibleExits } = await import('../services/exitConditionTrust');
    res.json({ sequence, machineSusceptibleExits: machineSusceptibleExits(sequence.exitConditions) });
  } catch (err) {
    console.error('[sequences] getSequence error:', err);
    res.status(500).json({ error: 'Failed to fetch sequence' });
  }
});

// PUT /api/crm/sequences/:sequenceId
router.put('/:sequenceId', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { name, description, campaignType, enrollmentTrigger, enrollmentCondition, exitConditions, autoEnrollListIds, steps, status, expectedUpdatedAt, requireStatusNot } = req.body;
  try {
    // ENG-2311: auto-enrolment is driven solely by autoEnrollListIds, so refusing a session
    // list HERE (the only writer besides by-list enrol, guarded below) keeps every enrol path
    // — crm.ts, webhooks.ts, imports — from ever seeing a sequence bound to one.
    if (Array.isArray(autoEnrollListIds)) {
      for (const lid of autoEnrollListIds) {
        const bound = typeof lid === 'string' && lid ? await crmDb.getLeadListById(lid).catch(() => null) : null;
        if (isSessionList(bound)) return res.status(400).json({ error: SESSION_LIST_SEQUENCE_ERROR });
      }
    }
    // Only trust the stored pins of the CALLER's own sequence (updateSequence rejects anyone else below).
    // A failed read is NOT treated as "no stored pins": that would turn a transient DynamoDB error into a
    // misleading 403. It propagates to the generic handler (500, retryable) like updateSequence's own read would.
    const stored = Array.isArray(steps) ? await dripSequenceDb.getSequence(req.params.sequenceId) : null;
    const alreadyPinned = new Set<string>(
      stored && stored.userId === authReq.user!.userId
        ? (stored.steps ?? [])
            .filter(isLinkedInChannelStep)
            .map((st: any) => st?.linkedInAccountId)
            .filter((v: unknown): v is string => typeof v === 'string' && !!v)
        : [],
    );
    if (await stepsReferenceForeignLinkedInAccount(authReq.user!.userId, steps, alreadyPinned)) {
      return res.status(403).json({ error: LINKEDIN_STEP_ACCOUNT_ERROR });
    }
    const input: UpdateSequenceInput = {
      name,
      description,
      campaignType,
      enrollmentTrigger,
      enrollmentCondition,
      exitConditions,
      autoEnrollListIds,
      steps,
      status,
    };
    const guard: { expectedUpdatedAt?: string; requireStatusNot?: SequenceStatus } = {
      ...(typeof expectedUpdatedAt === 'string' ? { expectedUpdatedAt } : {}),
      ...(['draft', 'active', 'paused', 'archived'].includes(requireStatusNot) ? { requireStatusNot: requireStatusNot as SequenceStatus } : {}),
    };
    const sequence = Object.keys(guard).length > 0
      ? await dripSequenceDb.updateSequence(req.params.sequenceId, authReq.user!.userId, input, guard)
      : await dripSequenceDb.updateSequence(req.params.sequenceId, authReq.user!.userId, input);
    res.json({ sequence });
  } catch (err: any) {
    if (err?.name === 'SequenceConflictError') return res.status(409).json({ error: err.message, code: 'sequence_conflict' });
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

      // Reachability is decided from the CRM ROW, not the request body. This route's
      // payload is `{ listId, leadId, leadEmail }` — `linkedin` was never part of its
      // contract, so reading `l.linkedin` here meant every lead looked unreachable to a
      // LinkedIn sequence and the route enrolled NOBODY. That is the identical regression
      // this guard was introduced to fix, reintroduced on the sibling route; the by-list
      // route escaped it only because it reads real rows. The lead is loaded once per
      // entry and reused for the identity below.
      const channels = requiredChannels(sequence);

      // AUTHORIZE EVERY LIST BEFORE READING ANY LEAD.
      //
      // `listId` and `leadId` come straight out of the request body, and `getLeadById` is
      // a bare GetItem with no ownership filter. Authorizing only the SEQUENCE — which is
      // all this route did — let a caller read any lead row in the table through their own
      // sequence: the skipped-count became a per-lead "does this lead have an email"
      // oracle, and the victim's address was written into the caller's enrollment and
      // handed back by GET /:sequenceId/enrollments. Before this commit the route touched
      // no CRM data at all, so adding the read added the hole. The sibling by-list route
      // has always done exactly this check.
      //
      // Deduped: one authorization per distinct listId, not per lead.
      const listIds = Array.from(new Set(leads.map((l: any) => String(l.listId ?? ''))));
      const listAuth = new Map<string, boolean>();
      const sessionListIdsInRequest: string[] = [];
      for (const lid of listIds) {
        if (!lid) { listAuth.set(lid, false); continue; }
        const list = await crmDb.getLeadListById(lid).catch(() => null);
        listAuth.set(lid, !!list && await crmDb.canOrgMemberAccessList(authReq.user!.userId, list));
        if (isSessionList(list)) sessionListIdsInRequest.push(lid);
      }
      if (sessionListIdsInRequest.length > 0) {
        return res.status(400).json({ error: SESSION_LIST_SEQUENCE_ERROR });
      }
      const unauthorized = listIds.filter((lid) => !listAuth.get(lid));
      if (unauthorized.length > 0) {
        // Refuse the whole call rather than silently enrolling the authorized subset —
        // a partial success here is indistinguishable from "that lead was unreachable",
        // which is the oracle this guard exists to close.
        return res.status(403).json({ error: 'Forbidden' });
      }

      // BatchGetItem-style chunking rather than one promise per lead: `leads` is
      // caller-supplied and capped only by the 50mb body limit, so an unbounded
      // Promise.all over it is a self-inflicted load problem — and a throttled read
      // degrades to the payload, which for a LinkedIn sequence means reporting the
      // caller's own leads as unreachable.
      const CHUNK = 25;
      const resolved: Array<{ input: any; lead: any; readFailed: boolean }> = [];
      for (let i = 0; i < leads.length; i += CHUNK) {
        const batch = await Promise.all(leads.slice(i, i + CHUNK).map(async (l: any) => {
          // Promise.resolve().then(...) so a SYNCHRONOUS throw is caught too — a bare
          // `.catch()` only handles a rejection.
          const row = await Promise.resolve()
            .then(() => crmDb.getLeadById(l.listId, l.leadId))
            .catch(() => null);
          // `||` not `??`: a row that exists with `email: ''` must not block an address
          // the caller supplied. `??` only falls through on null/undefined, so an empty
          // string on the row dropped a lead the caller could legitimately enrol.
          //
          // `linkedin` comes ONLY from the CRM row. This route's payload contract is
          // { listId, leadId, leadEmail } — `linkedin` was never part of it, and
          // honouring it let a caller enrol a genuinely unreachable lead by supplying a
          // profile URL the lead does not have, under a dedup identity of their
          // choosing. leadEmail stays honoured because it IS in the contract.
          return {
            input: l,
            lead: {
              email: (row as any)?.email || l.leadEmail || l.email || '',
              linkedin: (row as any)?.linkedin || '',
            },
            readFailed: row === null,
          };
        }));
        resolved.push(...batch);
      }
      const enrollable = resolved.filter((r) => leadIsReachable(r.lead, channels));
      // Separate "we could not check" from "we checked and cannot reach".
      //
      // readFailed was computed and then never read. A throttled or failing getLeadById
      // leaves the lead with no CRM data, so for a LinkedIn sequence it falls out as
      // unreachable and is reported in the same bucket as a lead that genuinely has no
      // profile — indistinguishable from real data, and silently lost. A deleted lead
      // takes the same path, which is fine; the point is that the caller can tell.
      const notEnrollable = resolved.filter((r) => !leadIsReachable(r.lead, channels));
      const skippedReadFailed = notEnrollable.filter((r) => r.readFailed).length;
      const skippedUnreachable = notEnrollable.length - skippedReadFailed;
      const inputs = enrollable.map((r) => ({
        sequenceId: req.params.sequenceId,
        userId: authReq.user!.userId,
        listId: r.input.listId,
        leadId: r.input.leadId,
        leadEmail: enrollmentIdentity(r.lead),
        identityCandidates: enrollmentIdentityCandidates(r.lead),
        startAt: startAt ?? undefined,
      }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      const skipKey = skipKeyForChannels(channels);
      res.json({
        ...result,
        ...(skippedUnreachable > 0 ? { [skipKey]: skippedUnreachable } : {}),
        ...(skippedReadFailed > 0 ? { skippedReadFailed } : {}),
      });
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
    const { listId, lifecycle, status: rawStatus, startAt, confirm } = req.body;
    // Blank status is absent, including for lifecycle validation and auto-enrollment.
    const status = rawStatus != null && String(rawStatus).trim() !== '' ? String(rawStatus) : undefined;
    if (!listId) return res.status(400).json({ error: 'listId is required' });

    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
      if (sequence.steps.length === 0) {
        return res.status(400).json({ error: 'Sequence has no steps' });
      }

      // Verify the caller owns (or org-shares) the list before reading its leads.
      const list = await crmDb.getLeadListById(listId);
      if (!list) return res.status(404).json({ error: 'List not found' });
      if (!(await crmDb.canOrgMemberAccessList(authReq.user!.userId, list))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      // ENG-2311: a session list's rows are per-visit telemetry, never enrolled in sequences.
      if (isSessionList(list)) return res.status(400).json({ error: SESSION_LIST_SEQUENCE_ERROR });

      // The historical request field `lifecycle` also carried lead status values.
      // Keep that compatibility for current or still-materialized legacy statuses, while
      // lifecycle-only values are derived from the complete lead rows.
      const storedStatusConfig = (list as any)?.statusConfig;
      const effectiveStatusConfig = Array.isArray(storedStatusConfig) && storedStatusConfig.length > 0
        ? storedStatusConfig
        : defaultStatusConfigFor((list as any)?.listType);
      const listStatuses = new Set(effectiveStatusConfig.map((entry: any) => String(entry?.value)));
      // Defaults are not a stored vocabulary: older lists may have arbitrary statuses.
      if (status != null && Array.isArray(storedStatusConfig) && storedStatusConfig.length > 0 && !listStatuses.has(status)) {
        return res.status(400).json({
          error: 'invalid_status',
          message: `Unknown status "${status}". Allowed values: ${Array.from(listStatuses).join(', ')}.`,
        });
      }

      const legacyValue = lifecycle != null ? String(lifecycle) : undefined;
      // With both fields supplied, lifecycle is canonical (not the legacy status alias).
      // Validate it even when a status query would otherwise return no candidates.
      if (status != null && legacyValue !== undefined && !LIFECYCLE_STAGES.has(legacyValue)) {
        return res.status(400).json({
          error: 'invalid_lifecycle',
          message: `Unknown lifecycle stage "${legacyValue}". Use status for custom lead statuses.`,
        });
      }
      const legacyIsLifecycle =
        legacyValue !== undefined &&
        LIFECYCLE_STAGES.has(legacyValue) &&
        (status != null || !listStatuses.has(legacyValue));

      let legacyStatusProbeLeads: any[] | undefined;
      if (
        status == null &&
        legacyValue !== undefined &&
        !legacyIsLifecycle &&
        !listStatuses.has(legacyValue)
      ) {
        legacyStatusProbeLeads = await getAllLeadsByStatus(listId, legacyValue);
        if (legacyStatusProbeLeads.length === 0) {
          return res.status(400).json({
            error: 'invalid_lifecycle',
            message: `Unknown lifecycle stage "${legacyValue}". Use status for custom lead statuses.`,
          });
        }
      }

      const requestedStatus = status != null
        ? String(status)
        : (legacyValue && !legacyIsLifecycle ? legacyValue : undefined);
      const requestedLifecycle = legacyIsLifecycle ? legacyValue : undefined;

      let leads: any[];
      if (requestedStatus) {
        if (legacyStatusProbeLeads !== undefined) {
          leads = legacyStatusProbeLeads;
        } else {
          leads = await getAllLeadsByStatus(listId, requestedStatus);
        }
      } else if (requestedLifecycle) {
        const allLeads = await crmDb.getAllLeadsByListId(listId);
        leads = allLeads.filter(
          (lead: any) => lifecycleForLead(lead) === requestedLifecycle,
        );
      } else {
        leads = await crmDb.getAllLeadsByListId(listId);
      }
      // Both filters are an intersection: status match AND derived lifecycle match.
      if (requestedStatus && requestedLifecycle) {
        leads = leads.filter((lead: any) => lifecycleForLead(lead) === requestedLifecycle);
      }

      // Filtered HERE, before coverage — not at the mapper. A lead the sequence can reach
      // on no channel would enrol into a row that skips every step and completes having
      // sent nothing; and an empty identity is the leadEmail-index partition key, so the
      // row is invisible to getExistingEnrollment and is re-created on every run.
      //
      // (The older rationale — that the worker RETHROWS and the enrollment retries
      // forever — described behaviour that has since been fixed: undeliverable steps are
      // skipped now. Left corrected rather than deleted because that change is precisely
      // why this test is at-least-one rather than every-channel.)
      //
      // Filtering up front rather than at the mapper keeps one population throughout:
      // leadCount, the missing/present warning counts and the confirm gate all describe
      // exactly the leads that will be enrolled. Filtering later made the dialog report a
      // different set than the one it enrolled — and could raise needsConfirmation over
      // variables missing only on leads that were never candidates.
      //
      // Email-less leads were already reachable (LinkedIn imports, the invite mirror);
      // ENG-2082 made a whole new list type produce them.
      // Both counts, deliberately. Filtering silently would shrink leadCount from 100 to 20
      // with nothing on screen to explain where 80 went — the dialog would look like leads
      // had vanished. Reporting the population AND the enrollable subset lets the caller say
      // "20 of 100 leads can be emailed", which is the true statement.
      const totalLeads = leads.length;
      // Channel-aware: the first version tested `l.email` only, which excluded a
      // LinkedIn-only lead from a LinkedIn sequence the worker could actually deliver.
      const channels = requiredChannels(sequence);
      leads = leads.filter((l: any) => leadIsReachable(l, channels));
      const enrollableLeads = leads.length;

      // Variable coverage across all steps + channels (email subject/body + LinkedIn
      // messageText). Warn — but allow override via `confirm` — when a supported
      // variable is missing for any lead, or an unsupported token is referenced.
      const templateText = sequence.steps
        .map((s: any) => `${s.subject ?? ''} ${s.bodyHtml ?? ''} ${s.messageText ?? ''}`)
        .join(' ');
      const vars = extractVariables(templateText)
        .filter((v) => v !== 'senderName' && v !== 'senderEmail');
      const unsupported = vars.filter((v) => !isSupportedVariable(v));
      const supported = vars.filter((v) => isSupportedVariable(v));
      const missing: { variable: string; missing: number; present: number }[] = [];
      for (const v of supported) {
        let miss = 0;
        let pres = 0;
        for (const lead of leads) {
          if (leadHasVariable(lead, v)) pres++;
          else miss++;
        }
        if (miss > 0) missing.push({ variable: v, missing: miss, present: pres });
      }

      if ((unsupported.length > 0 || missing.length > 0) && !confirm) {
        return res.json({
          enrolled: false,
          needsConfirmation: true,
          leadCount: leads.length,
          totalLeads,
          enrollableLeads,
          ...(totalLeads > enrollableLeads ? { [skipKeyForChannels(channels)]: totalLeads - enrollableLeads } : {}),
          warnings: { unsupported, missing },
        });
      }

      const inputs = leads
        .map((l: any) => ({
          sequenceId: req.params.sequenceId,
          userId: authReq.user!.userId,
          listId,
          leadId: l.leadId,
          leadEmail: enrollmentIdentity(l),
          identityCandidates: enrollmentIdentityCandidates(l),
          startAt: startAt ?? undefined,
        }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      const counts = {
        totalLeads,
        enrollableLeads,
        ...(totalLeads > enrollableLeads ? { [skipKeyForChannels(channels)]: totalLeads - enrollableLeads } : {}),
      };

      // Auto-enroll is on by default: add listId to sequence's autoEnrollListIds
      // unless it's already there. This means new leads added to this list later
      // will be automatically enrolled.
      const existing = sequence.autoEnrollListIds ?? [];
      // A filtered enrollment is a one-shot selection. Persisting only the list id would
      // discard the filter and auto-enroll every future lead from the list.
      if (!requestedStatus && !requestedLifecycle && !existing.includes(listId)) {
        void dripSequenceDb.updateSequence(req.params.sequenceId, authReq.user!.userId, {
          autoEnrollListIds: [...existing, listId],
        }).catch((e) => console.error('[sequences] autoEnrollListIds update error:', e));
      }

      res.json({ ...result, ...counts });
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

// ─── Step Utilities ───────────────────────────────────────────────────────────

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/test-email
 * @desc Send a test email for a specific step's content
 */
router.post(
  '/:sequenceId/steps/test-email',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { senderId, senderEmail, senderName, subject, htmlContent, recipients } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!senderEmail || !senderName || !subject || !htmlContent) {
      return res.status(400).json({ message: 'senderEmail, senderName, subject, and htmlContent are required' });
    }

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = recipients.filter((e: string) => emailRegex.test(e.trim()));

    if (validEmails.length === 0) {
      return res.status(400).json({ message: 'No valid email addresses provided' });
    }

    const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
    const testUnsubscribeUrl = `${CUSTOMER_FRONTEND_URL}/crm-unsubscribe?listId=TEST&leadId=TEST&email=${encodeURIComponent(recipients[0]?.trim() || 'test@example.com')}`;

    const testBanner = `<div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">TEST EMAIL - This is a test sequence step email</div>`;

    // Inject banner: inside <body> for full HTML documents, or prepend for fragments
    const withBanner = /<body\b/i.test(htmlContent)
      ? htmlContent.replace(/<body([^>]*)>/i, `<body$1>${testBanner}`)
      : testBanner + htmlContent;
    // Rewrite S3 image URLs through the asset proxy (same as production send path).
    // Use EMAIL_ASSET_BASE_URL so URLs in emails are publicly accessible even when
    // the test send originates from a dev environment with a private BACKEND_URL.
    const assetBaseUrl = process.env.EMAIL_ASSET_BASE_URL || 'https://api.agentweb.pro';
    const withRewrittenImages = rewriteS3ImageUrls(withBanner, assetBaseUrl);
    const withNormalizedUrls = normalizeYoutubeUrls(withRewrittenImages);
    // Wire up unsubscribe URL with the real portal domain
    const testHtml = injectUnsubscribeUrl(withNormalizedUrls, testUnsubscribeUrl);

    // ENG-266 Part 3: route through the sender's real provider (same fallback pattern
    // as the crm.ts send sites).
    const resolvedSender = await resolveSenderForSend(userId, senderId, senderEmail);
    const sender: CrmSender = resolvedSender ?? {
      id: '__adhoc__',
      email: senderEmail,
      fromName: senderName,
      senderProvider: 'resend',
    };

    let sent = 0;
    let failedCount = 0;
    const failedEmails: string[] = [];
    const failureReasons: Array<{ email: string; reason: string }> = [];

    for (const email of validEmails) {
      try {
        await sendAsSender(userId, sender, {
          to: email.trim(),
          subject: `[TEST] ${subject}`,
          html: testHtml,
        });
        sent++;
      } catch (err: any) {
        const reason = err.message || String(err);
        console.error(`[sequences] Failed to send test email to ${email}:`, reason);
        failedCount++;
        failedEmails.push(email);
        failureReasons.push({ email, reason });
      }
    }

    return res.json({
      total: validEmails.length,
      sent,
      failed: failedCount,
      failedEmails,
      failureReasons,
    });
  },
);

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/spam-check
 * @desc Use Claude to analyse the email for spam/deliverability issues
 */
router.post(
  '/:sequenceId/steps/spam-check',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { subject, htmlContent, senderEmail } = req.body;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!subject || !htmlContent) return res.status(400).json({ message: 'subject and htmlContent are required' });

    try {
      const llm = new LLMService('anthropic.claude-sonnet-4-6', 0, 2000);
      const systemPrompt = `You are an email deliverability expert. Analyse the provided marketing email for spam and deliverability issues.

Return a JSON object with this exact shape:
{
  "passed": boolean,
  "issues": [
    {
      "severity": "error or warning",
      "code": "SNAKE_CASE_CODE",
      "message": "One-sentence description of the issue and why it matters."
    }
  ]
}

Severity rules:
- "error": will definitely cause spam filtering (broken/missing unsubscribe link, deceptive content, URL mismatch)
- "warning": reduces deliverability score (spam trigger words, missing physical address, external font loading, HTML-only with no text alternative, suspicious sender domain)

IMPORTANT — template variables: This is a drip sequence template. Placeholders like {{unsubscribeUrl}}, {{firstName}}, {{email}}, {{companyName}} are intentional template variables that will be replaced with real values at send time. Do NOT flag these as broken links or missing content.

IMPORTANT — image hosting: Images hosted on api.agentweb.pro/asset/ are served through our own domain proxy and are fine. Flag images whose src domain does not match the sending domain AND is not api.agentweb.pro (e.g. raw S3 URLs, external CDNs).

Be precise. Only report genuine issues. If the email looks clean, return an empty issues array.`;

      const userPrompt = `Sender email: ${senderEmail ?? 'not provided'}\nSubject: ${subject}\n\nHTML:\n${htmlContent}`;

      const parsed = await llm.generateJsonRobust<{ passed: boolean; issues: any[] }>(systemPrompt, userPrompt, undefined, {
        userId,
        feature: 'content_gen',
      });
      const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
      const errors = issues.filter((i: any) => i.severity === 'error');
      return res.json({
        passed: errors.length === 0,
        issues,
        errorCount: errors.length,
        warningCount: issues.length - errors.length,
      });
    } catch (err: any) {
      console.error('[spam-check] LLM error:', err.message || err);
      return res.status(500).json({ message: 'Spam check failed' });
    }
  },
);

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/spam-repair
 * @desc Use Claude to fix all spam/deliverability issues in the email.
 *
 * Body:
 *   subject      — current subject line
 *   htmlContent  — current email HTML
 *   issues       — the issues array returned by spam-check
 *   context      — optional free-text user context (e.g. "company is Acme Corp, address is 123 Main St")
 */
router.post(
  '/:sequenceId/steps/spam-repair',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { subject, htmlContent, issues, context = '' } = req.body as {
      subject: string;
      htmlContent: string;
      issues: Array<{ severity: string; code: string; message: string }>;
      context?: string;
    };

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!htmlContent || !Array.isArray(issues) || issues.length === 0) {
      return res.status(400).json({ message: 'htmlContent and issues[] are required' });
    }

    try {
      const llm = new LLMService('anthropic.claude-sonnet-4-6', 0, 16000);
      const issueList = issues.map(i => `- [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`).join('\n');
      const contextSection = context.trim() ? `\nUser-provided context:\n${context.trim()}\n` : '';

      const systemPrompt = `You are an expert email developer fixing spam and deliverability issues in a marketing email.

Fix EVERY issue listed below. Rules:
1. For unsubscribe links: use {{unsubscribeUrl}} as the href — do NOT invent a URL. If there is no unsubscribe link at all, add a simple unsubscribe footer before </body>.
2. For external font loading (Google Fonts <link> tags, @import url()): remove them entirely from the HTML.
3. For missing physical address: add it to the footer using the user-provided context. If no address is given in context, add a placeholder "[Company Name, Street Address, City, State ZIP]" styled as small grey text.
4. For spam trigger words in the subject: rewrite the subject to communicate the same intent without the triggering words.
5. Preserve the email's visual design, brand, and all content exactly — only make the targeted fixes.

Return your response in this exact format:
<subject>updated subject line here</subject>
<html_content>complete fixed HTML here</html_content>`;

      const userPrompt = `Issues to fix:\n${issueList}\n${contextSection}\nSubject: ${subject}\n\nHTML:\n${htmlContent}`;

      const rawText = await llm.generateRaw(systemPrompt, userPrompt, undefined, {
        userId,
        feature: 'content_gen',
      });

      const htmlMatch = rawText.match(/<html_content>([\s\S]*?)<\/html_content>/i);
      const subjectMatch = rawText.match(/<subject>([\s\S]*?)<\/subject>/i);

      if (!htmlMatch) {
        console.error('[spam-repair] LLM did not return expected tags. Raw:', rawText.slice(0, 500));
        return res.status(500).json({ message: 'Repair failed: model did not return expected format' });
      }

      return res.json({
        subject: subjectMatch ? subjectMatch[1].trim() : subject,
        htmlContent: htmlMatch[1].trim(),
      });
    } catch (err: any) {
      console.error('[spam-repair] LLM error:', err.message || err);
      return res.status(500).json({ message: 'Repair failed' });
    }
  },
);

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/verify-variables
 * @desc Verify template variables in subject+html are covered by leads in enrolled lists
 */
router.post(
  '/:sequenceId/steps/verify-variables',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { subject, htmlContent, listId } = req.body;

      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // AUTHORIZE BEFORE READING ANYTHING.
      //
      // This route read three things belonging to whoever the ids pointed at, with no
      // ownership check of any kind: the list's leads, the sequence definition, and — in
      // the else-branch — the sequence's enrollments and then each enrolled lead. Both
      // ids come straight from the request, so a caller could aim it at another tenant
      // and read back `totalLeads`, per-variable coverage counts, and a skip-reason key
      // whose NAME leaks whether the victim's sequence contains a LinkedIn step.
      //
      // The sibling enrol-by-list route has always done exactly these two checks. This
      // one is a copy of that check, not an invention.
      //
      // The 'test' sentinel keeps its existing meaning: no sequence to authorize.
      const hasSequence = !!req.params.sequenceId && req.params.sequenceId !== 'test';
      const sequenceForVerify = hasSequence
        ? await dripSequenceDb.getSequence(req.params.sequenceId).catch(() => null)
        : null;
      if (hasSequence) {
        if (!sequenceForVerify) return res.status(404).json({ error: 'Sequence not found' });
        if (sequenceForVerify.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
      }
      if (listId) {
        const list = await crmDb.getLeadListById(listId).catch(() => null);
        if (!list) return res.status(404).json({ error: 'List not found' });
        if (!(await crmDb.canOrgMemberAccessList(userId, list))) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }

      const allTemplate = (subject || '') + (htmlContent || '');
      const variables = extractVariables(allTemplate);

      let leads: any[] = [];
      let verifyTotalLeads = 0;
      // Declared out here so the response below can name the skip reason after the
      // channel that was actually missing, the same way the two enrol routes do.
      let verifyChannels = new Set<string>(['email']);
      if (listId) {
        // getAllLeadsByListId, not getLeadsByListId.
        //
        // getLeadsByListId returns ONE ~1MB DynamoDB page; db.ts says verbatim "Use this
        // anywhere a complete list is required (enrollment, coverage counts)". The enrol
        // route paginates, so on any list over a page this screen reported coverage over
        // a different, smaller population than the one that gets enrolled — while the
        // comment here claimed they matched. Two screens, same list, contradictory
        // numbers, and coverage warnings computed from a truncated sample.
        const leadsResult = await crmDb.getAllLeadsByListId(listId);
        leads = Array.isArray(leadsResult)
          ? leadsResult
          : ((leadsResult as any).items ?? (leadsResult as any).leads ?? []);
        // Same population the enrol routes use. Without this, this screen reported variable
        // coverage over leads enrol-by-list will never enrol — two screens, same list,
        // contradictory numbers, and coverage warnings raised over rows that were never
        // candidates. ENG-2082 made address-less leads common enough to diverge visibly.
        verifyTotalLeads = leads.length;
        // Mirrors the enrol routes exactly — including their channel awareness, or this
        // screen reports coverage over a different population again.
        verifyChannels = requiredChannels(sequenceForVerify);
        leads = leads.filter((l: any) => leadIsReachable(l, verifyChannels));
      } else if (req.params.sequenceId && req.params.sequenceId !== 'test') {
        // Verify against the sequence's enrolled leads
        const enrollments = await dripSequenceDb.listEnrollmentsForSequence(req.params.sequenceId);
        const leadFetches = enrollments.map((e) =>
          crmDb.getLeadById(e.listId, e.leadId).catch(() => null),
        );
        leads = (await Promise.all(leadFetches)).filter(Boolean);
      }

      const variableCoverage: Record<string, { present: number; missing: number }> = {};
      for (const v of variables) {
        variableCoverage[v] = { present: 0, missing: 0 };
      }

      for (const lead of leads) {
        for (const v of variables) {
          if (leadHasVariable(lead, v)) {
            variableCoverage[v].present++;
          } else {
            variableCoverage[v].missing++;
          }
        }
      }

      return res.json({
        variables,
        variableCoverage,
        leadCount: leads.length,
        ...(verifyTotalLeads > leads.length
          ? { totalLeads: verifyTotalLeads, [skipKeyForChannels(verifyChannels)]: verifyTotalLeads - leads.length }
          : {}),
      });
    } catch (error) {
      console.error('[sequences] verify-variables error:', error);
      return res.status(500).json({ message: 'Failed to verify variables' });
    }
  },
);

/**
 * @route POST /api/crm/sequences/load-from-url
 * @desc Load HTML content from a URL for use in sequence step editing
 */
router.post('/load-from-url', authenticateToken, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { url } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ message: 'URL is required and must be a string' });
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ message: 'Invalid URL format. Must be HTTP or HTTPS.' });
    }

    // ENG-2425: SSRF-safe (DNS-pinned, per-hop re-validated, size-capped).
    let html: string;
    try {
      html = await fetchPublicHtml(url);
    } catch (fetchErr) {
      if (fetchErr instanceof SsrfBlockedError) {
        return res.status(400).json({ message: 'URL must point to a public internet address' });
      }
      throw fetchErr;
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let extractedTitle = titleMatch ? titleMatch[1].trim() : '';
    if (!extractedTitle) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      extractedTitle = h1Match ? h1Match[1].trim() : 'Newsletter';
    }
    extractedTitle = extractedTitle
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    let bodyContent = '';

    // If this is a complete HTML email document, preserve it as-is (only strip scripts).
    // Stripping <style> or collapsing whitespace destroys email formatting.
    const isFullHtmlDocument = /<html[\s>]/i.test(html);
    if (isFullHtmlDocument) {
      bodyContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
    } else {
      // For plain HTML fragments, extract body content and clean up
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      bodyContent = bodyMatch ? bodyMatch[1] : html;

      bodyContent = bodyContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

      // Try to extract main content from semantic tags
      const mainContentSelectors = [
        /<main[^>]*>([\s\S]*?)<\/main>/i,
        /<article[^>]*>([\s\S]*?)<\/article>/i,
        /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      ];
      for (const selector of mainContentSelectors) {
        const match = bodyContent.match(selector);
        if (match && match[1].trim().length > 50) {
          bodyContent = match[1];
          break;
        }
      }

      bodyContent = bodyContent
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .replace(/>\s+</g, '><')
        .trim();
    }

    if (bodyContent.length > 200000) {
      bodyContent = bodyContent.substring(0, 200000);
    }

    // Convert class-based CSS to inline styles now so the stored HTML is email-client-safe.
    // Doing this at import time avoids the LLM call at every test-send or real send.
    // ENG-1961: the inlining LLM call is this user's import, not "system".
    const { html: inlinedContent } = await inlineEmailStyles(bodyContent, { userId });

    return res.json({
      success: true,
      title: extractedTitle,
      message: inlinedContent,
    });
  } catch (error: any) {
    console.error('[sequences] load-from-url error:', error.message || error);
    return res.status(500).json({ message: 'Failed to load content from URL' });
  }
});

export default router;
