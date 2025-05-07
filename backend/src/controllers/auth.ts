import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';
import { Profile } from 'passport-google-oauth20';

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, roles: reqRoles } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // Check if user exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
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

    const token = jwt.sign(
      { userId, email, roles: userRoles },
      process.env.JWT_SECRET || 'your-secret-key'
    );

    res.status(201).json({ 
      token, 
      user: {
        userId,
        email,
        isAdmin: false,
        roles: userRoles,
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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await userDb.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check if user is deactivated
    if (user.isActive === false) {
      return res.status(403).json({ message: 'Account has been deactivated. Please contact support.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Token contains only userId, email, and roles (if exists)
    const token = jwt.sign(
      { 
        userId: user.userId, 
        email: user.email,
        ...(user.roles && { roles: user.roles })
      },
      process.env.JWT_SECRET || 'your-secret-key'
    );

    // Don't send sensitive information
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
    
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    
    if (!email) {
      console.error('No email found in Google profile. Profile received:', JSON.stringify(profile, null, 2));
      return done(new Error('No email found in Google profile. Please ensure your Google account has a primary email and permissions are granted.'), null);
    }

    let user = await userDb.getUserByEmail(email);
    
    const portalOrigin = req.query.state as string || 'partner';

    if (!user) {
      const userId = Date.now().toString();
      const defaultRolesForNewOAuthUser: ('partner' | 'customer')[] = portalOrigin === 'customer' ? ['customer'] : ['partner'];
      
      console.log(`New OAuth user from ${portalOrigin} portal. Assigning roles: ${defaultRolesForNewOAuthUser.join(', ')}`);
      
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

    const userRoles = user.roles && user.roles.length > 0 
                      ? user.roles 
                      : (portalOrigin === 'customer' ? ['customer'] : ['partner']);

    const token = jwt.sign(
      { 
        userId: user.userId, 
        email: user.email,
        roles: userRoles,
        isAdmin: user.isAdmin || false
      },
      process.env.JWT_SECRET || 'your-secret-key'
    );

    done(null, { 
      token,
      userId: user.userId,
      email: user.email,
      roles: userRoles,
      isAdmin: user.isAdmin || false
    });
  } catch (error) {
    console.error('Error in Google callback processing:', error);
    done(error, null);
  }
}; 