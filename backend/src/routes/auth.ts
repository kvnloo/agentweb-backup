import express from 'express';
import { checkTaskSubscriberAccess } from '../services/taskSubscriberAccess';
import { register, login, googleCallback } from '../controllers/auth';
import { encodeGoogleOAuthState, parseGoogleOAuthState } from '../services/zomaSignupIntent';
import { authenticateToken } from '../middleware/auth';
import { userDb, taskDb, subscriberDb, orgDb } from '../services/db';
import { forgetSubscriberLookup } from '../services/subscriberLookup';
import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { AuthRequest } from '../types/express';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ChatbotDB } from '../services/chatbotService';
import { withoutWorkPlanProvenance } from '../utils/workPlanProvenance';
import * as authController from '../controllers/auth';
import rateLimit from 'express-rate-limit';
import { resolveAnalyticsConfig, resolveConfigTarget } from '../services/analyticsConfigResolver';
import { resolveOrgProfileField } from '../services/orgProfileResolver';
import { EvaluationDenied, isEvaluationUser, requireActiveEvaluation, sandboxInfo as buildSandboxInfo } from '../services/evaluationPolicy';
import { sanitizeUserForResponse } from '../utils/accountSecretRedaction';
import { modelCompareEntitlement } from '../services/agentMode/modelCompareEntitlement';
import { getTierCompareBlock, modelAccess } from '../services/agentMode/modelAccessInstance';

const router = express.Router();

// Rate limiter for login and register — 10 attempts per 15 minutes per IP
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Please try again later.' },
});

// Dedicated limiter for change-password so it has its OWN per-IP budget and
// can't be exhausted by (or exhaust) login/register attempts from the same IP.
const changePasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many password change attempts. Please try again later.' },
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
    // A sandbox principal (ENG-1907) gets the one field the portal needs for its
    // "Sandbox" pill; a revoked or expired sandbox must not receive a normal profile.
    let sandboxInfo: ReturnType<typeof buildSandboxInfo> | undefined;
    if (isEvaluationUser(userId)) {
      try {
        sandboxInfo = buildSandboxInfo(await requireActiveEvaluation(userId));
      } catch (error) {
        // Only a policy denial is a session problem; a store outage must surface as a 500,
        // not lock every sandbox account out with a "session invalid".
        if (error instanceof EvaluationDenied) return res.status(401).json({ code: 'session_invalid', message: 'Invalid token' });
        throw error;
      }
    }
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    // Don't send sensitive information
    const userWithoutPassword = sanitizeUserForResponse(user);

    // Add delegation information if this is a delegate session
    const response: any = userWithoutPassword;
    if (sandboxInfo) response.sandboxInfo = sandboxInfo;
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
        const { getUserSubscriptionType, getAllowedPages, getAllowedSkills, getAllowedFeatures, getHiddenPages } = await import('../services/subscriptionService');
        const { skillService } = await import('../services/skillService');

        // Resolution (including the org-owner fallback and the own-active-
        // subscription guard) is centralized in getUserSubscriptionType and
        // friends — call them with the caller's own userId directly rather
        // than pre-resolving to the owner here, or a member riding their own
        // active/trialing subscription would have it silently overridden by
        // the owner's tier (see subscriptionService.ts's discriminator).
        const subscriptionTypeName = await getUserSubscriptionType(userId);

        response.subscriptionType = subscriptionTypeName;

        // Get allowed pages (expands "*" to actual list)
        response.allowedPages = await getAllowedPages(userId);
        response.allowedFeatures = await getAllowedFeatures(userId);

        // Get hidden pages
        response.hiddenPages = await getHiddenPages(userId);

        // Get allowed skills resolved to { skillId, name } for display
        // ENG-1978: null = entitlement unresolved. Show no tier-granted skills rather than all of
        // them; this list drives what the UI advertises as available.
        const allowedSkillIds = (await getAllowedSkills(userId)) ?? [];
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
        // Skip the overlay for a member riding their own active/trialing subscription —
        // showing the owner's billing/payment info would be misleading when the member
        // is genuinely paying independently (same discriminator as getUserSubscriptionType).
        const hasOwnActiveSubscriptionForOverlay =
          user.subscription_status === 'active' || user.subscription_status === 'trialing';
        // Keyed on the billing root rather than on `orgRole === 'member'`: an admin
        // (or a second owner) is not "member", so the old test skipped the overlay
        // and showed them their own empty billing record instead of the org's.
        if (!hasOwnActiveSubscriptionForOverlay && org?.ownerUserId && org.ownerUserId !== userId) {
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
        response.allowedFeatures = [];
      }
    }

    // Plan add-on hint for the Compare models button. Additive, computed per request, never stored.
    // The server enforces the same rule on /compare, so a missing hint (error here, older backend) is safe.
    try {
      response.modelCompareEntitled = await modelCompareEntitlement.isEntitled({
        userId,
        isAdmin: authenticatedReq.user?.isAdmin === true,
      });
    } catch (error) {
      console.error('Error resolving model compare entitlement hint:', error);
    }
    // ENG-669 (D3) hint: the plan runs fewer than two models, so /compare answers 403
    // compare_not_available_for_tier. Present only while the tier allowlist is on; same rule as the server.
    try {
      if (await modelAccess.isEnabled()) {
        response.modelCompareTierBlocked = (await getTierCompareBlock(userId)) !== null;
      }
    } catch (error) {
      console.error('Error resolving model compare tier hint:', error);
    }

    response.hasBrandGuidelines = !!(user.brandGuidelines?.brandData?.brandName);
    // ENG-328 — mandatory design-system scrape. 'ready' covers both a real
    // scrape and the manual-fallback path (mirrors hasBrandGuidelines making
    // no distinction between a scraped and a manually-typed brand).
    response.hasDesignSystem = user.designSystem?.status === 'ready';

    // Include org info if user is in an org
    if (org) {
      response.orgId = org.orgId;
      response.orgName = org.name;
      response.orgRole = user.orgRole;
      // Org-level brand, falling back to the owner's record when the org was
      // created without copying the profile over, so this reports the same
      // brand the Brand Guidelines page serves (ENG-927). Read by MCP's
      // `emma_get_account_status` as `is_onboarded`.
      // Guarded like every other org-derived enrichment in this handler: the
      // fallback can issue an owner-record read, and `/me` is the endpoint the
      // whole app boots off — a transient failure must degrade this one flag,
      // not the entire response.
      try {
        const orgBrand = await resolveOrgProfileField(user, org, 'brandGuidelines');
        response.hasBrandGuidelines = !!(orgBrand?.brandData?.brandName);
      } catch (e: any) {
        console.error('Error resolving org brand for /me:', e?.message);
        response.hasBrandGuidelines = !!(org.brandGuidelines?.brandData?.brandName);
      }
      try {
        const orgDesignSystem = await resolveOrgProfileField(user, org, 'designSystem');
        response.hasDesignSystem = orgDesignSystem?.status === 'ready';
      } catch (e: any) {
        console.error('Error resolving org design system for /me:', e?.message);
        response.hasDesignSystem = org.designSystem?.status === 'ready';
      }
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
// ENG-2686: observe logout (client still discards the JWT); always 204.
router.post('/logout', authenticateToken, authController.logout);

// Password reset routes
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Authenticated self-service password change (Settings → Change Password).
// Rate-limited, and terminates all other sessions on success.
router.put('/change-password', changePasswordRateLimiter, authenticateToken, authController.changePassword);

// Google OAuth routes
router.get('/google', (req: Request, res: Response, next: NextFunction) => {
  const portal = req.query.portal === 'customer' ? 'customer' : 
                 req.query.portal === 'genius' ? 'genius' : 'partner';
  passport.authenticate('google', { 
    scope: ['profile', 'email'], 
    // ENG-3124: a Zoma sign-in carries its signed signup intent through Google in the state.
    state: encodeGoogleOAuthState(portal, req.query.signupIntent)
  })(req, res, next);
});

function portalFrontendUrl(state: unknown): string {
  const { portal } = parseGoogleOAuthState(state);
  if (portal === 'customer') return CUSTOMER_FRONTEND_URL;
  if (portal === 'genius') return GROWTH_GENIUS_CHAT_URL;
  return PARTNER_FRONTEND_URL;
}

const googleAuthFinalHandler = (req: Request, res: Response) => {
    if (!req.user) {
        const failureRedirectPortal = portalFrontendUrl(req.query.state);
        return res.redirect(`${failureRedirectPortal}/oauth-callback?error=${encodeURIComponent('Google authentication session error. Please try again.')}&code=session_error`);
    }

    const userAuthInfo = req.user as any;
    const targetFrontendUrl = portalFrontendUrl(req.query.state);

    if (!userAuthInfo || !userAuthInfo.token) {
        return res.redirect(`${targetFrontendUrl}/oauth-callback?error=${encodeURIComponent('Authentication token is missing after Google auth. Please try again.')}&code=token_missing`);
    }

    // ENG-470: propagate the new-vs-returning signal only when true. Returning
    // logins get no param, so the portal can never mistake them for signups.
    const newUserSuffix = userAuthInfo.isNewUser === true ? '&isNewUser=true' : '';
    res.redirect(`${targetFrontendUrl}/oauth-callback?token=${userAuthInfo.token}${newUserSuffix}`);
};

router.get('/google/callback', 
  (req: Request, res: Response, next: NextFunction) => {
    const state = req.query.state as string;
    
    const customPassportAuthCallback = (err: any, user: any, info: any, status: any) => {
      const frontendUrl = portalFrontendUrl(state);

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
    // ENG-2989: the records include email addresses, imported fields and email history: the task's owner or an admin only.
    const access = await checkTaskSubscriberAccess((req as unknown as AuthenticatedRequest).user?.userId, taskId);
    if (!access.ok) {
      return res.status(access.status).json({ message: access.message });
    }
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

    // ENG-2989: the task's owner or an admin only (this route used to need only a login).
    const access = await checkTaskSubscriberAccess((req as unknown as AuthenticatedRequest).user?.userId, taskId);
    if (!access.ok) {
      return res.status(access.status).json({ message: access.message });
    }

    const subscriber = await subscriberDb.addSubscriber(taskId, email);
    forgetSubscriberLookup(taskId);
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
    // ENG-2989: the task's owner or an admin only (this route used to need only a login).
    const access = await checkTaskSubscriberAccess((req as unknown as AuthenticatedRequest).user?.userId, taskId);
    if (!access.ok) {
      return res.status(access.status).json({ message: access.message });
    }
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
    // ENG-669: a non-admin never gets the work plan's model provenance bookkeeping (as on agent mode's reads).
    const viewerIsAdmin = !!(authenticatedReq.user.isAdmin || authenticatedReq.delegateInfo?.isDelegated);
    res.json({ ...sessions, sessions: sessions.sessions.map((session) => withoutWorkPlanProvenance(session, viewerIsAdmin)) });
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
  'outreach',
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

    const { interests, companyName, companyUrl } = req.body ?? {};
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
    const companyPatch: Record<string, unknown> = {};
    if (typeof companyName === 'string' && companyName.trim()) {
      companyPatch.companyName = companyName.trim();
    }
    if (typeof companyUrl === 'string' && companyUrl.trim()) {
      companyPatch.productDomain = companyUrl.trim();
    }

    const updated = await userDb.updateUser(userId, {
      emmaHelpInterests: deduped,
      emmaHelpInterestsSetAt: new Date().toISOString(),
      ...companyPatch,
    } as any);

    if (!updated) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({
      emmaHelpInterests: deduped,
      emmaHelpInterestsSetAt: (updated as any).emmaHelpInterestsSetAt,
      ...(companyPatch.companyName ? { companyName: companyPatch.companyName } : {}),
      ...(companyPatch.productDomain ? { productDomain: companyPatch.productDomain } : {}),
    });
  } catch (error) {
    console.error('Error saving onboarding interests:', error);
    return res.status(500).json({ message: 'Failed to save onboarding interests' });
  }
});

export default router;
