import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getCustomerPortalPages } from '../services/customerPortalPages';
import { checkTokenUsage } from '../services/tokenUsageService';
import { resolveBillingUserId, getPooledMemberUserIds } from '../services/tokenUsageService';
import { usageRecordDb } from '../services/usageRecordDb';
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
    // ENG-1251 Greptile P1: the shadow-ledger aggregate table stores each row
    // under the ACTING user's own id, not the resolved billing owner -- a
    // pooled org member's aggregate-only usage is otherwise unreachable from
    // a query keyed on billingUserId alone. Query every pooled member's rows
    // too and merge. No-op (empty list) for a solo user or an org with no
    // other pooled members -- the owner's own billingUserId is always queried.
    const pooledMemberIds = await getPooledMemberUserIds(billingUserId);
    const [events, ...rowsByUser] = await Promise.all([
      listLlmChargeEvents(billingUserId, `${month}-01`, `${month}-31`),
      ...[billingUserId, ...pooledMemberIds].map((id) =>
        usageRecordDb.queryByUserDateRange(id, `${month}-01`, `${month}-31`)
      ),
    ]);
    const rows = rowsByUser.flat();
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
