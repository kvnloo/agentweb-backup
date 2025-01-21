import express from 'express';
import { register, login, googleCallback } from '../controllers/auth';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

const router = express.Router();

// Initialize Google strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  callbackURL: 'http://localhost:3001/api/auth/google/callback'
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
  (req, res) => {
    // Redirect to frontend with token
    const token = req.user?.token;
    res.redirect(`http://localhost:5173/oauth-callback?token=${token}`);
  }
);

export default router; 