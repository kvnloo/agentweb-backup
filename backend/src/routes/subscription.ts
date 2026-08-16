import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getCustomerPortalPages } from '../services/customerPortalPages';
import { checkTokenUsage } from '../services/tokenUsageService';
import { resolveBillingUserId } from '../services/tokenUsageService';
import { usageRecordDb } from '../services/usageRecordDb';
import { listLlmChargeEvents } from '../services/llmChargeAuditDb';

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
    const events = await listLlmChargeEvents(billingUserId, `${month}-01`, `${month}-31`);
    const perChargeItems = events.map((event) => ({
      date: event.occurredAt, model: event.model || 'unknown', provider: event.provider || 'unknown',
      feature: event.feature || 'unknown', tokens: event.tokens, calls: 1,
      costMicroUsd: event.costMicroUsd, source: 'charge_event' as const, sessionId: event.sessionId,
    }));

    // ENG-1251 Greptile P1: a charge event covers the SAME call the shadow
    // daily-aggregate table also records (recordUsage runs unconditionally,
    // regardless of whether a charge event exists for that call), so an
    // aggregate row fully covered by charge events would double that
    // usage. But suppressing by DATE ALONE is too coarse: a row bundles
    // every call for one (date, model, feature) into a single total, so a
    // day with an applied charge event AND separate, uncovered
    // aggregate-only usage (the exact day the rollout reached this user,
    // or any other partial-coverage day) would have its whole aggregate
    // row discarded instead of just the covered portion.
    //
    // Key at (date, model, feature) — the aggregate table's own natural
    // grouping (its sort key is `{date}#{model}#{feature}`) — and only
    // suppress the DOLLAR AMOUNT actually covered by charge events for
    // that exact combination. A day/model/feature fully covered nets to
    // ~0 and disappears (the common case); one with a genuine uncovered
    // remainder still shows, at its full totals (token/call counts can't
    // be split proportionally without call-level attribution in the
    // aggregate row, so a partially-covered row shows in full rather than
    // being silently dropped or estimated).
    const chargedMicroUsdByKey = new Map<string, number>();
    for (const event of events) {
      const key = `${event.occurredAt.slice(0, 10)}#${event.model || 'unknown'}#${event.feature || 'unknown'}`;
      chargedMicroUsdByKey.set(key, (chargedMicroUsdByKey.get(key) || 0) + event.costMicroUsd);
    }
    const rows = await usageRecordDb.queryByUserDateRange(billingUserId, `${month}-01`, `${month}-31`);
    const aggregateItems = rows
      .filter((row) => {
        const key = `${row.date}#${row.model}#${row.feature}`;
        const covered = chargedMicroUsdByKey.get(key) || 0;
        // row.costMicroUsd is already micro-USD, same unit as the charge
        // events summed above -- no conversion.
        return (row.costMicroUsd || 0) > covered;
      })
      .map((row) => ({
        date: row.date, model: row.model, provider: row.provider || 'unknown', feature: row.feature,
        tokens: row.totalTokens || 0, calls: row.callCount || 0, costMicroUsd: row.costMicroUsd || 0,
        source: 'daily_aggregate' as const,
      }));

    const items = [...perChargeItems, ...aggregateItems].sort(
      (a, b) => b.date.localeCompare(a.date) || b.costMicroUsd - a.costMicroUsd
    );
    const precision = perChargeItems.length && aggregateItems.length
      ? 'mixed'
      : perChargeItems.length
      ? 'per_charge'
      : 'daily_aggregate';
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
