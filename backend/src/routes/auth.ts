import express from 'express';
import { register, login, googleCallback } from '../controllers/auth';
import { authenticateToken } from '../middleware/auth';
import { userDb, taskDb, subscriberDb, orgDb } from '../services/db';
import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { AuthRequest } from '../types/express';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ChatbotDB } from '../services/chatbotService';
import * as authController from '../controllers/auth';
import rateLimit from 'express-rate-limit';
import { resolveAnalyticsConfig, resolveConfigTarget } from '../services/analyticsConfigResolver';

const router = express.Router();

// Rate limiter for login and register — 10 attempts per 15 minutes per IP
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Please try again later.' },
});

// Define Frontend URLs based on environment or defaults
const PARTNER_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
const GROWTH_GENIUS_CHAT_URL = process.env.GROWTH_GENIUS_CHAT_URL || 'http://localhost:8080';

// console.log('OAuth Configuration:', {
//   backendUrl: process.env.BACKEND_URL || 'http://localhost:3001',
//   partnerFrontendUrl: PARTNER_FRONTEND_URL,
//   customerFrontendUrl: CUSTOMER_FRONTEND_URL
// });

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  callbackURL: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/google/callback`,
  passReqToCallback: true
}, googleCallback));

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    // Don't send sensitive information
    const { password, ...userWithoutPassword } = user;

    // Add delegation information if this is a delegate session
    const response: any = userWithoutPassword;
    if (authenticatedReq.delegateInfo) {
      response.delegateInfo = {
        isDelegated: true,
        adminEmail: authenticatedReq.delegateInfo.adminEmail,
        adminUserId: authenticatedReq.delegateInfo.adminUserId,
        isContractor: authenticatedReq.delegateInfo.isContractor,
      };
    }

    // Lazy-sync subscription status from Stripe if missing.
    // This catches legacy records where webhooks failed. Ongoing sync is handled
    // by webhooks (which now retry on transient errors).
    if (user.stripe_customer_id && !user.subscription_status) {
      try {
        const { syncSubscriptionFromStripe } = await import('../services/stripeService');
        const synced = await syncSubscriptionFromStripe(user.userId, user.stripe_customer_id);
        if (synced) {
          Object.assign(response, synced);
        }
      } catch (err: any) {
        console.error('Error syncing subscription from Stripe:', err.message);
      }
    }

    // Fetch org once here so we can reuse it for both subscription resolution and org info below
    let org = user.orgId ? await orgDb.getOrgById(user.orgId) : null;

    // Add subscription type, allowed pages, and allowed skills for customer portal users
    if (user.roles && user.roles.includes('customer')) {
      try {
        const { getUserSubscriptionType, getAllowedPages, getAllowedSkills, getHiddenPages } = await import('../services/subscriptionService');
        const { skillService } = await import('../services/skillService');

        // If user is an org member, resolve subscription from the org owner
        const subscriptionUserId = (org?.ownerUserId) || userId;
        const subscriptionTypeName = await getUserSubscriptionType(subscriptionUserId);

        response.subscriptionType = subscriptionTypeName;

        // Get allowed pages (expands "*" to actual list) — use org owner's if in org
        response.allowedPages = await getAllowedPages(subscriptionUserId);

        // Get hidden pages — use org owner's if in org
        response.hiddenPages = await getHiddenPages(subscriptionUserId);

        // Get allowed skills resolved to { skillId, name } for display — use org owner's if in org
        const allowedSkillIds = await getAllowedSkills(subscriptionUserId);
        const publishedSkills = await skillService.getPublishedSkills();
        const isWildcard = allowedSkillIds.includes("*");
        const allowedSet = new Set(allowedSkillIds);

        const skills = publishedSkills
          .filter((s: any) => isWildcard || allowedSet.has(s.skillId))
          .map((s: any) => ({ skillId: s.skillId, name: s.name }));

        // Include virtual __other_skills__ entry if allowed
        if (isWildcard || allowedSet.has('__other_skills__')) {
          skills.push({ skillId: '__other_skills__', name: 'Other Skills' });
        }

        response.allowedSkills = skills;

        // For org members, overlay the owner's Stripe subscription status fields so
        // the customer portal displays the correct plan status, billing date, etc.
        if (user.orgRole === 'member' && org?.ownerUserId && org.ownerUserId !== userId) {
          const ownerUser = await userDb.getUserById(org.ownerUserId);
          if (ownerUser) {
            response.subscription_status = ownerUser.subscription_status;
            response.current_period_end = ownerUser.current_period_end;
            response.has_payment_method = ownerUser.has_payment_method;
            response.scheduledChange = ownerUser.scheduledChange;
            response.orgManagedSubscription = true;
          }
        }
      } catch (error) {
        console.error('Error fetching subscription info:', error);
        // Default to Free subscription on error
        const { getAllowedPages } = await import('../services/subscriptionService');
        response.subscriptionType = 'Free';
        response.allowedPages = await getAllowedPages(userId);
        response.allowedSkills = [];
      }
    }

    response.hasBrandGuidelines = !!(user.brandGuidelines?.brandData?.brandName);

    // Include org info if user is in an org
    if (org) {
      response.orgId = org.orgId;
      response.orgName = org.name;
      response.orgRole = user.orgRole;
      response.hasBrandGuidelines = !!(org.brandGuidelines?.brandData?.brandName);
      // Merge org-level and user-level Drive folders so legacy user-record folders
      // (added before the org feature) continue to appear in the UI without migration.
      const orgFolders: Array<{ folderId: string; name: string }> =
        Array.isArray(org.googleDriveFolders) ? org.googleDriveFolders : [];
      const userFolders: Array<{ folderId: string; name: string }> =
        Array.isArray(user.googleDriveFolders) ? user.googleDriveFolders : [];
      const orgFolderIds = new Set(orgFolders.map((f: { folderId: string }) => f.folderId));
      response.googleDriveFolders = [...orgFolders, ...userFolders.filter((f: { folderId: string }) => !orgFolderIds.has(f.folderId))];
    }

    // Effective analytics config + whether the caller may edit it (drives the
    // customer-portal SEO dashboard gating and the Analytics & SEO Settings tab).
    try {
      response.effectiveAnalyticsConfig = await resolveAnalyticsConfig(user);
      response.canEditAnalyticsConfig = (await resolveConfigTarget(user)).canEdit;
    } catch (e: any) {
      console.error('Error resolving analytics config for /me:', e.message);
      response.canEditAnalyticsConfig = false;
    }

    res.json(response);
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get Slack channel name for support
router.get('/slack-channel-name', authenticateToken, async (req, res) => {
  try {
    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Collect all configured channel IDs (new array takes precedence; legacy single field as fallback)
    const channelIds: string[] = (user.slackChannels && user.slackChannels.length > 0)
      ? user.slackChannels
      : (user.slackChannel ? [user.slackChannel] : []);

    if (channelIds.length === 0) {
      return res.json({ channels: [] });
    }

    // Resolve each channel ID to name and URL
    try {
      const { getSlackChannelInfo } = await import('../services/slackService');
      const resolved = await Promise.all(
        channelIds.map(async (channelId) => {
          const channelInfo = await getSlackChannelInfo(channelId);
          if (!channelInfo) return null;
          return {
            name: channelInfo.name,
            url: `https://slack.com/app_redirect?channel=${channelId}`
          };
        })
      );
      return res.json({ channels: resolved.filter(Boolean) });
    } catch (error) {
      console.error('Error resolving Slack channel names:', error);
      return res.json({ channels: [] });
    }
  } catch (error) {
    console.error('Error fetching Slack channel name:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Regular auth routes (rate-limited to prevent brute-force)
router.post('/register', authRateLimiter, authController.register);
router.post('/login', authRateLimiter, authController.login);

// Password reset routes
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Google OAuth routes
router.get('/google', (req: Request, res: Response, next: NextFunction) => {
  const portal = req.query.portal === 'customer' ? 'customer' : 
                 req.query.portal === 'genius' ? 'genius' : 'partner';
  passport.authenticate('google', { 
    scope: ['profile', 'email'], 
    state: portal
  })(req, res, next);
});

const googleAuthFinalHandler = (req: Request, res: Response) => {
    if (!req.user) {
        let failureRedirectPortal = PARTNER_FRONTEND_URL;
        if (req.query.state === 'customer') {
            failureRedirectPortal = CUSTOMER_FRONTEND_URL;
        } else if (req.query.state === 'genius') {
            failureRedirectPortal = GROWTH_GENIUS_CHAT_URL;
        }
        return res.redirect(`${failureRedirectPortal}/oauth-callback?error=${encodeURIComponent('Google authentication session error. Please try again.')}&code=session_error`);
    }

    const userAuthInfo = req.user as any;
    const portalState = req.query.state as string;
    let targetFrontendUrl = PARTNER_FRONTEND_URL;
    if (portalState === 'customer') {
        targetFrontendUrl = CUSTOMER_FRONTEND_URL;
    } else if (portalState === 'genius') {
        targetFrontendUrl = GROWTH_GENIUS_CHAT_URL;
    }

    if (!userAuthInfo || !userAuthInfo.token) {
        return res.redirect(`${targetFrontendUrl}/oauth-callback?error=${encodeURIComponent('Authentication token is missing after Google auth. Please try again.')}&code=token_missing`);
    }

    res.redirect(`${targetFrontendUrl}/oauth-callback?token=${userAuthInfo.token}`);
};

router.get('/google/callback', 
  (req: Request, res: Response, next: NextFunction) => {
    const state = req.query.state as string;
    
    const customPassportAuthCallback = (err: any, user: any, info: any, status: any) => {
      let frontendUrl = PARTNER_FRONTEND_URL;
      if (state === 'customer') {
        frontendUrl = CUSTOMER_FRONTEND_URL;
      } else if (state === 'genius') {
        frontendUrl = GROWTH_GENIUS_CHAT_URL;
      }

      if (err) {
        const errMsg = err.message || 'Authentication failed due to an error.';
        const errCode = err.code || 'auth_error';
        return res.redirect(`${frontendUrl}/oauth-callback?error=${encodeURIComponent(errMsg)}&code=${errCode}`);
      }
      
      if (!user) {
        let errMsg = 'Authentication failed: No user details received.';
        let errCode = 'no_user_in_passport_cb';
        if (info && typeof info === 'object' && info.message) {
          errMsg = info.message;
        } else if (info) {
          errMsg = typeof info === 'string' ? info : 'Additional information might be available in server logs.';
        }
        return res.redirect(`${frontendUrl}/oauth-callback?error=${encodeURIComponent(errMsg)}&code=${errCode}`);
      }
      
      req.user = user; 
      next(); 
    };
    
    passport.authenticate('google', { 
      session: false,
      state: state
    }, customPassportAuthCallback)(req, res, next);
  },
  googleAuthFinalHandler
);

// Get task subscribers
router.get('/tasks/:taskId/subscribers', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const subscribers = await subscriberDb.getTaskSubscribers(taskId);
    res.json(subscribers);
  } catch (error: any) {
    console.error('Error getting task subscribers:', error);
    res.status(500).json({ message: error.message });
  }
});

// Add subscriber to task
router.post('/tasks/:taskId/subscribers', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const subscriber = await subscriberDb.addSubscriber(taskId, email);
    res.status(201).json(subscriber);
  } catch (error: any) {
    console.error('Error adding subscriber:', error);
    if (error.message.includes('already subscribed')) {
      res.status(409).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

// Remove subscriber from task
router.delete('/tasks/:taskId/subscribers/:email', authenticateToken, async (req, res) => {
  try {
    const { taskId, email } = req.params;
    await subscriberDb.removeSubscriber(taskId, email);
    res.status(204).send();
  } catch (error: any) {
    console.error('Error removing subscriber:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get user chat sessions
router.get('/:userId/chat-sessions', authenticateToken, async (req, res) => {
  const chatbotDb = new ChatbotDB();
  
  const authenticatedReq = req as AuthenticatedRequest;
  const { userId } = req.params;
  const { portalType } = req.query as { portalType?: string };

  if (authenticatedReq.user.userId !== userId && !authenticatedReq.user.isAdmin) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  if (portalType === 'customer') {
    if (!authenticatedReq.user.roles || !authenticatedReq.user.roles.includes('customer')) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'User does not have customer role'
      });
    }
  }

  try {
    const sessions = await chatbotDb.getUserSessions(userId);
    res.json(sessions);
  } catch (error) {
    console.error('Error fetching user chat sessions:', error);
    res.status(500).json({ message: 'Failed to fetch chat sessions' });
  }
});

// Allowed values for the onboarding "What would you like Emma to help with?" multi-select.
// Keep in sync with the frontend OnboardingHelpSelect component.
const ALLOWED_EMMA_HELP_INTERESTS = new Set<string>([
  'brand',
  'paid_ads',
  'founder_led_sales',
  'organic_content',
  'outreach_smartlead',
  'paid_plus_organic',
  'not_sure',
]);

// Persist the user's onboarding interests. Called from the onboarding flow;
// empty array = user skipped, still recorded so we don't re-prompt.
router.patch('/onboarding-interests', authenticateToken, async (req, res) => {
  try {
    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const { interests } = req.body ?? {};
    if (!Array.isArray(interests)) {
      return res.status(400).json({ message: 'interests must be an array of strings' });
    }
    if (interests.length > ALLOWED_EMMA_HELP_INTERESTS.size) {
      return res.status(400).json({ message: 'Too many interests' });
    }
    const invalid = interests.filter((i: unknown) => typeof i !== 'string' || !ALLOWED_EMMA_HELP_INTERESTS.has(i));
    if (invalid.length > 0) {
      return res.status(400).json({ message: `Invalid interest value(s): ${invalid.join(', ')}` });
    }
    // Dedup while preserving order
    const deduped = Array.from(new Set<string>(interests as string[]));

    const updated = await userDb.updateUser(userId, {
      emmaHelpInterests: deduped,
      emmaHelpInterestsSetAt: new Date().toISOString(),
    } as any);

    if (!updated) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({
      emmaHelpInterests: deduped,
      emmaHelpInterestsSetAt: (updated as any).emmaHelpInterestsSetAt,
    });
  } catch (error) {
    console.error('Error saving onboarding interests:', error);
    return res.status(500).json({ message: 'Failed to save onboarding interests' });
  }
});

export default router; 