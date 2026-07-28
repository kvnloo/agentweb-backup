/**
 * Fathom webhook handler — the cloud ingestion path of the Fathom → Linear
 * task router (ENG-259).
 *
 * On `recording.ready`:
 *  1. The meeting's action items are deterministically extracted
 *     (`fathomExtraction`) and reconciled against Linear through the canonical
 *     reconciliation engine (`fathomLinearRouter`) via the registered
 *     `LinearPort` (production adapter: ENG-536).
 *  2. The independent onboarding automation leg (ENG-246, gated by
 *     FATHOM_ONBOARDING_AUTOMATION_ENABLED) runs unchanged.
 *
 * Router mode is governed by FATHOM_LINEAR_ROUTER_MODE:
 *   - "off"    → webhook acknowledges but routes nothing (rollback lever).
 *   - "shadow" → DEFAULT. Every decision (create/enrich/relate/no-op) is
 *                computed against real board reads and reported, but no Linear
 *                write is performed. This is the PRD Phase-1 rollout posture;
 *                flipping to "live" is gated on human shadow-mode acceptance
 *                (ENG-447).
 *   - "live"   → decisions are written to Linear.
 *
 * Every routed webhook logs its full run report (one JSON line, prefix
 * `[FathomLinearRouter]`) so shadow output is observable in EB/CloudWatch logs.
 *
 * Mounted at /api/webhooks/fathom in app.ts.
 */

import express from 'express';
import { extractMeetingActionItems } from '../services/fathomExtraction';
import { routeMeetingToLinear, RunReport } from '../services/fathomLinearRouter';
import { getFathomLinearPort } from '../services/fathomLinearPortRegistry';
import { ingestFathomOnboardingRecording } from '../services/fathomOnboardingIngestionService';

const router = express.Router();

export type FathomRouterMode = 'off' | 'shadow' | 'live';

/** Resolve the router mode from the environment. Invalid values fail loudly. */
export function getFathomRouterMode(): FathomRouterMode {
  const raw = (process.env.FATHOM_LINEAR_ROUTER_MODE ?? 'shadow').toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'live') return raw;
  throw new Error(
    `Invalid FATHOM_LINEAR_ROUTER_MODE "${raw}" — expected "off", "shadow", or "live".`,
  );
}

type RouterLegResult =
  | { routed: false; reason: string; itemsExtracted?: number }
  | { routed: true; mode: RunReport['mode']; report: RunReport };

interface OnboardingLegResult {
  status: string;
  recordingId?: string;
  automationState?: string;
}

/**
 * The ENG-246 onboarding automation leg — behavior unchanged from the previous
 * handler. Self-contained: it never throws; failures surface as `status: 'failed'`.
 */
async function runOnboardingLeg(
  meeting: any,
  data: any,
  participants: string[],
  actionItems: string[],
): Promise<OnboardingLegResult> {
  if (process.env.FATHOM_ONBOARDING_AUTOMATION_ENABLED !== 'true') {
    return { status: 'disabled' };
  }

  const reviewOwnerUserId = process.env.FATHOM_ONBOARDING_REVIEW_OWNER_USER_ID;
  const recordingId = data?.recording_id || data?.recording?.id || meeting?.recording_id || meeting?.recordingId;

  if (!reviewOwnerUserId || !recordingId) {
    return { status: 'skipped_missing_config_or_recording' };
  }

  try {
    const recordingUrl =
      data?.recording_url ||
      data?.recording?.url ||
      meeting?.recording_url ||
      meeting?.recordingUrl ||
      `https://fathom.video/calls/${recordingId}`;
    const meetingText = [
      `Meeting title: ${meeting.title}`,
      participants.length ? `Participants: ${participants.join(', ')}` : null,
      actionItems.length ? `Action items: ${actionItems.join('; ')}` : null,
    ].filter(Boolean).join('\n');
    const ingestion = await ingestFathomOnboardingRecording({
      recordingId,
      recordingUrl,
      fathomUserId: process.env.FATHOM_ONBOARDING_FATHOM_USER_ID || reviewOwnerUserId,
      reviewOwnerUserId,
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      reviewed: false,
      meetingText,
    });

    return {
      status: 'processed',
      recordingId: ingestion.recordingId,
      automationState: ingestion.automationState,
    };
  } catch (error: any) {
    console.error('[Fathom Webhook] Onboarding automation failed:', error?.message);
    return { status: 'failed' };
  }
}

router.post('/', async (req: express.Request, res: express.Response) => {
  const { event, data } = req.body;

  // Validate event field
  if (!event || typeof event !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid event field.' });
  }

  // Only process recording.ready events
  if (event !== 'recording.ready') {
    console.log(`[Fathom Webhook] Ignored event: ${event}`);
    return res.status(200).json({ message: `Event "${event}" ignored.` });
  }

  // Validate meeting data
  const meeting = data?.meeting;
  if (!meeting || !meeting.title) {
    return res.status(400).json({ error: 'Missing meeting data in recording.ready event.' });
  }

  try {
    const mode = getFathomRouterMode();
    const { meeting: meetingRef, items } = extractMeetingActionItems(meeting, data?.recording_id);

    // Leg 1 — Linear router (ENG-259). A pipeline failure here throws → 500.
    let routerLeg: RouterLegResult;
    if (mode === 'off') {
      console.log(`[FathomLinearRouter] Router disabled — not routing meeting "${meetingRef.title}".`);
      routerLeg = {
        routed: false,
        reason: 'Fathom→Linear router disabled (FATHOM_LINEAR_ROUTER_MODE=off).',
      };
    } else {
      const port = getFathomLinearPort();
      if (!port) {
        console.warn(
          `[FathomLinearRouter] LinearPort not configured — router inactive until the production adapter (ENG-536) registers. ` +
            `Meeting "${meetingRef.title}": ${items.length} item(s) extracted, none routed.`,
        );
        routerLeg = {
          routed: false,
          reason: 'LinearPort not configured — production adapter pending (ENG-536).',
          itemsExtracted: items.length,
        };
      } else {
        const report = await routeMeetingToLinear(meetingRef, items, port, { dryRun: mode !== 'live' });
        console.log(
          `[FathomLinearRouter] ${report.mode} run report for "${meetingRef.title}" ` +
            `(recording ${meetingRef.recordingId}): ${JSON.stringify(report)}`,
        );
        routerLeg = { routed: true, mode: report.mode, report };
      }
    }

    // Leg 2 — onboarding automation (ENG-246), unchanged and self-contained.
    const onboardingAutomation = await runOnboardingLeg(
      meeting,
      data,
      meetingRef.participants,
      items.map((i) => i.action),
    );

    return res.status(200).json({ success: true, ...routerLeg, onboardingAutomation });
  } catch (error: any) {
    console.error('[FathomLinearRouter] Failed to process meeting:', error?.message);
    return res.status(500).json({
      error: `Failed to process meeting: ${error?.message || 'Unknown error'}`,
    });
  }
});

export default router;
