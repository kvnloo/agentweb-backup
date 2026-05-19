import { register, login, forgotPassword, resetPassword } from '../controllers/auth';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { emailService } from '../services/emailService';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

jest.mock('../services/db');
jest.mock('../services/waitlistDb');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');
jest.mock('../services/emailService');

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;
const mockBcryptHash = bcrypt.hash as jest.MockedFunction<typeof bcrypt.hash>;
const mockBcryptCompare = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;

const createRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createNext = () => jest.fn();

describe('Security Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  // ─── A. Auth Middleware ───────────────────────────────────────────

  describe('authenticateToken middleware', () => {
    it('FAIL: missing Authorization header → 401 "No token provided"', async () => {
      const req: any = { headers: {} };
      const res = createRes();
      const next = createNext();

      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'No token provided' });
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: malformed Bearer token (no space) → 401', async () => {
      const req: any = { headers: { authorization: 'Bearertoken123' } };
      const res = createRes();
      const next = createNext();

      // split(' ')[1] returns undefined for "Bearertoken123" → no token
      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: empty token after Bearer → 401', async () => {
      const req: any = { headers: { authorization: 'Bearer ' } };
      const res = createRes();
      const next = createNext();

      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: invalid JWT signature → 401 "Invalid token"', async () => {
      const req: any = { headers: { authorization: 'Bearer bad-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error('invalid signature');
      });

      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: expired JWT → 401 "Invalid token"', async () => {
      const req: any = { headers: { authorization: 'Bearer expired-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockImplementation(() => {
        const err: any = new Error('jwt expired');
        err.name = 'TokenExpiredError';
        throw err;
      });

      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: valid JWT but user deleted from DB → 401 "Invalid token"', async () => {
      const req: any = { headers: { authorization: 'Bearer valid-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'deleted-user',
        email: 'gone@example.com',
        isAdmin: false,
      });
      mockUserDb.getUserById.mockResolvedValue(undefined as any);

      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: delegated token where admin is not actually admin → 401', async () => {
      const req: any = { headers: { authorization: 'Bearer delegate-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'admin-123',
        delegateAccess: {
          adminUserId: 'admin-123',
          adminEmail: 'fake-admin@example.com',
          targetUserId: 'target-456',
          targetEmail: 'target@example.com',
        },
      });
      // Admin user exists but isAdmin is false
      mockUserDb.getUserById.mockImplementation(async (id: string) => {
        if (id === 'admin-123') return { userId: 'admin-123', email: 'fake-admin@example.com', isAdmin: false } as any;
        if (id === 'target-456') return { userId: 'target-456', email: 'target@example.com', isAdmin: false, roles: ['customer'] } as any;
        return undefined as any;
      });

      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: delegated token where target user does not exist → 401', async () => {
      const req: any = { headers: { authorization: 'Bearer delegate-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'admin-123',
        delegateAccess: {
          adminUserId: 'admin-123',
          adminEmail: 'admin@example.com',
          targetUserId: 'nonexistent-456',
          targetEmail: 'ghost@example.com',
        },
      });
      mockUserDb.getUserById.mockImplementation(async (id: string) => {
        if (id === 'admin-123') return { userId: 'admin-123', email: 'admin@example.com', isAdmin: true } as any;
        return undefined as any; // target user not found
      });

      await authenticateToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('SUCCESS: valid token → req.user populated correctly', async () => {
      const req: any = { headers: { authorization: 'Bearer good-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'user-123',
        email: 'user@example.com',
        isAdmin: false,
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'user@example.com',
        isAdmin: false,
        roles: ['customer'],
      } as any);

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({
        userId: 'user-123',
        email: 'user@example.com',
        isAdmin: false,
        roles: ['customer'],
      });
      expect(req.delegateInfo).toBeUndefined();
    });

    it('SUCCESS: valid delegated token → req.user is target user, delegateInfo set', async () => {
      const req: any = { headers: { authorization: 'Bearer delegate-good-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'admin-123',
        delegateAccess: {
          adminUserId: 'admin-123',
          adminEmail: 'admin@example.com',
          targetUserId: 'target-456',
          targetEmail: 'target@example.com',
        },
      });
      mockUserDb.getUserById.mockImplementation(async (id: string) => {
        if (id === 'admin-123') return { userId: 'admin-123', email: 'admin@example.com', isAdmin: true } as any;
        if (id === 'target-456') return { userId: 'target-456', email: 'target@example.com', isAdmin: false, roles: ['customer'] } as any;
        return undefined as any;
      });

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({
        userId: 'target-456',
        email: 'target@example.com',
        isAdmin: false,
        roles: ['customer'],
      });
      expect(req.delegateInfo).toEqual({
        adminUserId: 'admin-123',
        adminEmail: 'admin@example.com',
        isDelegated: true,
        isContractor: false,
      });
    });

    it('SUCCESS: delegated token to admin target → req.user.isAdmin is true', async () => {
      const req: any = { headers: { authorization: 'Bearer delegate-admin-jwt' } };
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'admin-123',
        delegateAccess: {
          adminUserId: 'admin-123',
          adminEmail: 'admin@example.com',
          targetUserId: 'admin-456',
          targetEmail: 'admin2@example.com',
        },
      });
      mockUserDb.getUserById.mockImplementation(async (id: string) => {
        if (id === 'admin-123') return { userId: 'admin-123', email: 'admin@example.com', isAdmin: true } as any;
        if (id === 'admin-456') return { userId: 'admin-456', email: 'admin2@example.com', isAdmin: true, roles: ['partner'] } as any;
        return undefined as any;
      });

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({
        userId: 'admin-456',
        email: 'admin2@example.com',
        isAdmin: true,
        roles: ['partner'],
      });
      expect(req.delegateInfo).toEqual({
        adminUserId: 'admin-123',
        adminEmail: 'admin@example.com',
        isDelegated: true,
        isContractor: false,
      });
    });
  });

  describe('requireAdmin middleware', () => {
    it('SUCCESS: admin user → next() called', () => {
      const req: any = { user: { userId: 'admin-1', email: 'admin@example.com', isAdmin: true } };
      const res = createRes();
      const next = createNext();

      requireAdmin(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('FAIL: non-admin user → 403', () => {
      const req: any = { user: { userId: 'user-1', email: 'user@example.com', isAdmin: false } };
      const res = createRes();
      const next = createNext();

      requireAdmin(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: 'Admin access required' });
      expect(next).not.toHaveBeenCalled();
    });

    it('FAIL: no user on request → 401', () => {
      const req: any = {};
      const res = createRes();
      const next = createNext();

      requireAdmin(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Authentication required' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── B. Auth Controller - Login ──────────────────────────────────

  describe('login controller', () => {
    it('FAIL: missing email → 400', async () => {
      const req: any = { body: { password: 'pass123' } };
      const res = createRes();

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Email and password are required' });
    });

    it('FAIL: missing password → 400', async () => {
      const req: any = { body: { email: 'user@example.com' } };
      const res = createRes();

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Email and password are required' });
    });

    it('FAIL: user not found → 404', async () => {
      const req: any = { body: { email: 'nobody@example.com', password: 'pass123' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'user_not_found' }));
    });

    it('FAIL: account deactivated → 403', async () => {
      const req: any = { body: { email: 'deactivated@example.com', password: 'pass123' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({
        userId: 'user-1',
        email: 'deactivated@example.com',
        isActive: false,
        password: 'hashed',
      } as any);

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'account_deactivated' }));
    });

    it('FAIL: wrong password → 401', async () => {
      const req: any = { body: { email: 'user@example.com', password: 'wrong' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({
        userId: 'user-1',
        email: 'user@example.com',
        isActive: true,
        password: 'hashed',
      } as any);
      (mockBcryptCompare as unknown as jest.Mock).mockResolvedValue(false);

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_credentials' }));
    });

    it('SUCCESS: valid credentials → token + user (no password in response)', async () => {
      const req: any = { body: { email: 'user@example.com', password: 'correct' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({
        userId: 'user-1',
        email: 'user@example.com',
        isActive: true,
        password: 'hashed-pw',
        roles: ['customer'],
        isAdmin: false,
      } as any);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);
      (mockBcryptCompare as unknown as jest.Mock).mockResolvedValue(true);
      (mockJwt.sign as jest.Mock).mockReturnValue('jwt-token-123');

      await login(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'jwt-token-123',
          user: expect.objectContaining({ userId: 'user-1', email: 'user@example.com' }),
        })
      );
      // Ensure password is not in response
      const responseUser = (res.json as jest.Mock).mock.calls[0][0].user;
      expect(responseUser.password).toBeUndefined();
    });

    it('SUCCESS: email case-insensitive (uppercase input matches lowercase DB entry)', async () => {
      const req: any = { body: { email: 'USER@EXAMPLE.COM', password: 'correct' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({
        userId: 'user-1',
        email: 'user@example.com',
        isActive: true,
        password: 'hashed-pw',
        roles: ['customer'],
        isAdmin: false,
      } as any);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);
      (mockBcryptCompare as unknown as jest.Mock).mockResolvedValue(true);
      (mockJwt.sign as jest.Mock).mockReturnValue('jwt-token-123');

      await login(req, res);

      // Verify email was lowercased before DB lookup
      expect(mockUserDb.getUserByEmail).toHaveBeenCalledWith('user@example.com');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'jwt-token-123' }));
    });
  });

  // ─── C. Auth Controller - Register ───────────────────────────────

  describe('register controller', () => {
    beforeEach(() => {
      (mockBcryptHash as unknown as jest.Mock).mockResolvedValue('hashed-password');
      (mockJwt.sign as jest.Mock).mockReturnValue('mock-jwt-token');
      mockEmailService.sendTeamIntroductionEmail.mockResolvedValue(undefined as any);
    });

    it('FAIL: missing email → 400', async () => {
      const req: any = { body: { password: 'pass123' } };
      const res = createRes();

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Email and password are required' });
    });

    it('FAIL: missing password → 400', async () => {
      const req: any = { body: { email: 'user@example.com' } };
      const res = createRes();

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Email and password are required' });
    });

    it('FAIL: duplicate email → 400', async () => {
      const req: any = { body: { email: 'existing@example.com', password: 'pass123' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({ userId: 'user-1' } as any);

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'User already exists' });
    });

    it('SUCCESS: non-free user not on waitlist → registers without gate', async () => {
      const req: any = { body: { email: 'new@example.com', password: 'pass123', roles: ['customer'] } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);
      mockWaitlistDb.getByEmail.mockResolvedValue(undefined as any);
      mockUserDb.createUser.mockResolvedValue({
        userId: 'user-new',
        email: 'new@example.com',
        roles: ['customer'],
        isAdmin: false,
        isOAuthUser: false,
        createdAt: new Date().toISOString(),
      } as any);

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'mock-jwt-token' }));
    });

    it('SUCCESS: on waitlist but not invited → registers without gate', async () => {
      const req: any = { body: { email: 'waiting@example.com', password: 'pass123', roles: ['customer'] } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);
      mockWaitlistDb.getByEmail.mockResolvedValue({ email: 'waiting@example.com', status: 'pending' } as any);
      mockUserDb.createUser.mockResolvedValue({
        userId: 'user-new',
        email: 'waiting@example.com',
        roles: ['customer'],
        isAdmin: false,
        isOAuthUser: false,
        createdAt: new Date().toISOString(),
      } as any);

      await register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'mock-jwt-token' }));
    });

    it('SUCCESS: free user registers without waitlist check', async () => {
      const req: any = { body: { email: 'free@example.com', password: 'pass123', roles: ['free'] } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);
      mockUserDb.createUser.mockResolvedValue({
        userId: 'user-new',
        email: 'free@example.com',
        roles: ['free'],
        isAdmin: false,
        isOAuthUser: false,
        createdAt: new Date().toISOString(),
      } as any);

      await register(req, res);

      expect(mockWaitlistDb.getByEmail).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'mock-jwt-token' }));
    });

    it('SUCCESS: invited user registers successfully', async () => {
      const req: any = { body: { email: 'invited@example.com', password: 'pass123', roles: ['customer'] } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);
      mockWaitlistDb.getByEmail.mockResolvedValue({
        email: 'invited@example.com',
        status: 'invited',
        stripe_customer_id: 'cus_123',
      } as any);
      mockUserDb.createUser.mockResolvedValue({
        userId: 'user-invited',
        email: 'invited@example.com',
        roles: ['customer'],
        isAdmin: false,
        isOAuthUser: false,
        createdAt: new Date().toISOString(),
      } as any);

      await register(req, res);

      expect(mockWaitlistDb.getByEmail).toHaveBeenCalledWith('invited@example.com');
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'mock-jwt-token' }));
    });
  });

  // ─── D. Auth Controller - Password Reset ─────────────────────────

  describe('forgotPassword controller', () => {
    it('FAIL: missing email → 400', async () => {
      const req: any = { body: {} };
      const res = createRes();

      await forgotPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Email is required' });
    });

    it('SUCCESS: unknown email → 200 (does not reveal user existence)', async () => {
      const req: any = { body: { email: 'nobody@example.com' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);

      await forgotPassword(req, res);

      // Should NOT return an error status
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('If an account') })
      );
      // Should NOT send an email
      expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
    });

    it('SUCCESS: valid email → sends email, stores token', async () => {
      const req: any = { body: { email: 'user@example.com' } };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({
        userId: 'user-1',
        email: 'user@example.com',
      } as any);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);
      mockEmailService.sendEmail.mockResolvedValue(undefined as any);

      await forgotPassword(req, res);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', expect.objectContaining({
        resetPasswordToken: expect.any(String),
        resetPasswordExpires: expect.any(String),
      }));
      expect(mockEmailService.sendEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.stringContaining('Reset'),
        expect.any(String),
        expect.any(String),
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('If an account') })
      );
    });
  });

  describe('resetPassword controller', () => {
    it('FAIL: missing token → 400', async () => {
      const req: any = { body: { password: 'newpass123' } };
      const res = createRes();

      await resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Token and password are required' });
    });

    it('FAIL: missing password → 400', async () => {
      const req: any = { body: { token: 'some-token' } };
      const res = createRes();

      await resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Token and password are required' });
    });

    it('FAIL: short password (<6 chars) → 400', async () => {
      const req: any = { body: { token: 'some-token', password: '12345' } };
      const res = createRes();

      await resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Password must be at least 6 characters long' });
    });

    it('FAIL: invalid token (user not found) → 400', async () => {
      const req: any = { body: { token: 'bad-token', password: 'newpass123' } };
      const res = createRes();

      mockUserDb.getUserByResetToken.mockResolvedValue(undefined as any);

      await resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid or expired reset token' });
    });

    it('FAIL: expired token → 400', async () => {
      const req: any = { body: { token: 'expired-token', password: 'newpass123' } };
      const res = createRes();

      mockUserDb.getUserByResetToken.mockResolvedValue({
        userId: 'user-1',
        email: 'user@example.com',
        resetPasswordExpires: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      } as any);

      await resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Reset token has expired' });
    });

    it('SUCCESS: valid token → password updated, token cleared', async () => {
      const req: any = { body: { token: 'valid-token', password: 'newpass123' } };
      const res = createRes();

      mockUserDb.getUserByResetToken.mockResolvedValue({
        userId: 'user-1',
        email: 'user@example.com',
        resetPasswordExpires: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      } as any);
      (mockBcryptHash as unknown as jest.Mock).mockResolvedValue('new-hashed-password');
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await resetPassword(req, res);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', expect.objectContaining({
        password: 'new-hashed-password',
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
      }));
      expect(res.json).toHaveBeenCalledWith({ message: 'Password has been reset successfully' });
    });
  });
});
