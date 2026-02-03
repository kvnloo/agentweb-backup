import { Skill } from '../services/skillService';

describe('SkillService', () => {
  let skillService: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockScan: jest.Mock;
  let mockDelete: jest.Mock;
  let mockBatchGet: jest.Mock;
  let mockCreateSet: jest.Mock;
  let mockPromise: jest.Mock;

  const mockTimestamp = '2026-02-03T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));
    mockScan = jest.fn(() => ({ promise: mockPromise }));
    mockDelete = jest.fn(() => ({ promise: mockPromise }));
    mockBatchGet = jest.fn(() => ({ promise: mockPromise }));
    mockCreateSet = jest.fn((arr) => ({ values: arr }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          scan: mockScan,
          delete: mockDelete,
          batchGet: mockBatchGet,
          createSet: mockCreateSet,
        })),
      },
    }));

    jest.doMock('uuid', () => ({
      v4: jest.fn(() => 'test-skill-id-123'),
    }));

    // Import the module after mocking
    const module = require('../services/skillService');
    skillService = module.skillService;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(mockTimestamp);
    
    // Reset defaults
    mockPromise.mockResolvedValue({});
    mockPut.mockReturnValue({ promise: mockPromise });
    mockGet.mockReturnValue({ promise: mockPromise });
    mockScan.mockReturnValue({ promise: mockPromise });
    mockDelete.mockReturnValue({ promise: mockPromise });
    mockBatchGet.mockReturnValue({ promise: mockPromise });
    mockCreateSet.mockImplementation((arr) => ({ values: arr }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createSkill', () => {
    it('should create a skill with required fields', async () => {
      mockPromise.mockResolvedValueOnce({});

      const result = await skillService.createSkill(
        'Test Skill',
        'A test skill description',
        ['tool1', 'tool2'],
        'Custom system prompt'
      );

      expect(result).toEqual({
        skillId: 'test-skill-id-123',
        name: 'Test Skill',
        description: 'A test skill description',
        toolNames: ['tool1', 'tool2'],
        systemPrompt: 'Custom system prompt',
        isPublished: false,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      });
      expect(mockPut).toHaveBeenCalled();
    });

    it('should generate a unique skillId', async () => {
      const result = await skillService.createSkill('Test', 'Desc', [], undefined);
      expect(result.skillId).toBe('test-skill-id-123');
    });

    it('should handle DynamoDB Set conversion for toolNames', async () => {
      await skillService.createSkill('Test', 'Desc', ['tool1', 'tool2'], undefined);
      expect(mockCreateSet).toHaveBeenCalledWith(['tool1', 'tool2']);
    });
  });

  describe('getSkill', () => {
    it('should return skill by skillId', async () => {
      const mockSkill = {
        skillId: 'skill-1',
        name: 'Test Skill',
        description: 'Description',
        toolNames: ['tool1'],
        isPublished: true,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      };
      mockPromise.mockResolvedValueOnce({ Item: mockSkill });

      const result = await skillService.getSkill('skill-1');

      expect(result).toEqual(mockSkill);
      expect(mockGet).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-Skills'),
        Key: { skillId: 'skill-1' },
      });
    });

    it('should normalize DynamoDB Set to array for toolNames', async () => {
      const mockSkillWithSet = {
        skillId: 'skill-1',
        name: 'Test Skill',
        description: 'Description',
        toolNames: { values: ['tool1', 'tool2'] },
        isPublished: true,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      };
      mockPromise.mockResolvedValueOnce({ Item: mockSkillWithSet });

      const result = await skillService.getSkill('skill-1');
      expect(result?.toolNames).toEqual(['tool1', 'tool2']);
    });

    it('should return undefined for non-existent skill', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });
      const result = await skillService.getSkill('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllSkills', () => {
    it('should return all skills', async () => {
      const mockSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc 1', toolNames: ['tool1'], isPublished: true, createdAt: mockTimestamp, updatedAt: mockTimestamp },
      ];
      mockPromise.mockResolvedValueOnce({ Items: mockSkills });

      const result = await skillService.getAllSkills();
      expect(result).toHaveLength(1);
      expect(mockScan).toHaveBeenCalled();
    });

    it('should return empty array if table not found', async () => {
      const error = { code: 'ResourceNotFoundException' };
      mockPromise.mockRejectedValueOnce(error);

      const result = await skillService.getAllSkills();
      expect(result).toEqual([]);
    });

    it('should throw error for other errors', async () => {
      const error = new Error('DynamoDB error');
      mockPromise.mockRejectedValueOnce(error);

      await expect(skillService.getAllSkills()).rejects.toThrow('DynamoDB error');
    });
  });

  describe('getPublishedSkills', () => {
    it('should only return skills with isPublished=true', async () => {
      const mockPublishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true, createdAt: mockTimestamp, updatedAt: mockTimestamp },
      ];
      mockPromise.mockResolvedValueOnce({ Items: mockPublishedSkills });

      const result = await skillService.getPublishedSkills();
      expect(result).toHaveLength(1);
      expect(result[0].isPublished).toBe(true);
    });
  });

  describe('getSkillsByIds', () => {
    it('should batch get multiple skills by ID', async () => {
      const mockSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true, createdAt: mockTimestamp, updatedAt: mockTimestamp },
      ];
      mockPromise.mockResolvedValueOnce({
        Responses: { 
          'AW-Skills': mockSkills,
          'Dev-AW-Skills': mockSkills 
        },
      });

      const result = await skillService.getSkillsByIds(['skill-1']);
      expect(result).toHaveLength(1);
      expect(mockBatchGet).toHaveBeenCalled();
    });

    it('should return empty array for empty input', async () => {
      const result = await skillService.getSkillsByIds([]);
      expect(result).toEqual([]);
      expect(mockBatchGet).not.toHaveBeenCalled();
    });
  });

  describe('updateSkill', () => {
    it('should update skill fields', async () => {
      const skillToUpdate = {
        skillId: 'skill-1',
        name: 'Updated Skill',
        description: 'Updated description',
        toolNames: ['tool1', 'tool2'],
        isPublished: true,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      };

      await skillService.updateSkill(skillToUpdate);
      expect(mockPut).toHaveBeenCalled();
    });

    it('should convert toolNames array to DynamoDB Set', async () => {
      const skillToUpdate = {
        skillId: 'skill-1',
        name: 'Test',
        description: 'Desc',
        toolNames: ['tool1', 'tool2'],
        isPublished: false,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      };

      await skillService.updateSkill(skillToUpdate);
      expect(mockCreateSet).toHaveBeenCalledWith(['tool1', 'tool2']);
    });
  });

  describe('deleteSkill', () => {
    it('should delete skill by skillId', async () => {
      await skillService.deleteSkill('skill-1');
      expect(mockDelete).toHaveBeenCalled();
    });
  });
});
