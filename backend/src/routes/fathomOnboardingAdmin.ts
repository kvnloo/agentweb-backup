import express from 'express';
import { userDb } from '../services/db';
import {
  applyFathomOnboardingReviewAction,
  FathomOnboardingReviewError,
  ingestFathomOnboardingRecording,
} from '../services/fathomOnboardingIngestionService';

const router = express.Router();

router.post('/ingest', async (req: any, res) => {
  try {
    const {
      recordingId,
      recordingUrl,
      fathomUserId,
      targetUserId,
      reviewed,
      meetingText,
      transcriptText,
      extractedContext,
    } = req.body || {};

    if (!recordingId && !recordingUrl) {
      return res.status(400).json({ error: 'recordingId or recordingUrl is required.' });
    }

    const result = await ingestFathomOnboardingRecording({
      recordingId,
      recordingUrl,
      fathomUserId: fathomUserId || req.user?.userId,
      reviewOwnerUserId: req.user.userId,
      targetUserId,
      reviewed: reviewed === true,
      meetingText,
      transcriptText,
      extractedContext,
    });

    return res.json(result);
  } catch (error: any) {
    if (error instanceof FathomOnboardingReviewError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('[fathomOnboardingAdmin] ingest failed:', error?.message);
    return res.status(500).json({ error: error?.message || 'Failed to ingest Fathom onboarding context' });
  }
});

router.post('/auto-ingest', async (req: any, res) => {
  try {
    const {
      recordingId,
      recordingUrl,
      fathomUserId,
      meetingText,
      transcriptText,
      extractedContext,
    } = req.body || {};

    if (!recordingId && !recordingUrl) {
      return res.status(400).json({ error: 'recordingId or recordingUrl is required.' });
    }

    const result = await ingestFathomOnboardingRecording({
      recordingId,
      recordingUrl,
      fathomUserId: fathomUserId || req.user?.userId,
      reviewOwnerUserId: req.user.userId,
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      reviewed: false,
      meetingText,
      transcriptText,
      extractedContext,
    });

    return res.json(result);
  } catch (error: any) {
    console.error('[fathomOnboardingAdmin] auto-ingest failed:', error?.message);
    return res.status(500).json({ error: error?.message || 'Failed to auto-ingest Fathom onboarding context' });
  }
});

router.get('/users/:userId', async (req, res) => {
  try {
    const user = await userDb.getUserById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({
      userId: user.userId,
      ingestions: Array.isArray((user as any).fathomOnboardingIngestions)
        ? (user as any).fathomOnboardingIngestions
        : [],
    });
  } catch (error: any) {
    console.error('[fathomOnboardingAdmin] get user ingestions failed:', error?.message);
    return res.status(500).json({ error: 'Failed to load Fathom onboarding ingestions' });
  }
});

const VALID_PATH_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
// recordingId is only a ledger lookup key and ingest accepts any non-empty id,
// so only bound its length here (Opslane run 352, P2).
const isValidRecordingId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 512;

for (const action of ['discard', 'rollback'] as const) {
  router.post(`/users/:userId/ingestions/:recordingId/${action}`, async (req: any, res) => {
    const { userId, recordingId } = req.params;
    if (!VALID_PATH_ID.test(userId) || !isValidRecordingId(recordingId)) {
      return res.status(400).json({ error: 'Invalid userId or recordingId' });
    }
    try {
      const ingestion = await applyFathomOnboardingReviewAction({
        userId: req.params.userId,
        recordingId: req.params.recordingId,
        action,
        actorUserId: req.user.userId,
        ...(action === 'rollback' && typeof req.body?.orgMemoryOrgId === 'string' && VALID_PATH_ID.test(req.body.orgMemoryOrgId)
          ? { orgMemoryOrgId: req.body.orgMemoryOrgId }
          : {}),
      });
      return res.json({ ingestion });
    } catch (error: any) {
      if (error instanceof FathomOnboardingReviewError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error(`[fathomOnboardingAdmin] ${action} failed:`, error?.message);
      return res.status(500).json({ error: `Failed to ${action} Fathom onboarding ingestion` });
    }
  });
}

export default router;
