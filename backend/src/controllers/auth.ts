import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';
import { Profile } from 'passport-google-oauth20';

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, role } = req.body;

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

    // Validate role if provided, default to 'partner'
    const validRoles = ['partner', 'customer'];
    let userRole = 'partner'; // Default role
    if (role && validRoles.includes(role)) {
      userRole = role as 'partner' | 'customer';
    }

    // Create user in DynamoDB
    await userDb.createUser(email, userId, hashedPassword, false, false, userRole as 'partner' | 'customer');

    const token = jwt.sign(
      { userId, email, role: userRole },
      process.env.JWT_SECRET || 'your-secret-key'
    );

    res.status(201).json({ 
      token, 
      user: {
        userId,
        email,
        isAdmin: false,
        role: userRole,
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

    // Token contains only userId, email, and role (if exists)
    const token = jwt.sign(
      { 
        userId: user.userId, 
        email: user.email,
        ...(user.role && { role: user.role })
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
  accessToken: string,
  refreshToken: string,
  profile: Profile,
  done: (error: any, user?: any) => void
) => {
  try {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      return done(new Error('No email found in Google profile'));
    }

    // Check if user exists
    let user = await userDb.getUserByEmail(email);
    
    if (!user) {
      // Create new user if doesn't exist
      const userId = Date.now().toString();
      // Set 'partner' as default role for OAuth users
      await userDb.createUser(email, userId, '', true, false, 'partner');
      user = await userDb.getUserByEmail(email);
      
      if (!user) {
        throw new Error('Failed to create user');
      }
    }

    // Use the user's role or default to 'partner'
    const userRole = user.role || 'partner';

    // Generate JWT token with necessary data
    const token = jwt.sign(
      { 
        userId: user.userId, 
        email: user.email,
        role: userRole
      },
      process.env.JWT_SECRET || 'your-secret-key'
    );

    // Pass token and user details to callback
    // This ensures the user object in the request will have all necessary properties
    done(null, { 
      token,
      userId: user.userId,
      email: user.email,
      role: userRole,
      isAdmin: user.isAdmin || false
    });
  } catch (error) {
    console.error('Error in Google callback:', error);
    done(error);
  }
}; 