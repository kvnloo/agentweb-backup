import express from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { userDb } from '../services/db';

const router = express.Router();

// GET /api/users/me/onboarding
router.get('/me/onboarding', authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ message: 'User not authenticated' });

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    return res.json({
      onboardingProgress: (user as any).onboardingProgress ?? {},
      onboardingDismissed: (user as any).onboardingDismissed ?? false,
    });
  } catch (error) {
    console.error('Error fetching onboarding state:', error);
    return res.status(500).json({ message: 'Failed to fetch onboarding state' });
  }
});

// PATCH /api/users/me/onboarding
router.patch('/me/onboarding', authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ message: 'User not authenticated' });

    const { onboardingProgress, onboardingDismissed } = req.body ?? {};

    if (onboardingProgress !== undefined && (typeof onboardingProgress !== 'object' || Array.isArray(onboardingProgress))) {
      return res.status(400).json({ message: 'onboardingProgress must be an object' });
    }
    if (onboardingDismissed !== undefined && typeof onboardingDismissed !== 'boolean') {
      return res.status(400).json({ message: 'onboardingDismissed must be a boolean' });
    }

    const updates: Record<string, unknown> = {};
    if (onboardingProgress !== undefined) updates.onboardingProgress = onboardingProgress;
    if (onboardingDismissed !== undefined) updates.onboardingDismissed = onboardingDismissed;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    await userDb.updateUser(userId, updates as any);

    return res.json({ ok: true });
  } catch (error) {
    console.error('Error saving onboarding state:', error);
    return res.status(500).json({ message: 'Failed to save onboarding state' });
  }
});

export default router;
