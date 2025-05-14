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

console.log('OAuth Configuration:', {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:3001',
  partnerFrontendUrl: PARTNER_FRONTEND_URL,
  customerFrontendUrl: CUSTOMER_FRONTEND_URL
});

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
    res.json(userWithoutPassword);
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
        console.error('Google authentication failed - req.user is not populated.');
        const failureRedirectPortal = req.query.state === 'customer' ? CUSTOMER_FRONTEND_URL : PARTNER_FRONTEND_URL;
        return res.redirect(`${failureRedirectPortal}/login?error=google_auth_failed`);
    }

    const userAuthInfo = req.user as any;
    const portalState = req.query.state as string;

    let targetFrontendUrl = PARTNER_FRONTEND_URL;
    if (portalState === 'customer') {
        targetFrontendUrl = CUSTOMER_FRONTEND_URL;
    }

    console.log(`Redirecting to ${portalState} portal: ${targetFrontendUrl}`);
    res.redirect(`${targetFrontendUrl}/oauth-callback?token=${userAuthInfo.token}`);
};

router.get('/google/callback', 
  (req: Request, res: Response, next: NextFunction) => {
    const state = req.query.state as string;
    
    // Custom error handler for Google authentication
    const authHandler = (err: any, user: any, info: any) => {
      if (err) {
        // Get appropriate frontend URL based on state
        const frontendUrl = state === 'customer' ? CUSTOMER_FRONTEND_URL : PARTNER_FRONTEND_URL;
        
        // Handle structured errors with specific error codes
        if (err.code && err.message) {
          return res.redirect(`${frontendUrl}/oauth-callback?error=${encodeURIComponent(err.message)}&code=${err.code}`);
        }
        
        // Handle regular error message
        const errorMsg = err.message || 'Authentication failed';
        return res.redirect(`${frontendUrl}/oauth-callback?error=${encodeURIComponent(errorMsg)}`);
      }
      
      if (!user) {
        const frontendUrl = state === 'customer' ? CUSTOMER_FRONTEND_URL : PARTNER_FRONTEND_URL;
        return res.redirect(`${frontendUrl}/oauth-callback?error=Authentication failed. Please try again.`);
      }
      
      // Set user on request and continue to next handler
      req.user = user;
      next();
    };
    
    passport.authenticate('google', { 
      session: false,
      state: state
    })(req, res, authHandler);
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
    res.status(500).json({ message: error.message });
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