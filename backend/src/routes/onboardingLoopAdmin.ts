/**
 * Admin-only HTTP triggers for the onboarding loop.
 *
 * Why this exists:
 *   The loop is scheduled via in-process setTimeout in server.ts. Every EB
 *   restart resets the timer to next 15:00 UTC. If restarts happen after
 *   15:00 UTC, today's fire is skipped silently. An HTTP trigger gives us
 *   an out-of-band way to run the loop on demand without waiting for the
 *   next 24h window — useful when the cron slips, when debugging, or when
 *   we eventually migrate the schedule to AWS EventBridge.
 *
 * Auth: standard admin JWT via authenticateToken + isAdmin (mounted in
 * app.ts). No shared-secret path here — when EventBridge wiring lands, it
 * will sign requests via IAM through Lambda rather than calling this
 * directly.
 *
 * Concurrency: the loop takes 30-90s with LLM calls. The endpoint returns
 * 202 Accepted immediately and the run continues in the background. The
 * runs table (AW-OnboardingLoopRuns) is the source of truth for "did it
 * complete and what happened" — poll there, not this endpoint.
 */

import express, { Request, Response } from 'express';
import { runOnboardingLoop } from '../cron/onboardingLoop';

const router = express.Router();

router.post('/trigger', async (req: Request, res: Response) => {
  // Capture caller identity for the audit log. authenticateToken middleware
  // populates req.user with the admin's identity even when called via
  // delegate token — req.delegateInfo would be set in that case.
  const callerUserId = (req as any).user?.userId ?? 'unknown';
  const callerEmail = (req as any).user?.email ?? 'unknown';
  const delegateInfo = (req as any).delegateInfo;
  const triggeredAt = new Date().toISOString();

  console.log(
    `[onboardingLoopAdmin] /trigger invoked by ${callerEmail} (${callerUserId})` +
      (delegateInfo ? ` via delegate of ${delegateInfo.adminEmail}` : ''),
  );

  // Fire-and-forget. The loop's own try/catch + logRun handle errors and
  // log them to AW-OnboardingLoopRuns. We don't await — the LLM calls
  // would push us past Express's default timeout.
  runOnboardingLoop().catch((err) => {
    console.error('[onboardingLoopAdmin] Background runOnboardingLoop failed:', err);
  });

  res.status(202).json({
    accepted: true,
    triggeredAt,
    triggeredBy: { userId: callerUserId, email: callerEmail },
    note: 'Loop is running in the background. Poll AW-OnboardingLoopRuns for completion.',
  });
});

export default router;
