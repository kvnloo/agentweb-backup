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

// GET /api/users/me/preferences
// ENG-1085: backs the Settings page's Preferences card (display name +
// email-notification opt-in), which previously had no persistence at all.
router.get('/me/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ message: 'User not authenticated' });

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    return res.json({
      displayName: (user as any).displayName ?? null,
      // Opt-out model: absent/undefined means the user has never touched
      // this setting, so they keep receiving notification email rather than
      // silently losing it the first time they load Settings.
      emailNotificationsEnabled: (user as any).emailNotificationsEnabled ?? true,
    });
  } catch (error) {
    console.error('Error fetching preferences:', error);
    return res.status(500).json({ message: 'Failed to fetch preferences' });
  }
});

// PATCH /api/users/me/preferences
router.patch('/me/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ message: 'User not authenticated' });

    const { displayName, emailNotificationsEnabled } = req.body ?? {};

    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || displayName.trim().length === 0) {
        return res.status(400).json({ message: 'displayName must be a non-empty string' });
      }
      if (displayName.length > 100) {
        return res.status(400).json({ message: 'displayName must be 100 characters or fewer' });
      }
    }
    if (emailNotificationsEnabled !== undefined && typeof emailNotificationsEnabled !== 'boolean') {
      return res.status(400).json({ message: 'emailNotificationsEnabled must be a boolean' });
    }

    const updates: Record<string, unknown> = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (emailNotificationsEnabled !== undefined) updates.emailNotificationsEnabled = emailNotificationsEnabled;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    await userDb.updateUser(userId, updates as any);

    return res.json({ ok: true });
  } catch (error) {
    console.error('Error saving preferences:', error);
    return res.status(500).json({ message: 'Failed to save preferences' });
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
