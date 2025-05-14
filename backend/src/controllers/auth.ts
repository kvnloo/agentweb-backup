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
      // Return specific error for user not found
      return res.status(404).json({ 
        message: 'User not found. Please create an account to continue.',
        code: 'user_not_found' 
      });
    }

    // Check if user is deactivated
    if (user.isActive === false) {
      return res.status(403).json({ message: 'Account has been deactivated. Please contact support.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Ensure JWT uses roles array (prefer over single role if both exist)
    const jwtPayload = { 
      userId: user.userId, 
      email: user.email,
      roles: user.roles || [], // Use roles array, default to empty if undefined
      isAdmin: user.isAdmin || false
    };
    const token = jwt.sign(jwtPayload, process.env.JWT_SECRET || 'your-secret-key');

    // Return user object (which might still have both role/roles from DB)
    const { password: _, ...userWithoutPassword } = user;
    res.json({ token, user: userWithoutPassword });
  } catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ message: 'Error logging in' });
  }
};

export const googleCallback = async (
  req: Request,
  accessToken: string,
  refreshToken: string,
  profile: Profile,
  done: (error: any, user?: any, info?: any) => void
) => {
  try {
    if (!profile) {
      return done(new Error('Google profile was not received'), null);
    }
    
    let email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    
    if (!email) {
      console.error('No email found in Google profile. Profile received:', JSON.stringify(profile, null, 2));
      return done(new Error('No email found in Google profile. Please ensure your Google account has a primary email and permissions are granted.'), null);
    }
    email = email.toLowerCase();

    let user = await userDb.getUserByEmail(email);
    
    const portalOrigin = req.query.state as string || 'partner';

    if (!user) {
      // Check waitlist status before creating a new user
      const waitlistEntry = await waitlistDb.getByEmail(email);
      
      if (!waitlistEntry) {
        const landingSiteUrl = process.env.LANDING_SITE_URL || 'https://agentweb.pro';
        // Create structured error object
        const errorObj = {
          statusCode: 403,
          message: `Please join our waitlist first at ${landingSiteUrl}`,
          code: 'not_in_waitlist'
        };
        return done(errorObj, null);
      }
      
      if (waitlistEntry.status !== 'invited') {
        // Create structured error object
        const errorObj = {
          statusCode: 403,
          message: 'Your account is on our waitlist but hasn\'t been invited yet. Please look out for an invitation email.',
          code: 'not_invited'
        };
        return done(errorObj, null);
      }

      const userId = Date.now().toString();
      const defaultRolesForNewOAuthUser: ('partner' | 'customer')[] = portalOrigin === 'customer' ? ['customer'] : ['partner'];
      
      console.log(`New OAuth user from ${portalOrigin} portal. Assigning roles: ${defaultRolesForNewOAuthUser.join(', ')}`);
      
      // Pass roles array to createUser
      await userDb.createUser(email, userId, '', true, false, defaultRolesForNewOAuthUser, profile.displayName, profile.id);
      user = await userDb.getUserByEmail(email);
      
      if (!user) {
        return done(new Error('Failed to create or find user after creation attempt.'), null);
      }
    } else {
      // User exists. Optionally, update their Google ID or display name if changed.
      // if (user.googleId !== profile.id || user.displayName !== profile.displayName) {
      //   await userDb.updateUser(user.userId, { googleId: profile.id, displayName: profile.displayName });
      // }
    }

    // Check if user has appropriate role for the portal
    if (portalOrigin === 'customer' && (!user.roles || !user.roles.includes('customer'))) {
      const errorObj = {
        statusCode: 403,
        message: 'Access denied: You do not have permission to access this portal.',
        code: 'invalid_role'
      };
      return done(errorObj, null);
    }

    // Prioritize roles array from DB, default based on origin if necessary
    const userRoles = user.roles && user.roles.length > 0 
                      ? user.roles 
                      : (portalOrigin === 'customer' ? ['customer'] : ['partner']);

    // Generate JWT token with roles array
    const token = jwt.sign(
      { 
        userId: user.userId, 
        email: user.email,
        roles: userRoles, // Use the determined roles array
        isAdmin: user.isAdmin || false
      },
      process.env.JWT_SECRET || 'your-secret-key'
    );

    // Pass object containing roles array to done callback
    done(null, { 
      token,
      userId: user.userId,
      email: user.email,
      roles: userRoles, // Pass roles array
      isAdmin: user.isAdmin || false
    });
  } catch (error) {
    console.error('Error in Google callback processing:', error);
    
    // Ensure error is properly formatted even for unexpected errors
    let formattedError = error;
    
    // If it's a standard error object, format it
    if (error instanceof Error) {
      formattedError = {
        statusCode: 500,
        message: error.message || 'An unexpected error occurred during authentication.',
        code: 'server_error'
      };
    }
    
    done(formattedError, null);
  }
}; 