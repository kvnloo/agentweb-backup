import { register, login } from '../controllers/auth';
import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

jest.mock('../services/db');
jest.mock('../services/waitlistDb');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

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
