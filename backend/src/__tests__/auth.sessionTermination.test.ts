import { changePassword } from '../controllers/auth';
import { getUserFromToken } from '../middleware/auth';
import { userDb } from '../services/db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

jest.mock('../services/db');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');
jest.mock('../services/sessionSockets', () => ({
  disconnectStaleUserSockets: jest.fn().mockResolvedValue(0),
}));

import { disconnectStaleUserSockets } from '../services/sessionSockets';

const mockDisconnect = disconnectStaleUserSockets as jest.Mock;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockBcryptHash = bcrypt.hash as jest.MockedFunction<typeof bcrypt.hash>;
const mockBcryptCompare = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

const createRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('Session termination on password change', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  // ─── changePassword controller ──────────────────────────────────────

  describe('changePassword controller', () => {
    it('FAIL: unauthenticated request → 401', async () => {
      const req: any = { body: { currentPassword: 'old', newPassword: 'newpass123' } };
      const res = createRes();

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
    });

    it('FAIL: delegated session → 403', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        delegateInfo: { isDelegated: true, adminUserId: 'admin-1', adminEmail: 'a@e.com' },
        body: { currentPassword: 'old', newPassword: 'newpass123' },
      };
      const res = createRes();

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
    });

    it('FAIL: missing fields → 400', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'old' },
      };
      const res = createRes();

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Current password and new password are required' });
    });

    it('FAIL: short new password (<6) → 400', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'old', newPassword: '123' },
      };
      const res = createRes();

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'New password must be at least 6 characters long' });
    });

    it('FAIL: user not found → 404', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'old', newPassword: 'newpass123' },
      };
      const res = createRes();
      mockUserDb.getUserById.mockResolvedValue(undefined as any);

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('FAIL: OAuth-only account → 400', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'old', newPassword: 'newpass123' },
      };
      const res = createRes();
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', password: 'placeholder', isOAuthUser: true,
      } as any);

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
    });

    it('FAIL: wrong current password → 401', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'wrong', newPassword: 'newpass123' },
      };
      const res = createRes();
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', password: 'hashed', isOAuthUser: false,
      } as any);
      (mockBcryptCompare as unknown as jest.Mock).mockResolvedValue(false);

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Current password is incorrect', code: 'invalid_current_password' });
      expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
    });

    it('FAIL: new password equals current → 400', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'samepass', newPassword: 'samepass' },
      };
      const res = createRes();
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', password: 'hashed', isOAuthUser: false,
      } as any);
      (mockBcryptCompare as unknown as jest.Mock).mockResolvedValue(true);

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'New password must be different from the current password' });
      expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
    });

    it('SUCCESS: valid change → password updated, sessions terminated, fresh token issued', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'oldpass', newPassword: 'newpass123' },
      };
      const res = createRes();
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', password: 'hashed', isOAuthUser: false, roles: ['customer'], isAdmin: false,
      } as any);
      (mockBcryptCompare as unknown as jest.Mock).mockResolvedValue(true);
      (mockBcryptHash as unknown as jest.Mock).mockResolvedValue('new-hashed');
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);
      (mockUserDb as any).incrementSessionVersion.mockResolvedValue(5);
      (mockJwt.sign as jest.Mock).mockReturnValue('fresh-token');

      await changePassword(req, res);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', { password: 'new-hashed' });
      // All other sessions terminated by bumping the session version
      expect(mockUserDb.incrementSessionVersion).toHaveBeenCalledWith('user-1');
      // ...and live sockets on the old session are swept with the new version
      expect(mockDisconnect).toHaveBeenCalledWith('user-1', 5);
      // Fresh token must carry the new session version so the current device stays signed in
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', sv: 5 }),
        expect.any(String),
        { expiresIn: '90d' }
      );
      expect(res.json).toHaveBeenCalledWith({ message: 'Password changed successfully', token: 'fresh-token' });
    });

    it('FAIL: unexpected DB error → 500', async () => {
      const req: any = {
        user: { userId: 'user-1', email: 'u@e.com', isAdmin: false },
        body: { currentPassword: 'oldpass', newPassword: 'newpass123' },
      };
      const res = createRes();
      mockUserDb.getUserById.mockRejectedValue(new Error('dynamo down'));

      await changePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Error changing password' });
    });
  });

  // ─── getUserFromToken session-version enforcement ───────────────────

  describe('getUserFromToken sessionVersion enforcement', () => {
    const reqWithToken = () => ({ headers: { authorization: 'Bearer some-token' } } as any);

    it('rejects a token whose sv is behind the user sessionVersion (other device after password change)', async () => {
      (mockJwt.verify as jest.Mock).mockReturnValue({ userId: 'user-1', email: 'u@e.com', isAdmin: false, sv: 0 });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', isAdmin: false, sessionVersion: 1,
      } as any);

      const result = await getUserFromToken(reqWithToken());

      expect(result.user).toBeNull();
    });

    it('accepts a token whose sv matches the user sessionVersion', async () => {
      (mockJwt.verify as jest.Mock).mockReturnValue({ userId: 'user-1', email: 'u@e.com', isAdmin: false, sv: 2 });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', isAdmin: false, sessionVersion: 2, roles: ['customer'],
      } as any);

      const result = await getUserFromToken(reqWithToken());

      expect(result.user).not.toBeNull();
      expect(result.user?.userId).toBe('user-1');
    });

    it('accepts a token whose sv is AHEAD of the stored value (eventually-consistent GSI lag after a fresh password change)', async () => {
      // Regression: getUserById reads the eventually-consistent UserIdIndex GSI.
      // Just after incrementSessionVersion bumps the base table 1→2 and the new
      // token is signed with sv:2, the GSI replica may still return sessionVersion:1.
      // The current device's brand-new token must NOT be rejected in that window.
      (mockJwt.verify as jest.Mock).mockReturnValue({ userId: 'user-1', email: 'u@e.com', isAdmin: false, sv: 2 });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', isAdmin: false, sessionVersion: 1, roles: ['customer'],
      } as any);

      const result = await getUserFromToken(reqWithToken());

      expect(result.user).not.toBeNull();
      expect(result.user?.userId).toBe('user-1');
    });

    it('accepts legacy tokens with no sv against a user with no sessionVersion (both default 0)', async () => {
      (mockJwt.verify as jest.Mock).mockReturnValue({ userId: 'user-1', email: 'u@e.com', isAdmin: false });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', isAdmin: false, roles: ['customer'],
      } as any);

      const result = await getUserFromToken(reqWithToken());

      expect(result.user).not.toBeNull();
    });

    it('rejects a legacy token (no sv) once the user sessionVersion has been bumped', async () => {
      (mockJwt.verify as jest.Mock).mockReturnValue({ userId: 'user-1', email: 'u@e.com', isAdmin: false });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1', email: 'u@e.com', isAdmin: false, sessionVersion: 3,
      } as any);

      const result = await getUserFromToken(reqWithToken());

      expect(result.user).toBeNull();
    });

    it('does NOT apply sessionVersion check to delegate tokens', async () => {
      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'admin-1',
        delegateAccess: { adminUserId: 'admin-1', adminEmail: 'a@e.com', targetUserId: 'user-1', targetEmail: 'u@e.com' },
      });
      mockUserDb.getUserById.mockImplementation(async (id: string) => {
        if (id === 'admin-1') return { userId: 'admin-1', email: 'a@e.com', isAdmin: true } as any;
        return { userId: 'user-1', email: 'u@e.com', isAdmin: false, roles: ['customer'], sessionVersion: 9 } as any;
      });

      const result = await getUserFromToken(reqWithToken());

      // Delegate session resolves to the target user regardless of sessionVersion
      expect(result.user?.userId).toBe('user-1');
    });
  });
});
