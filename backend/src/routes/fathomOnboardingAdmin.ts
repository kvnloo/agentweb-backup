import express from 'express';
import { userDb } from '../services/db';
import { ingestFathomOnboardingRecording } from '../services/fathomOnboardingIngestionService';

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
    console.error('[fathomOnboardingAdmin] ingest failed:', error?.message);
    return res.status(500).json({ error: error?.message || 'Failed to ingest Fathom onboarding context' });
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

export default router;
