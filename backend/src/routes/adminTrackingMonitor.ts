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
  //
  // ⚠ Validation happens AFTER normalisation, and that ordering is the whole point. A first
  // version checked the RECEIVED value and normalised afterwards, which left `"act_"` — a
  // non-empty string — passing validation and then becoming `''` once the prefix was stripped,
  // reinstating the exact fleet-wide widening this block exists to prevent. Validate the value
  // you are going to USE, never the one you were handed.
  const readScope = (field: 'userId' | 'adAccountId'): string | undefined | null => {
    const raw = body[field];
    if (raw === undefined) return undefined; // genuinely omitted — unscoped is the intent
    if (typeof raw !== 'string') return null;
    let value = raw.trim();
    if (field === 'adAccountId') value = value.replace(/^act_/, '').trim();
    return value === '' ? null : value;
  };

  // Checked one at a time rather than in a loop, so the COMPILER narrows `null` away before
  // these reach the options object. A loop reads tidier and leaves the type as
  // `string | null | undefined`, which would put the burden back on a reader to notice the
  // rejection already happened.
  const userId = readScope('userId');
  if (userId === null) {
    return res.status(400).json({ message: 'userId must be a non-empty string when provided' });
  }

  const adAccountId = readScope('adAccountId');
  if (adAccountId === null) {
    return res.status(400).json({
      message: 'adAccountId must be a non-empty account id when provided (an "act_" prefix alone is not one)',
    });
  }

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
