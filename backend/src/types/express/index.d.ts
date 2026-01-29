import { Request } from 'express';

declare global {
  namespace Express {
    interface User {
      userId: string;
      email: string;
      accessToken?: string;
      token?: string;
      role?: string;
    }
    
    interface AuthInfo {
      portal?: string;
    }
  }
}

export interface AuthRequest extends Request {
  user?: Express.User;
  authInfo?: Express.AuthInfo;
}

// This empty export is required for TypeScript to treat this as a module
// and properly apply the global augmentation
export {}; 