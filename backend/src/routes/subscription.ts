import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getCustomerPortalPages } from '../services/customerPortalPages';
import { checkTokenUsage } from '../services/tokenUsageService';
import { resolveUsageRunway } from '../services/llmUsageRunwayResolverService';
import { toCustomerRunway } from '../services/llmUsageForecastService';
import { resolveUsageDrivers, toCustomerDrivers, previewUsageRunway } from '../services/llmUsageDriversResolverService';

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
