import express, { Request, Response } from 'express';
import {
  runMetaTrackingMonitor,
  TrackingMonitorRunOptions,
} from '../cron/metaTrackingMonitorCron';

const router = express.Router();

/**
 * ENG-926 §49 — run the tracking-integrity sweep on demand.
 *
 * `monitorUserTracking` has exactly one caller in production: a cron armed for 09:00 UTC with
 * no run on boot (§29's deliberate choice, so a redeploy cannot re-fire it). That makes every
 * §F/§G change unverifiable until the following morning, and each fix-verify cycle another 24
 * hours — a cost paid three separate times on 2026-08-18.
 *
 * `dryRun` is the ONLY safe way to use this against production, and it is the default here:
 *   - alerts are captured and returned instead of sent, so no oncall page and no filed issue
 *   - the alert-suppression map is neither read nor written, so a probe can neither read clean
 *     because the real sweep already alerted, nor silence the next real sweep
 *   - the §C divergence check is skipped entirely, because it alerts through its own path
 *
 * A non-dry run is a REAL sweep with REAL alerts. It is permitted (re-running a failed 09:00
 * sweep is a legitimate operator action) but must be asked for explicitly.
 */
router.post('/run', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Default TRUE. An operator who forgets the flag gets the harmless behaviour, not a fleet-wide
  // alert storm — the same fail-safe direction §C's relay took by shipping default-off.
  const dryRun = body.dryRun === undefined ? true : body.dryRun === true;

  // REJECT an invalid scope; never silently widen it.
  //
  // Coercing a bad value to `undefined` reads as "no scope given", so `{"adAccountId": 12345}`
  // — a number, which is exactly how an id gets pasted from a JSON tool — quietly became a
  // FLEET-WIDE run. With `dryRun: false` that is a full sweep with real oncall alerts from a
  // request that asked for one account. A request that names a scope and does not get it must
  // fail, not do something larger.
  for (const field of ['userId', 'adAccountId'] as const) {
    const value = body[field];
    if (value === undefined) continue; // genuinely omitted — unscoped is the intent
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({
        message: `${field} must be a non-empty string when provided`,
      });
    }
  }

  const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : undefined;
  const adAccountId =
    typeof body.adAccountId === 'string' && body.adAccountId.trim()
      ? body.adAccountId.trim().replace(/^act_/, '')
      : undefined;

  const options: TrackingMonitorRunOptions = { dryRun, userId, adAccountId };

  try {
    const startedAt = Date.now();
    const summary = await runMetaTrackingMonitor(options);
    return res.status(200).json({
      dryRun,
      scope: { userId: userId ?? null, adAccountId: adAccountId ?? null },
      durationMs: Date.now() - startedAt,
      summary,
    });
  } catch (error: any) {
    console.error('adminTrackingMonitor run error:', error?.message ?? error);
    return res.status(500).json({ message: 'Failed to run the tracking monitor sweep' });
  }
});

export default router;
