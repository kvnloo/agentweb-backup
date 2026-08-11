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

// ENG-1124: self-service display-name persistence.
router.patch('/me/profile', authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ message: 'User not authenticated' });

    const displayName = req.body?.displayName;
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100) {
      return res.status(400).json({ message: 'displayName must be 1–100 characters' });
    }

    await userDb.updateUser(userId, { displayName: displayName.trim() });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error saving profile:', error);
    return res.status(500).json({ message: 'Failed to save profile' });
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

// PATCH /api/users/me/seo-domains
// Self-service: adds a domain to the user's seoDomains list (idempotent).
// Only accepts already-verified hostnames (e.g. from a deployed landing page).
router.patch('/me/seo-domains', authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ message: 'User not authenticated' });

    const { domain } = req.body ?? {};
    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ message: 'domain is required and must be a string' });
    }

    const trimmed = domain.trim();
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
    const urlPrefixRegex = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}\/?$/;
    if (!domainRegex.test(trimmed) && !urlPrefixRegex.test(trimmed)) {
      return res.status(400).json({ message: `Invalid domain format: ${domain}` });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const existing: string[] = (user as any).seoDomains ?? [];
    if (existing.includes(trimmed)) {
      return res.json({ ok: true, seoDomains: existing });
    }

    const updated = [...existing, trimmed];
    await userDb.updateUser(userId, { seoDomains: updated } as any);

    return res.json({ ok: true, seoDomains: updated });
  } catch (error) {
    console.error('Error updating seo-domains:', error);
    return res.status(500).json({ message: 'Failed to update seo-domains' });
  }
});

export default router;
