import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDocClient = {
    scan: jest.fn(),
    query: jest.fn(),
    update: jest.fn(),
  };
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    S3: jest.fn(() => ({})),
    SecretsManager: jest.fn(() => ({})),
    config: { update: jest.fn() },
  };
});

// Prevent db.ts from importing other services that need full AWS setup
jest.mock('../services/db', () => {
  const actual = jest.requireActual('../services/db');
  return actual;
});

import { userDb } from '../services/db';

describe('userDb - deleted_ tombstone filtering', () => {
  let mockDocClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDocClient = new DocumentClient();
  });

  // ── getAllUsers ──────────────────────────────────────────────────────────────

  describe('getAllUsers()', () => {
    it('should exclude tombstoned records from the result', async () => {
      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { userId: 'user-active-1', email: 'active@example.com', taskCount: 0, workflowCount: 0 },
            { userId: 'deleted_user-old-2', email: 'old@example.com', taskCount: 0, workflowCount: 0 },
          ],
        }),
      });
      // getAllUsers calls query per user for counts — stub those too
      mockDocClient.query = jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Count: 0, Items: [] }),
      });

      const users = await userDb.getAllUsers();

      expect(users).toHaveLength(1);
      expect(users[0].userId).toBe('user-active-1');
    });

    it('should return empty array when all records are tombstones', async () => {
      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { userId: 'deleted_abc', email: 'gone@example.com' },
            { userId: 'deleted_xyz', email: 'also-gone@example.com' },
          ],
        }),
      });
      mockDocClient.query = jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Count: 0, Items: [] }),
      });

      const users = await userDb.getAllUsers();
      expect(users).toHaveLength(0);
    });

    it('should return all users when none are tombstoned', async () => {
      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { userId: 'user-a', email: 'a@example.com' },
            { userId: 'user-b', email: 'b@example.com' },
          ],
        }),
      });
      mockDocClient.query = jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Count: 0, Items: [] }),
      });

      const users = await userDb.getAllUsers();
      expect(users).toHaveLength(2);
    });
  });

  // ── getUserByEmail ────────────────────────────────────────────────────────────

  describe('getUserByEmail()', () => {
    it('should return undefined when the email belongs to a tombstoned record', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ userId: 'deleted_old-user', email: 'matt@okareo.com' }],
        }),
      });

      const result = await userDb.getUserByEmail('matt@okareo.com');
      expect(result).toBeUndefined();
    });

    it('should return the user when the record is not tombstoned', async () => {
      const activeUser = { userId: 'user-123', email: 'active@example.com' };
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [activeUser] }),
      });

      const result = await userDb.getUserByEmail('active@example.com');
      expect(result).toEqual(activeUser);
    });

    it('should return undefined when no record exists', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await userDb.getUserByEmail('nobody@example.com');
      expect(result).toBeUndefined();
    });
  });

  // ── getUserById ────────────────────────────────────────────────────────────

  describe('getUserById()', () => {
    it('should return undefined when userId is a tombstone (deleted_ prefix)', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ userId: 'deleted_user-123', email: 'gone@example.com' }],
        }),
      });

      const result = await userDb.getUserById('deleted_user-123');
      expect(result).toBeUndefined();
    });

    it('should return the user when userId is not tombstoned', async () => {
      const activeUser = { userId: 'user-123', email: 'active@example.com' };
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [activeUser] }),
      });

      const result = await userDb.getUserById('user-123');
      expect(result).toEqual(activeUser);
    });

    it('should return undefined when no record exists', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await userDb.getUserById('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  // ── updateUser ────────────────────────────────────────────────────────────

  describe('updateUser()', () => {
    it('skips undefined fields by default for legacy partial updates', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ userId: 'user-123', email: 'active@example.com', oldField: 'keep' }],
        }),
      });
      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'user-123' } }),
      });

      await userDb.updateUser('user-123', {
        companyName: 'Acme',
        icpResult: undefined,
      } as any);

      expect(mockDocClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: 'SET #companyName = :companyName',
          ExpressionAttributeNames: { '#companyName': 'companyName' },
          ExpressionAttributeValues: { ':companyName': 'Acme' },
        }),
      );
    });

    it('removes undefined fields when requested by state-machine reset patches', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ userId: 'user-123', email: 'active@example.com' }],
        }),
      });
      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'user-123' } }),
      });

      await userDb.updateUser(
        'user-123',
        {
          icpStatus: 'running',
          icpStartedAt: '2026-06-23T03:49:07.184Z',
          icpCompletedAt: undefined,
          icpResult: undefined,
        } as any,
        { removeUndefined: true },
      );

      expect(mockDocClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression:
            'SET #icpStatus = :icpStatus, #icpStartedAt = :icpStartedAt REMOVE #icpCompletedAt, #icpResult',
          ExpressionAttributeNames: {
            '#icpStatus': 'icpStatus',
            '#icpStartedAt': 'icpStartedAt',
            '#icpCompletedAt': 'icpCompletedAt',
            '#icpResult': 'icpResult',
          },
          ExpressionAttributeValues: {
            ':icpStatus': 'running',
            ':icpStartedAt': '2026-06-23T03:49:07.184Z',
          },
        }),
      );
    });
  });
});
