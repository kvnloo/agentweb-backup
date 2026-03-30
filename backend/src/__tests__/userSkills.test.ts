import { SkillVisibility } from '../services/skillService';

describe('User Skills - SkillService review workflow', () => {
  let skillService: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockQuery: jest.Mock;
  let mockDelete: jest.Mock;
  let mockCreateSet: jest.Mock;
  let mockPromise: jest.Mock;

  const mockTimestamp = '2026-03-24T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));
    mockQuery = jest.fn(() => ({ promise: mockPromise }));
    mockDelete = jest.fn(() => ({ promise: mockPromise }));
    mockCreateSet = jest.fn((arr) => ({ values: arr }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          query: mockQuery,
          scan: jest.fn(() => ({ promise: mockPromise })),
          delete: mockDelete,
          batchGet: jest.fn(() => ({ promise: mockPromise })),
          createSet: mockCreateSet,
        })),
      },
    }));

    jest.doMock('uuid', () => ({
      v4: jest.fn(() => 'test-skill-id-456'),
    }));

    const module = require('../services/skillService');
    skillService = module.skillService;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(mockTimestamp);
    mockPromise.mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getSkillsByOwner', () => {
    it('should query OwnerIndex GSI', async () => {
      const mockSkills = [
        { skillId: 's1', name: 'My Skill', ownerId: 'user1', visibility: 'private', toolNames: ['t1'] },
      ];
      mockPromise.mockResolvedValueOnce({ Items: mockSkills });

      const result = await skillService.getSkillsByOwner('user1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('My Skill');
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: 'OwnerIndex',
        KeyConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: { ':ownerId': 'user1' },
      }));
    });

    it('should return empty array when user has no skills', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [] });
      const result = await skillService.getSkillsByOwner('user-no-skills');
      expect(result).toEqual([]);
    });
  });

  describe('getSkillsByVisibility', () => {
    it('should query VisibilityIndex GSI', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [
        { skillId: 's1', visibility: 'pending_review', toolNames: ['t1'] },
      ]});

      const result = await skillService.getSkillsByVisibility('pending_review' as SkillVisibility);
      expect(result).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: 'VisibilityIndex',
        KeyConditionExpression: 'visibility = :visibility',
        ExpressionAttributeValues: { ':visibility': 'pending_review' },
      }));
    });
  });

  describe('submitForReview', () => {
    it('should change visibility to pending_review for owned private skill', async () => {
      const skill = {
        skillId: 's1', name: 'My Skill', ownerId: 'user1', visibility: 'private',
        toolNames: ['t1'], description: 'desc', isPublished: false, createdAt: mockTimestamp, updatedAt: mockTimestamp,
      };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: skill }) });
      mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      const result = await skillService.submitForReview('s1', 'user1');
      expect(result.visibility).toBe('pending_review');
    });

    it('should reject if user does not own the skill', async () => {
      const skill = { skillId: 's1', ownerId: 'other-user', visibility: 'private', toolNames: [] };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: skill }) });

      await expect(skillService.submitForReview('s1', 'user1')).rejects.toThrow('Not authorized');
    });

    it('should reject if skill is not private', async () => {
      const skill = { skillId: 's1', ownerId: 'user1', visibility: 'public', toolNames: [] };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: skill }) });

      await expect(skillService.submitForReview('s1', 'user1')).rejects.toThrow('Only private skills can be submitted for review');
    });

    it('should reject if skill not found', async () => {
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: null }) });

      await expect(skillService.submitForReview('nonexistent', 'user1')).rejects.toThrow('Skill not found');
    });
  });

  describe('approveSkill', () => {
    it('should set visibility to public and isPublished to true', async () => {
      const skill = {
        skillId: 's1', name: 'Pending Skill', visibility: 'pending_review', isPublished: false,
        toolNames: ['t1'], description: 'desc', createdAt: mockTimestamp, updatedAt: mockTimestamp,
      };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: skill }) });
      mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      const result = await skillService.approveSkill('s1');
      expect(result.visibility).toBe('public');
      expect(result.isPublished).toBe(true);
    });

    it('should reject if skill is not pending review', async () => {
      const skill = { skillId: 's1', visibility: 'private', toolNames: [] };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: skill }) });

      await expect(skillService.approveSkill('s1')).rejects.toThrow('Skill is not pending review');
    });
  });

  describe('rejectSkill', () => {
    it('should revert to private and set feedback', async () => {
      const skill = {
        skillId: 's1', name: 'Pending Skill', visibility: 'pending_review',
        toolNames: ['t1'], description: 'desc', isPublished: false, createdAt: mockTimestamp, updatedAt: mockTimestamp,
      };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: skill }) });
      mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      const result = await skillService.rejectSkill('s1', 'Needs better description');
      expect(result.visibility).toBe('private');
      expect(result.reviewFeedback).toBe('Needs better description');
    });

    it('should reject if skill is not pending review', async () => {
      const skill = { skillId: 's1', visibility: 'public', toolNames: [] };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: skill }) });

      await expect(skillService.rejectSkill('s1', 'feedback')).rejects.toThrow('Skill is not pending review');
    });
  });
});
