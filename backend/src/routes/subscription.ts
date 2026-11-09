import express from 'express';
import { authenticateToken } from '../middleware/auth';
import {
  recordRecommendationDeclined,
  InvalidDeclineInputError,
  MAX_DECLINE_SELECTIONS,
} from '../services/llmUsageDeclineService';
import { getCustomerPortalPages } from '../services/customerPortalPages';
import { checkTokenUsage } from '../services/tokenUsageService';
import { buildModelUnavailableBody, isModelUnavailableError } from '../services/agentMode/modelUnavailable';
import { agentModeService } from '../services/agentModeService';
import { resolveUsageRunway } from '../services/llmUsageRunwayResolverService';
import { toCustomerRunway } from '../services/llmUsageForecastService';
import { resolveUsageDrivers, toCustomerDrivers, previewUsageRunway } from '../services/llmUsageDriversResolverService';
import {
  applyModelChange,
  undoModelChange,
  ModelChangeConflictError,
  ModelChangeNotFoundError,
  ModelChangeForbiddenError,
  ModelNotAvailableError,
} from '../services/llmModelChangeService';
import { recordUsageAlertEvent, InvalidAlertEventError } from '../services/llmUsageAlertEventService';
import { resolveBillingUserId, toCustomerTokenUsage } from '../services/tokenUsageService';
import { readBilledLedgerRows } from '../services/llmUsageLedgerReader';
import { readItemizationChargeEvents } from '../services/ledgerItemizationReader';
import { reconcileItemizedUsage } from '../services/usageItemization';
import { getPaygOverageView, updatePaygOverage, PaygOverageRequestError } from '../services/paygOverageService';

const router = express.Router();

/**
 * Get current user's token usage and allowance.
 *
 * `toCustomerTokenUsage` carries the same obligation as `toCustomerRunway` one
 * route below (ENG-1212 AC4): internal USD never reaches a customer API. This
 * route used to return `checkTokenUsage` verbatim, so `costUsed` and
 * `costAllowance` went out in plain dollars to every authenticated user.
 */
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const usage = await checkTokenUsage(userId);
    res.json(toCustomerTokenUsage(usage));
  } catch (error) {
    console.error('Error getting token usage:', error);
    res.status(500).json({ error: 'Failed to get token usage' });
  }
});

/**
 * ENG-668 — pay-as-you-go overage settings for the caller's usage pool.
 *
 * Same authentication as `/usage`. Anyone on the pool may read it; only the billing owner
 * (`resolveBillingUserId(caller) === caller`) may change it — an org member who pools onto the owner
 * gets 403, a member paying for their own plan owns their own pool. Percentages only: the cap and the
 * overage in dollars never leave the server.
 */
router.get('/payg', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    return res.json(await getPaygOverageView(userId));
  } catch (error) {
    console.error('Error getting pay-as-you-go settings:', error);
    return res.status(500).json({ error: 'Failed to get extra usage settings' });
  }
});

router.put('/payg', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { enabled, capPercentOfPool } = req.body || {};
    return res.json(await updatePaygOverage({
      userId,
      // A delegated admin acts AS the customer (req.user is the customer): record who actually did it,
      // and let the service refuse consent that only the customer can give.
      actorId: (req as any).delegateInfo?.adminUserId || userId,
      isDelegated: (req as any).delegateInfo?.isDelegated === true,
      enabled,
      capPercentOfPool,
    }));
  } catch (error) {
    if (error instanceof PaygOverageRequestError) {
      return res.status(error.status).json({ error: error.code, message: error.message });
    }
    console.error('Error updating pay-as-you-go settings:', error);
    return res.status(500).json({ error: 'Failed to update extra usage settings' });
  }
});

/**
 * ENG-1212 — customer-facing usage runway.
 *
 * Sibling of `/usage`, which reports where the account stands today; this
 * reports where it is heading. ENG-1214's UI consumes it.
 *
 * `toCustomerRunway` is not optional decoration: the resolver returns internal
 * micro-USD ceilings and raw burn rates for admin diagnostics, and AC4 forbids
 * those reaching a customer. Strip at the boundary, once, here.
 */
router.get('/usage-runway', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const { available, runway } = await resolveUsageRunway(userId);
    if (!available || !runway) {
      // A tier with no configured cost policy has no ceiling to forecast
      // against. Say so plainly rather than returning a zeroed forecast the UI
      // would render as "on track".
      return res.json({ available: false, runway: null });
    }
    res.json({ available: true, runway: toCustomerRunway(runway) });
  } catch (error) {
    console.error('Error getting usage runway:', error);
    res.status(500).json({ error: 'Failed to get usage runway' });
  }
});

/**
 * ENG-1213 — what is consuming the allowance, and what switching would recover.
 *
 * Companion to `/usage-runway`: that says how long the allowance lasts, this says
 * why and what to do about it. ENG-1214/ENG-1217's runway UI renders both.
 *
 * `toCustomerDrivers` strips internal micro-USD totals and raw savings at this
 * boundary — a customer sees shares, counts and day figures only. The service
 * never applies a switch; every recommendation is returned with
 * `requiresConfirmation`.
 */
router.get('/usage-drivers', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const resolved = await resolveUsageDrivers(userId);
    res.json(toCustomerDrivers(resolved));
  } catch (error) {
    console.error('Error getting usage drivers:', error);
    res.status(500).json({ error: 'Failed to get usage drivers' });
  }
});

/**
 * ENG-1217 AC2/AC6 — combined, non-persisted preview of a set of switches.
 *
 * POST, not GET, because the selection set is the input and it is unbounded —
 * but this endpoint WRITES NOTHING. The response carries `persisted: false` as
 * part of its contract: previewing must never change a model (AC2), and a
 * customer inspecting several options must see their combined, non-duplicated
 * impact before any confirmation (AC6).
 *
 * The combination cannot be done client-side by summing `/usage-drivers`: each
 * figure there is measured against the same baseline, and the forecast takes the
 * larger of the cycle-to-date and trailing-seven burn rates, so it is non-linear
 * and two gains do not add. Hence a server-side re-forecast.
 *
 * Everything returned is in DAYS. No internal dollars cross this boundary.
 */
router.post('/usage-runway/preview', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const raw = (req.body || {}).selections;
    if (raw !== undefined && !Array.isArray(raw)) {
      return res.status(400).json({ error: '`selections` must be an array' });
    }
    // Bounded so a caller cannot turn one request into an unbounded number of
    // repricing passes over the cycle's ledger.
    const list = (raw || []).slice(0, 20);
    const selections = list
      .filter((s: any) => s && typeof s.fromModel === 'string' && typeof s.toModel === 'string')
      .map((s: any) => ({ fromModel: s.fromModel.trim(), toModel: s.toModel.trim() }));

    const preview = await previewUsageRunway(userId, selections);
    res.json(preview);
  } catch (error) {
    console.error('Error previewing usage runway:', error);
    res.status(500).json({ error: 'Failed to preview usage runway' });
  }
});

/**
 * ENG-1217 AC6/AC9 — confirm a switch, and undo it.
 *
 * Separate from `/usage-runway/preview` on purpose: preview answers a question
 * and persists nothing, this one writes a model. Keeping them apart means the
 * read path can never acquire a write by accident, and the write path is the
 * only thing that needs the audit trail and the stricter validation.
 *
 * The service reports an unowned scope as NOT FOUND rather than forbidden, and
 * that distinction is preserved here: a 403 would confirm the id exists and turn
 * this into an enumeration oracle for other tenants' schedule ids.
 */
/**
 * ENG-1210 AC12 — record that a customer turned a recommendation down.
 *
 * A read-only sibling of `/preview` in the sense that matters: it writes no model, no
 * schedule and no ledger row. It only records that a decision happened, so the
 * shown/accepted/declined funnel has its third leg.
 *
 * Kept separate from `/preview` rather than folded into it as a flag, because previewing
 * and declining are opposite answers to the same question and conflating them would make
 * every preview look like a rejection of whatever was not selected.
 */
router.post('/usage-runway/decline', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { reason, selections } = req.body || {};
    if (selections !== undefined && !Array.isArray(selections)) {
      return res.status(400).json({ error: '`selections` must be an array' });
    }

    const result = await recordRecommendationDeclined(userId, {
      reason,
      // Bounded BEFORE the map. The service slices too, but doing it only there means a
      // caller can still make the route normalise an arbitrarily long array first — the
      // bound should cost nothing to exceed, not merely limit what gets recorded.
      selections: (selections || []).slice(0, MAX_DECLINE_SELECTIONS).map((s: any) => ({
        fromModel: s?.fromModel,
        toModel: s?.toModel,
        // Taken as the customer saw them. Recomputing here would record a number they
        // were never shown, which is the same mistake the apply route avoids.
        estimatedDaysRecovered:
          typeof s?.estimatedDaysRecovered === 'number' ? s.estimatedDaysRecovered : null,
        confidence: typeof s?.confidence === 'string' ? s.confidence : null,
      })),
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof InvalidDeclineInputError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error recording a declined recommendation:', error);
    return res.status(500).json({ error: 'Failed to record the decline' });
  }
});

/**
 * ENG-2769 — record an outcome of the usage-alert modal (shown / dismissed /
 * see_options / book_call / upgrade / contact). Writes nothing but a telemetry line.
 */
router.post('/usage-runway/alert-event', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { action, reason, estimatedDaysRemaining, percentUsed } = req.body || {};
    const result = await recordUsageAlertEvent(userId, { action, reason, estimatedDaysRemaining, percentUsed });
    return res.json(result);
  } catch (error) {
    if (error instanceof InvalidAlertEventError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error recording a usage alert event:', error);
    return res.status(500).json({ error: 'Failed to record the alert event' });
  }
});

router.post('/usage-runway/apply', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { scope, scopeId, toModel, estimatedDaysRecovered, confidence } = req.body || {};
    if (typeof scopeId !== 'string' || !scopeId.trim()) {
      return res.status(400).json({ error: '`scopeId` is required' });
    }
    if (typeof toModel !== 'string' || !toModel.trim()) {
      return res.status(400).json({ error: '`toModel` is required' });
    }

    const result = await applyModelChange(userId, {
      scope: scope === 'session' ? 'session' : 'schedule',
      scopeId: scopeId.trim(),
      toModel: toModel.trim(),
      // Recorded as the customer saw it, never recomputed — the point of the
      // audit is what they agreed to, not what we would estimate now.
      estimatedDaysRecovered:
        typeof estimatedDaysRecovered === 'number' ? estimatedDaysRecovered : null,
      confidence: typeof confidence === 'string' ? confidence : null,
    });
    return res.json(result);
  } catch (error) {
    // 403, not 404: the scope exists, the caller may not change it. ENG-1528 —
    // telling an org owner their colleague's schedule "was not found" while it
    // is listed on their own billing page is both false and unactionable.
    if (error instanceof ModelChangeForbiddenError) {
      return res.status(403).json({ error: error.message });
    }
    if (error instanceof ModelChangeNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof ModelNotAvailableError) {
      return res.status(400).json({ error: error.message });
    }
    // ENG-669: the model is outside the schedule owner's plan: the same 422 body every model refusal uses.
    if (isModelUnavailableError(error)) {
      const displayName = typeof agentModeService.getModelDisplayName === 'function'
        ? agentModeService.getModelDisplayName(error.requestedModel)
        : undefined;
      return res.status(422).json(buildModelUnavailableBody(error, displayName));
    }
    // 409, not 500: nothing failed. Someone else changed the schedule first, so
    // the client's own view is stale — reload-and-retry is the fix, which a 500
    // does not communicate and which invites a blind retry that loses again.
    if (error instanceof ModelChangeConflictError) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Error applying model change:', error);
    return res.status(500).json({ error: 'Failed to apply the change' });
  }
});

router.post('/usage-runway/undo', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { changeId } = req.body || {};
    if (typeof changeId !== 'string' || !changeId.trim()) {
      return res.status(400).json({ error: '`changeId` is required' });
    }

    const result = await undoModelChange(userId, changeId.trim());
    return res.json(result);
  } catch (error) {
    // 403, not 404: the scope exists, the caller may not change it. ENG-1528 —
    // telling an org owner their colleague's schedule "was not found" while it
    // is listed on their own billing page is both false and unactionable.
    if (error instanceof ModelChangeForbiddenError) {
      return res.status(403).json({ error: error.message });
    }
    if (error instanceof ModelChangeNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    // Same reasoning as apply, and it arrives here too now that the restore is
    // conditional: an undo whose schedule has moved on is not a failure, it is a
    // change that can no longer be undone. A 500 would say "we broke" and invite
    // a retry that cannot succeed.
    if (error instanceof ModelChangeConflictError) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Error undoing model change:', error);
    return res.status(500).json({ error: 'Failed to undo the change' });
  }
});

// A customer-visible explanation of the usage meter.  This deliberately reads
// the existing immutable-ish usage aggregates; it does not invent provider
// costs or alter the admission counter.  New per-charge audit events will be
// added behind this response without changing the portal contract.
router.get('/usage/itemized', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const billingUserId = await resolveBillingUserId(userId);
    // ENG-1251: the shadow-ledger aggregate table's partition key is the ACTING
    // user's own id, not the resolved billing owner, so no single strategy sees
    // the whole ledger. Scanning by the `billingUserId` attribute finds rows
    // belonging to FORMER members that no partition query can reach, but only
    // rows carrying the stamp -- and most rows predating internalUsage.ts's
    // write-time fix do not. That is why this endpoint reported $86.23 against
    // a true $218.13 for the founders org over Aug 12-15, 60.5% low.
    //
    // readBilledLedgerRows takes the union of that scan and the per-member
    // partition fan-out, deduped on the table's primary key. It repairs the
    // historical window in place: both halves read data exactly as it already
    // exists, so no backfill is required.
    const [events, rows] = await Promise.all([
      readItemizationChargeEvents(billingUserId, month),
      readBilledLedgerRows(billingUserId, `${month}-01`, `${month}-31`),
    ]);
    const { items, precision } = reconcileItemizedUsage(events, rows);
    return res.json({ month, billingUserId, precision, items });
  } catch (error) {
    console.error('Error getting itemized usage:', error);
    return res.status(500).json({ error: 'Failed to get itemized usage' });
  }
});

// Get all available customer portal pages
router.get('/customer-portal-pages', authenticateToken, async (req, res) => {
  try {
    const pages = getCustomerPortalPages();
    res.json({ pages });
  } catch (error) {
    console.error('Error getting customer portal pages:', error);
    res.status(500).json({ error: 'Failed to get customer portal pages' });
  }
});

export default router;
