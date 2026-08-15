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
    if (events.length) return res.json({
      month, billingUserId, precision: 'per_charge',
      items: events.map((event) => ({
        date: event.occurredAt, model: event.model || 'unknown', provider: event.provider || 'unknown',
        feature: event.feature || 'unknown', tokens: event.tokens, calls: 1,
        costMicroUsd: event.costMicroUsd, source: 'charge_event', sessionId: event.sessionId,
      })),
    });
    const rows = await usageRecordDb.queryByUserDateRange(billingUserId, `${month}-01`, `${month}-31`);
    const items = rows.map((row) => ({
      date: row.date, model: row.model, provider: row.provider || 'unknown', feature: row.feature,
      tokens: row.totalTokens || 0, calls: row.callCount || 0, costMicroUsd: row.costMicroUsd || 0,
      source: 'daily_aggregate' as const,
    })).sort((a, b) => b.date.localeCompare(a.date) || b.costMicroUsd - a.costMicroUsd);
    return res.json({ month, billingUserId, precision: 'daily_aggregate', items });
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
