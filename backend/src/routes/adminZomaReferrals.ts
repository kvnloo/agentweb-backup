/**
 * ENG-3132 slice C — admin endpoints for the Zoma referral program (admin only, like adminZomaScoreboard).
 *   POST /api/admin/zoma-referrals/codes               register a code
 *   GET  /api/admin/zoma-referrals/codes/:code         read one
 *   POST /api/admin/zoma-referrals/codes/:code/revoke  revoke (idempotent; the first revocation time is kept)
 *   GET  /api/admin/zoma-referrals/payouts?month=YYYY-MM[&format=csv]
 *
 * Deliberately NOT gated on ZOMA_REFERRAL_ENABLED: codes must be registered, and the report readable, before
 * accrual is switched on. Nothing here can create a payout; it only reads the ledger.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { REF_PATTERN } from '../services/journeyAttribution';
import { getZomaReferralLedgerStore, type ZomaReferralLedgerStore } from '../services/zomaReferralLedger';
import { isPayoutMonth, payoutsCsv, summarizePayouts } from '../services/zomaReferralPayouts';
import { createReferralCode, getZomaReferralStore, revokeReferralCode, type ZomaReferralStore } from '../services/zomaReferralRegistry';

export interface AdminZomaReferralsDeps {
  registry?: ZomaReferralStore;
  ledger?: ZomaReferralLedgerStore;
  /** Authentication and admin gate; overridable so tests can exercise the real `isAdmin`. */
  auth?: RequestHandler[];
}

export function createAdminZomaReferralsRouter(deps: AdminZomaReferralsDeps = {}) {
  const router = express.Router();
  const auth = deps.auth ?? [authenticateToken, isAdmin];
  const registry = () => deps.registry ?? getZomaReferralStore();
  const ledger = () => deps.ledger ?? getZomaReferralLedgerStore();

  // A store outage is a 503, never an empty or partial 200; the message never reaches the client.
  const guarded =
    (label: string, handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
      try {
        res.set('Cache-Control', 'no-store');
        await handler(req, res);
      } catch (error) {
        console.error(`[zoma-referrals] ${label} failed:`, error instanceof Error ? error.message : error);
        res.status(503).json({ message: 'Referral store unavailable' });
      }
    };

  router.post('/zoma-referrals/codes', ...auth, guarded('create', async (req, res) => {
    const body = req.body ?? {};
    const result = await createReferralCode(
      // createdBy is the authenticated admin, never a value the caller supplies.
      { code: body.code, referrerId: body.referrerId, payeeName: body.payeeName, userId: body.userId, percentBps: body.percentBps, createdBy: (req as Request & { user: { userId: string } }).user.userId },
      registry(),
    );
    if (result.status === 'invalid') return res.status(400).json({ message: `Invalid ${result.field}`, field: result.field, reason: result.reason });
    if (result.status === 'exists') return res.status(409).json({ message: 'That code is already registered' });
    return res.status(201).json(result.record);
  }));

  router.get('/zoma-referrals/codes/:code', ...auth, guarded('read', async (req, res) => {
    const record = REF_PATTERN.test(req.params.code) ? await registry().get(req.params.code) : null;
    return record ? res.json(record) : res.status(404).json({ message: 'Unknown code' });
  }));

  router.post('/zoma-referrals/codes/:code/revoke', ...auth, guarded('revoke', async (req, res) => {
    const { code } = req.params;
    if (!REF_PATTERN.test(code) || !(await revokeReferralCode(code, registry()))) return res.status(404).json({ message: 'Unknown code' });
    return res.json(await registry().get(code));
  }));

  router.get('/zoma-referrals/payouts', ...auth, guarded('payouts', async (req, res) => {
    const month = req.query.month;
    if (!isPayoutMonth(month)) return res.status(400).json({ message: 'month must be YYYY-MM', field: 'month' });
    const rows = summarizePayouts(await ledger().listAll(), month);
    const payeeByCode = new Map<string, string>();
    for (const code of new Set(rows.map((r) => r.code))) {
      const record = await registry().get(code);
      if (record) payeeByCode.set(code, record.payeeName);
    }
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="zoma-referral-payouts-${month}.csv"`);
      return res.send(payoutsCsv(month, rows, payeeByCode));
    }
    return res.json({
      month,
      totalNetCents: rows.reduce((sum, r) => sum + r.netCents, 0),
      rows: rows.map((r) => ({ ...r, payeeName: payeeByCode.get(r.code) ?? null })),
    });
  }));

  return router;
}

export default createAdminZomaReferralsRouter();
