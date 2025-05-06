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