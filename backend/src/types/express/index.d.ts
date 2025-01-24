import { Request } from 'express';

declare global {
  namespace Express {
    interface User {
      userId: string;
      email: string;
      accessToken?: string;
      token?: string;
    }
  }
}

export interface AuthRequest extends Request {
  user?: Express.User;
} 