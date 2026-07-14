/**
 * Fathom webhook handler.
 *
 * Receives webhook events from Fathom when meetings are processed.
 * On 'recording.ready', extracts action items and routes them via
 * meetingIntakeService.
 *
 * Mounted at /api/webhooks/fathom in app.ts.
 */

import express from 'express';
import { processActionItems, MeetingData } from '../services/meetingIntakeService';
import { ingestFathomOnboardingRecording } from '../services/fathomOnboardingIngestionService';

const router = express.Router();

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

  // Extract participants — handle both {name, email} objects and plain strings
  const participants: string[] = (meeting.participants || []).map((p: any) => {
    if (typeof p === 'string') return p;
    return p.email || p.name || 'Unknown';
  });

  // Extract action items — handle both {text} objects and plain strings
  const actionItems: string[] = (meeting.action_items || []).map((ai: any) => {
    if (typeof ai === 'string') return ai;
    return ai.text || '';
  }).filter((text: string) => text.trim() !== '');

  const meetingData: MeetingData = {
    meetingTitle: meeting.title,
    timestamp: meeting.created_at || new Date().toISOString(),
    participants,
    actionItems,
  };

  try {
    const result = await processActionItems(meetingData);
    let onboardingAutomation: { status: string; recordingId?: string; automationState?: string } = { status: 'disabled' };

    if (process.env.FATHOM_ONBOARDING_AUTOMATION_ENABLED === 'true') {
      const reviewOwnerUserId = process.env.FATHOM_ONBOARDING_REVIEW_OWNER_USER_ID;
      const recordingId = data?.recording_id || data?.recording?.id || meeting?.recording_id || meeting?.recordingId;

      if (!reviewOwnerUserId || !recordingId) {
        onboardingAutomation = { status: 'skipped_missing_config_or_recording' };
      } else {
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

          onboardingAutomation = {
            status: 'processed',
            recordingId: ingestion.recordingId,
            automationState: ingestion.automationState,
          };
        } catch (error: any) {
          console.error('[Fathom Webhook] Onboarding automation failed:', error?.message);
          onboardingAutomation = { status: 'failed' };
        }
      }
    }

    console.log(
      `[Fathom Webhook] Processed meeting "${meeting.title}": ` +
      `${result.created.length} created, ${result.skipped.length} skipped`
    );

    return res.status(200).json({
      success: true,
      message: `Meeting "${meeting.title}" processed: ${result.created.length} tasks created, ${result.skipped.length} skipped.`,
      created: result.created.length,
      skipped: result.skipped.length,
      onboardingAutomation,
    });
  } catch (error: any) {
    console.error('[Fathom Webhook] Failed to process meeting:', error?.message);
    return res.status(500).json({
      error: `Failed to process meeting action items: ${error?.message || 'Unknown error'}`,
    });
  }
});

export default router;
