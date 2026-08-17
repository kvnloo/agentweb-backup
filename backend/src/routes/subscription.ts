import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getCustomerPortalPages } from '../services/customerPortalPages';
import { checkTokenUsage } from '../services/tokenUsageService';
import { resolveUsageRunway } from '../services/llmUsageRunwayResolverService';
import { toCustomerRunway } from '../services/llmUsageForecastService';
import { resolveUsageDrivers, toCustomerDrivers, previewUsageRunway } from '../services/llmUsageDriversResolverService';
import {
  applyModelChange,
  undoModelChange,
  ModelChangeNotFoundError,
  ModelNotAvailableError,
} from '../services/llmModelChangeService';
import { resolveBillingUserId } from '../services/tokenUsageService';
import { readBilledLedgerRows } from '../services/llmUsageLedgerReader';
import { listLlmChargeEvents } from '../services/llmChargeAuditDb';
import { reconcileItemizedUsage } from '../services/usageItemization';

const router = express.Router();

// Get current user's token usage and allowance
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const usage = await checkTokenUsage(userId);
    res.json(usage);
  } catch (error) {
    console.error('Error getting token usage:', error);
    res.status(500).json({ error: 'Failed to get token usage' });
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
    if (error instanceof ModelChangeNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof ModelNotAvailableError) {
      return res.status(400).json({ error: error.message });
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
    if (error instanceof ModelChangeNotFoundError) {
      return res.status(404).json({ error: error.message });
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
      listLlmChargeEvents(billingUserId, `${month}-01`, `${month}-31`),
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
