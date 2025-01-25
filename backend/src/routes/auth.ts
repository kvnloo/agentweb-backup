import express from 'express';
import { register, login, googleCallback } from '../controllers/auth';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { AuthRequest } from '../types/express';

const router = express.Router();

// Initialize Google strategy
console.log('OAuth Configuration:', {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:3001',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173'
});

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  callbackURL: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/google/callback`
}, googleCallback));

// Regular auth routes
router.post('/register', register);
router.post('/login', login);

// Google OAuth routes
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  session: false
}));

router.get('/google/callback',
  passport.authenticate('google', { session: false }),
  (req: AuthRequest, res) => {
    // Redirect to frontend with token
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication failed' });
    }
    console.log('OAuth Callback - Redirecting to frontend:', {
      frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
      token: !!req.user.token || !!req.user.accessToken
    });
    const token = req.user.accessToken || req.user.token;  // Try both possible token locations
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/oauth-callback?token=${token}`);
  }
);

export default router; 