import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';
import { Profile } from 'passport-google-oauth20';
import { waitlistDb } from '../services/waitlistDb';

export const register = async (req: Request, res: Response) => {
  try {
    let { email, password, roles: reqRoles } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    email = email.toLowerCase();

    // Check if user exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Check waitlist status
    const waitlistEntry = await waitlistDb.getByEmail(email);
    
    if (!waitlistEntry) {
      const landingSiteUrl = process.env.LANDING_SITE_URL || 'https://agentweb.pro';
      return res.status(403).json({ 
        message: `Please join our waitlist first at ${landingSiteUrl}`,
        code: 'not_in_waitlist'
      });
    }
    
    if (waitlistEntry.status !== 'invited') {
      return res.status(403).json({ 
        message: 'Your account is on our waitlist but hasn\'t been invited yet. Please look out for an invitation email.',
        code: 'not_invited'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = Date.now().toString();

    // Validate roles if provided, default to ['partner']
    const validRolesSet = new Set(['partner', 'customer']);
    let userRoles: ('partner' | 'customer')[] = ['partner']; // Default roles

    if (reqRoles && Array.isArray(reqRoles) && reqRoles.length > 0 && reqRoles.every(r => validRolesSet.has(r))) {
      userRoles = reqRoles as ('partner' | 'customer')[]; // Explicitly cast reqRoles
    }

    // Create user in DynamoDB
    await userDb.createUser(email, userId, hashedPassword, false, false, userRoles);

    // JWT includes roles array
    const token = jwt.sign(
      { userId, email, roles: userRoles, isAdmin: false }, // Include isAdmin=false for clarity
      process.env.JWT_SECRET || 'your-secret-key'
    );

    res.status(201).json({ 
      token, 
      user: {
        userId,
        email,
        isAdmin: false,
        roles: userRoles, // Send roles array
        isOAuthUser: false,
        createdAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error in register:', error);
    res.status(500).json({ message: 'Error creating user' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    let { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    email = email.toLowerCase();

    const user = await userDb.getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ 
        message: 'User not found. Please create an account to continue.',
        code: 'user_not_found' 
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({ 
        message: 'Account has been deactivated. Please contact support.',
        code: 'account_deactivated' 
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ 
        message: 'Invalid credentials. Please check your email and password.',
        code: 'invalid_credentials' 
      });
    }

    const jwtPayload = { 
      userId: user.userId, 
      email: user.email,
      roles: user.roles || [],
      isAdmin: user.isAdmin || false
    };
    const token = jwt.sign(jwtPayload, process.env.JWT_SECRET || 'your-secret-key');

    const { password: _, ...userWithoutPassword } = user;
    res.json({ token, user: userWithoutPassword });
  } catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ message: 'Error logging in', code: 'server_error' });
  }
};

export const googleCallback = async (
  req: Request,
  accessToken: string,
  refreshToken: string,
  profile: Profile,
  done: (error: any, user?: any, info?: any) => void
) => {
  console.log('[DEBUG] googleCallback: Received profile:', JSON.stringify(profile, null, 2));
  console.log('[DEBUG] googleCallback: AccessToken received:', !!accessToken);
  console.log('[DEBUG] googleCallback: RefreshToken received:', !!refreshToken);
  console.log('[DEBUG] googleCallback: req.query.state (portalOrigin):', req.query.state);

  try {
    if (!profile) {
      console.error('[ERROR] googleCallback: Google profile was not received.');
      return done(new Error('Google profile was not received'), null);
    }
    
    let email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    console.log('[DEBUG] googleCallback: Extracted raw email:', email);
    
    if (!email) {
      console.error('[ERROR] googleCallback: No email found in Google profile.');
      return done(new Error('No email found in Google profile. Please ensure your Google account has a primary email and permissions are granted.'), null);
    }
    email = email.toLowerCase();
    console.log('[DEBUG] googleCallback: Lowercased email:', email);

    let user = await userDb.getUserByEmail(email);
    console.log('[DEBUG] googleCallback: User from DB by email:', user ? { userId: user.userId, email: user.email, roles: user.roles } : null);
    
    const portalOrigin = req.query.state as string || 'partner';

    if (!user) {
      console.log(`[DEBUG] googleCallback: User not found for ${email}. Attempting to create new user for portal: ${portalOrigin}`);
      const waitlistEntry = await waitlistDb.getByEmail(email);
      console.log('[DEBUG] googleCallback: Waitlist entry for new user:', waitlistEntry);
      
      if (!waitlistEntry) {
        const landingSiteUrl = process.env.LANDING_SITE_URL || 'https://agentweb.pro';
        const errorObj = {
          statusCode: 403,
          message: `Please join our waitlist first at ${landingSiteUrl}`,
          code: 'not_in_waitlist'
        };
        console.warn('[WARN] googleCallback: New user not on waitlist:', errorObj);
        return done(errorObj, null);
      }
      
      if (waitlistEntry.status !== 'invited') {
        const errorObj = {
          statusCode: 403,
          message: "Your account is on our waitlist but hasn't been invited yet. Please look out for an invitation email.",
          code: 'not_invited'
        };
        console.warn('[WARN] googleCallback: New user on waitlist but not invited:', errorObj);
        return done(errorObj, null);
      }

      const userId = Date.now().toString();
      const defaultRolesForNewOAuthUser: ('partner' | 'customer')[] = portalOrigin === 'customer' ? ['customer'] : ['partner'];
      
      console.log(`[DEBUG] googleCallback: Creating new OAuth user. UserID: ${userId}, Roles: ${defaultRolesForNewOAuthUser.join(', ')}, DisplayName: ${profile.displayName}`);
      await userDb.createUser(email, userId, '', true, false, defaultRolesForNewOAuthUser, profile.displayName, profile.id);
      user = await userDb.getUserByEmail(email);
      console.log('[DEBUG] googleCallback: New user fetched from DB after creation:', user ? { userId: user.userId, email: user.email, roles: user.roles } : 'FETCH FAILED');
      
      if (!user) {
        console.error('[ERROR] googleCallback: Failed to create or find user after creation attempt.');
        return done(new Error('Failed to create or find user after creation attempt.'), null);
      }
    } else {
      console.log(`[DEBUG] googleCallback: Existing user found for ${email}. UserID: ${user.userId}`);
    }

    console.log(`[DEBUG] googleCallback: Checking roles for user ${user.email} for portalOrigin ${portalOrigin}. User roles: ${user.roles}`);
    if (portalOrigin === 'customer' && (!user.roles || !user.roles.includes('customer'))) {
      const errorObj = {
        statusCode: 403,
        message: 'Access denied: Your account does not have permission to access this customer portal.',
        code: 'invalid_role'
      };
      console.warn('[WARN] googleCallback: User role check failed for customer portal:', errorObj);
      return done(errorObj, null);
    }

    const userRoles = user.roles && user.roles.length > 0 
                      ? user.roles 
                      : (portalOrigin === 'customer' ? ['customer'] : ['partner']);
    console.log('[DEBUG] googleCallback: Final userRoles to be used in token:', userRoles);

    const tokenPayload = { 
      userId: user.userId, 
      email: user.email,
      roles: userRoles,
      isAdmin: user.isAdmin || false
    };
    console.log('[DEBUG] googleCallback: JWT Payload to be signed:', tokenPayload);
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET || 'your-secret-key');
    console.log('[DEBUG] googleCallback: JWT generated successfully.');

    const resultUserObject = { 
      token,
      userId: user.userId,
      email: user.email,
      roles: userRoles,
      isAdmin: user.isAdmin || false
    };
    console.log('[DEBUG] googleCallback: Calling done() with success. User object:', resultUserObject);
    done(null, resultUserObject);

  } catch (error: any) {
    console.error('[FATAL] googleCallback: Unhandled exception:', error.message, error.stack);
    let formattedError = error;
    if (error instanceof Error) {
      formattedError = {
        statusCode: 500,
        message: error.message || 'An unexpected error occurred during Google authentication.',
        code: 'server_error'
      };
    }
    console.error('[FATAL] googleCallback: Calling done() with formatted error:', formattedError);
    done(formattedError, null);
  }
}; 