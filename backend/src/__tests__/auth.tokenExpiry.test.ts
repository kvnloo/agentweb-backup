import { register, login } from '../controllers/auth';
import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

jest.mock('../services/db');
jest.mock('../services/waitlistDb');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

// ENG-1112: this suite is about JWT expiry, but `register()` fires
// `emailService.sendTeamIntroductionEmail(...)` un-awaited (controllers/auth.ts:239).
// With email un-mocked that reached `resendService` → the Resend SDK → a live POST to
// api.resend.com addressed to the fixture's `freeuser@example.com`. Because the send is
// fire-and-forget and swallowed, the suite stayed green while sending, and the request
// landed whenever the rate-limited queue got to it — often during a *later* suite in the
// same worker, which is how the leak got attributed to the wrong file.
// `__mocks__/resend.ts` is the floor that makes this unreachable everywhere; mocking the
// service here removes the stray send from the suite that actually causes it.
jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
    sendTeamIntroductionEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;
const mockBcryptHash = bcrypt.hash as jest.MockedFunction<typeof bcrypt.hash>;
const mockBcryptCompare = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

const createRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('Auth token expiration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockJwt.sign as jest.Mock).mockReturnValue('mock-jwt-token');
  });

  it('register should issue token with 90d expiration', async () => {
    const req: any = {
      body: {
        email: 'freeuser@example.com',
        password: 'ValidPass123!',
        roles: ['free']
      }
    };
    const res = createRes();

    mockUserDb.getUserByEmail.mockResolvedValue(undefined);
    (mockBcryptHash as unknown as jest.Mock).mockResolvedValue('hashed-password');
    mockUserDb.createUser.mockResolvedValue({
      userId: 'user-123',
      email: 'freeuser@example.com',
      roles: ['free'],
      isAdmin: false,
      isOAuthUser: false,
      createdAt: new Date().toISOString()
    } as any);

    await register(req, res);

    expect(mockJwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'freeuser@example.com',
        roles: ['free'],
        isAdmin: false
      }),
      expect.any(String),
      { expiresIn: '90d' }
    );
    expect(mockWaitlistDb.getByEmail).not.toHaveBeenCalled();
  });

  it('login should issue token with 90d expiration', async () => {
    const req: any = {
      body: {
        email: 'user@example.com',
        password: 'ValidPass123!'
      }
    };
    const res = createRes();

    mockUserDb.getUserByEmail.mockResolvedValue({
      userId: 'user-456',
      email: 'user@example.com',
      roles: ['customer'],
      isAdmin: false,
      password: 'hashed-password',
      isActive: true
    } as any);
    (mockUserDb as any).updateUser.mockResolvedValue(undefined);
    (mockBcryptCompare as unknown as jest.Mock).mockResolvedValue(true);

    await login(req, res);

    expect(mockJwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-456',
        email: 'user@example.com',
        roles: ['customer'],
        isAdmin: false
      }),
      expect.any(String),
      { expiresIn: '90d' }
    );
  });
});
