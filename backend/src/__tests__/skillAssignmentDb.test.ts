import { SkillAssignment } from '../services/skillAssignmentDb';

describe('SkillAssignmentDb', () => {
  let skillAssignmentDb: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockQuery: jest.Mock;
  let mockUpdate: jest.Mock;
  let mockDelete: jest.Mock;
  let mockPromise: jest.Mock;

  const mockTimestamp = '2026-03-11T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));
    mockQuery = jest.fn(() => ({ promise: mockPromise }));
    mockUpdate = jest.fn(() => ({ promise: mockPromise }));
    mockDelete = jest.fn(() => ({ promise: mockPromise }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          query: mockQuery,
          update: mockUpdate,
          delete: mockDelete,
        })),
      },
    }));

    jest.doMock('uuid', () => ({
      v4: jest.fn(() => 'test-assignment-id-123'),
    }));

    const module = require('../services/skillAssignmentDb');
    skillAssignmentDb = module.skillAssignmentDb;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(mockTimestamp);

    mockPromise.mockResolvedValue({});
    mockPut.mockReturnValue({ promise: mockPromise });
    mockGet.mockReturnValue({ promise: mockPromise });
    mockQuery.mockReturnValue({ promise: mockPromise });
    mockUpdate.mockReturnValue({ promise: mockPromise });
    mockDelete.mockReturnValue({ promise: mockPromise });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===== FAIL tests (should fail before implementation) =====

  describe('createAssignment', () => {
    it('FAIL: should reject assignment with missing skillId', async () => {
      await expect(
        skillAssignmentDb.createAssignment({
          skillId: '',
          userId: 'user-1',
          status: 'active',
        })
      ).rejects.toThrow('skillId is required');
    });

    it('FAIL: should reject assignment with missing userId', async () => {
      await expect(
        skillAssignmentDb.createAssignment({
          skillId: 'skill-1',
          userId: '',
          status: 'active',
        })
      ).rejects.toThrow('userId is required');
    });

    it('FAIL: should reject assignment with invalid status', async () => {
      await expect(
        skillAssignmentDb.createAssignment({
          skillId: 'skill-1',
          userId: 'user-1',
          status: 'banana' as any,
        })
      ).rejects.toThrow('Invalid status');
    });

    it('SUCCESS: should create assignment with required fields', async () => {
      mockPromise.mockResolvedValueOnce({});

      const result = await skillAssignmentDb.createAssignment({
        skillId: 'skill-1',
        userId: 'user-1',
        status: 'active',
      });

      expect(result).toEqual(expect.objectContaining({
        assignmentId: 'test-assignment-id-123',
        skillId: 'skill-1',
        userId: 'user-1',
        status: 'active',
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      }));
      expect(mockPut).toHaveBeenCalled();
    });

    it('SUCCESS: should create assignment with schedule', async () => {
      mockPromise.mockResolvedValueOnce({});

      const schedule = {
        frequency: 'daily' as const,
        preferredTime: '09:00',
        deliveryChannels: ['slack', 'email'],
      };

      const result = await skillAssignmentDb.createAssignment({
        skillId: 'skill-1',
        userId: 'user-1',
        status: 'active',
        schedule,
        nextRunTime: '2026-03-12T09:00:00.000Z',
      });

      expect(result.schedule).toEqual(schedule);
      expect(result.nextRunTime).toBe('2026-03-12T09:00:00.000Z');
    });
  });

  describe('getAssignment', () => {
    it('FAIL: should return null for non-existent assignment', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });
      const result = await skillAssignmentDb.getAssignment('non-existent');
      expect(result).toBeNull();
    });

    it('SUCCESS: should return assignment by ID', async () => {
      const mockAssignment = {
        assignmentId: 'assign-1',
        skillId: 'skill-1',
        userId: 'user-1',
        status: 'active',
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      };
      mockPromise.mockResolvedValueOnce({ Item: mockAssignment });

      const result = await skillAssignmentDb.getAssignment('assign-1');
      expect(result).toEqual(mockAssignment);
      expect(mockGet).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-SkillAssignments'),
        Key: { assignmentId: 'assign-1' },
      });
    });
  });

  describe('getAssignmentsByUser', () => {
    it('SUCCESS: should return all assignments for a user', async () => {
      const mockAssignments = [
        { assignmentId: 'a1', skillId: 's1', userId: 'user-1', status: 'active' },
        { assignmentId: 'a2', skillId: 's2', userId: 'user-1', status: 'paused' },
      ];
      mockPromise.mockResolvedValueOnce({ Items: mockAssignments });

      const result = await skillAssignmentDb.getAssignmentsByUser('user-1');
      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: 'UserIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': 'user-1' },
      }));
    });

    it('SUCCESS: should return empty array when user has no assignments', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [] });
      const result = await skillAssignmentDb.getAssignmentsByUser('no-assignments-user');
      expect(result).toEqual([]);
    });
  });

  describe('getAssignmentsBySkill', () => {
    it('SUCCESS: should return all assignments for a skill', async () => {
      const mockAssignments = [
        { assignmentId: 'a1', skillId: 'skill-1', userId: 'user-1', status: 'active' },
      ];
      mockPromise.mockResolvedValueOnce({ Items: mockAssignments });

      const result = await skillAssignmentDb.getAssignmentsBySkill('skill-1');
      expect(result).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: 'SkillIndex',
        KeyConditionExpression: 'skillId = :skillId',
        ExpressionAttributeValues: { ':skillId': 'skill-1' },
      }));
    });
  });

  describe('getAssignmentsReadyToRun', () => {
    it('FAIL: should only return active assignments with nextRunTime <= now', async () => {
      const now = mockTimestamp;
      const mockAssignments = [
        {
          assignmentId: 'a1',
          skillId: 's1',
          userId: 'user-1',
          status: 'active',
          nextRunTime: '2026-03-11T09:00:00.000Z', // before now
        },
      ];
      mockPromise.mockResolvedValueOnce({ Items: mockAssignments });

      const result = await skillAssignmentDb.getAssignmentsReadyToRun();
      expect(result).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: 'RunnerIndex',
        KeyConditionExpression: '#status = :status AND nextRunTime <= :now',
        ExpressionAttributeNames: { '#status': 'status' },
      }));
    });

    it('SUCCESS: should return empty array when no assignments are ready', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [] });
      const result = await skillAssignmentDb.getAssignmentsReadyToRun();
      expect(result).toEqual([]);
    });
  });

  describe('updateAssignment', () => {
    it('FAIL: should reject update with invalid assignmentId', async () => {
      await expect(
        skillAssignmentDb.updateAssignment('', { status: 'paused' })
      ).rejects.toThrow('assignmentId is required');
    });

    it('FAIL: should reject update with invalid status', async () => {
      await expect(
        skillAssignmentDb.updateAssignment('a1', { status: 'banana' as any })
      ).rejects.toThrow('Invalid status');
    });

    it('SUCCESS: should update assignment fields', async () => {
      mockPromise.mockResolvedValueOnce({
        Attributes: {
          assignmentId: 'a1',
          status: 'paused',
          updatedAt: mockTimestamp,
        },
      });

      const result = await skillAssignmentDb.updateAssignment('a1', {
        status: 'paused',
      });

      expect(mockUpdate).toHaveBeenCalled();
      expect(result.status).toBe('paused');
    });
  });

  describe('deleteAssignment', () => {
    it('SUCCESS: should delete assignment by ID', async () => {
      mockPromise.mockResolvedValueOnce({});
      await skillAssignmentDb.deleteAssignment('a1');
      expect(mockDelete).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-SkillAssignments'),
        Key: { assignmentId: 'a1' },
      });
    });
  });
});
