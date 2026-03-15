import { userDb } from '../services/db';
import {
  getMaxConcurrentSessions,
} from '../services/subscriptionService';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/customerPortalPages', () => ({
  CUSTOMER_PORTAL_PAGES: [],
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(() => []),
  },
}));

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;

describe('getMaxConcurrentSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 1 for Basic subscription tier', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'u1',
      subscriptionType: 'Basic',
    } as any);

    const limit = await getMaxConcurrentSessions('u1');
    expect(limit).toBe(1);
  });

  it('returns 3 for Pro subscription tier', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'u2',
      subscriptionType: 'Pro',
    } as any);

    const limit = await getMaxConcurrentSessions('u2');
    expect(limit).toBe(3);
  });

  it('returns 5 for Super Premium subscription tier', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'u3',
      subscriptionType: 'Super Premium',
    } as any);

    const limit = await getMaxConcurrentSessions('u3');
    expect(limit).toBe(5);
  });

  it('returns default (1) for unknown/unrecognized subscription tier', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'u4',
      subscriptionType: 'SomeFutureTier',
    } as any);

    const limit = await getMaxConcurrentSessions('u4');
    expect(limit).toBe(1);
  });

  it('returns default (1) when user has no subscriptionType set', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'u5',
    } as any);

    const limit = await getMaxConcurrentSessions('u5');
    expect(limit).toBe(1);
  });

  it('returns default (1) when getUserById throws an error', async () => {
    mockedUserDb.getUserById.mockRejectedValueOnce(new Error('DB error'));

    const limit = await getMaxConcurrentSessions('u6');
    expect(limit).toBe(1);
  });
});
