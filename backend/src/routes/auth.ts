import express from 'express';
import { register, login, googleCallback } from '../controllers/auth';
import { authenticateToken } from '../middleware/auth';
import { userDb, taskDb, subscriberDb } from '../services/db';
import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { AuthRequest } from '../types/express';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ChatbotDB } from '../services/chatbotService';
import * as authController from '../controllers/auth';

const router = express.Router();

// Define Frontend URLs based on environment or defaults
const PARTNER_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

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
        adminEmail: authenticatedReq.delegateInfo.adminEmail
      };
    }
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Regular auth routes
router.post('/register', authController.register);
router.post('/login', authController.login);

// Google OAuth routes
router.get('/google', (req: Request, res: Response, next: NextFunction) => {
  const portal = req.query.portal === 'customer' ? 'customer' : 'partner';
  passport.authenticate('google', { 
    scope: ['profile', 'email'], 
    state: portal
  })(req, res, next);
});

const googleAuthFinalHandler = (req: Request, res: Response) => {
    if (!req.user) {
        const failureRedirectPortal = req.query.state === 'customer' ? CUSTOMER_FRONTEND_URL : PARTNER_FRONTEND_URL;
        return res.redirect(`${failureRedirectPortal}/oauth-callback?error=${encodeURIComponent('Google authentication session error. Please try again.')}&code=session_error`);
    }

    const userAuthInfo = req.user as any;
    const portalState = req.query.state as string;
    const targetFrontendUrl = portalState === 'customer' ? CUSTOMER_FRONTEND_URL : PARTNER_FRONTEND_URL;

    if (!userAuthInfo || !userAuthInfo.token) {
        return res.redirect(`${targetFrontendUrl}/oauth-callback?error=${encodeURIComponent('Authentication token is missing after Google auth. Please try again.')}&code=token_missing`);
    }

    res.redirect(`${targetFrontendUrl}/oauth-callback?token=${userAuthInfo.token}`);
};

router.get('/google/callback', 
  (req: Request, res: Response, next: NextFunction) => {
    const state = req.query.state as string;
    
    const customPassportAuthCallback = (err: any, user: any, info: any, status: any) => {
      const frontendUrl = state === 'customer' ? CUSTOMER_FRONTEND_URL : PARTNER_FRONTEND_URL;

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

export default router; 