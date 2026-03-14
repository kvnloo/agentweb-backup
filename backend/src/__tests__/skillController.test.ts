import { Request, Response } from 'express';
import {
  createSkill,
  getAllSkills,
  getSkill,
  updateSkill,
  deleteSkill,
  syncSkill,
  getSyncStatus,
} from '../controllers/skillController';
import { skillService } from '../services/skillService';

// Mock the skillService
jest.mock('../services/skillService', () => ({
  skillService: {
    createSkill: jest.fn(),
    getAllSkills: jest.fn(),
    getSkill: jest.fn(),
    updateSkill: jest.fn(),
    deleteSkill: jest.fn(),
    syncSkill: jest.fn(),
    getSyncStatus: jest.fn(),
  },
}));

describe('SkillController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnThis();
    
    mockRequest = {
      body: {},
      params: {},
    };
    
    mockResponse = {
      json: mockJson,
      status: mockStatus,
    };
  });

  describe('POST /api/skills (createSkill)', () => {
    it('should create skill with valid data', async () => {
      const mockSkill = {
        skillId: 'skill-123',
        name: 'Test Skill',
        description: 'A test skill',
        toolNames: ['tool1', 'tool2'],
        systemPrompt: 'Test prompt',
        isPublished: false,
        createdAt: '2026-02-03T10:00:00.000Z',
        updatedAt: '2026-02-03T10:00:00.000Z',
      };

      mockRequest.body = {
        name: 'Test Skill',
        description: 'A test skill',
        toolNames: ['tool1', 'tool2'],
        systemPrompt: 'Test prompt',
      };

      (skillService.createSkill as jest.Mock).mockResolvedValue(mockSkill);

      await createSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.createSkill).toHaveBeenCalledWith(
        'Test Skill',
        'A test skill',
        ['tool1', 'tool2'],
        'Test prompt',
        undefined
      );
      expect(mockStatus).toHaveBeenCalledWith(201);
      expect(mockJson).toHaveBeenCalledWith(mockSkill);
    });

    it('should return 400 if name is missing', async () => {
      mockRequest.body = {
        description: 'A test skill',
      };

      await createSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Name and description are required',
      });
      expect(skillService.createSkill).not.toHaveBeenCalled();
    });

    it('should return 400 if description is missing', async () => {
      mockRequest.body = {
        name: 'Test Skill',
      };

      await createSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Name and description are required',
      });
      expect(skillService.createSkill).not.toHaveBeenCalled();
    });

    it('should handle optional toolNames and systemPrompt', async () => {
      const mockSkill = {
        skillId: 'skill-123',
        name: 'Test Skill',
        description: 'A test skill',
        toolNames: [],
        isPublished: false,
        createdAt: '2026-02-03T10:00:00.000Z',
        updatedAt: '2026-02-03T10:00:00.000Z',
      };

      mockRequest.body = {
        name: 'Test Skill',
        description: 'A test skill',
        // No toolNames or systemPrompt
      };

      (skillService.createSkill as jest.Mock).mockResolvedValue(mockSkill);

      await createSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.createSkill).toHaveBeenCalledWith(
        'Test Skill',
        'A test skill',
        [],
        undefined,
        undefined
      );
      expect(mockStatus).toHaveBeenCalledWith(201);
    });

    it('should return 500 on service error', async () => {
      mockRequest.body = {
        name: 'Test Skill',
        description: 'A test skill',
      };

      (skillService.createSkill as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await createSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Failed to create skill',
      });
    });
  });

  describe('GET /api/skills (getAllSkills)', () => {
    it('should return all skills', async () => {
      const mockSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc 1', toolNames: [], isPublished: true, createdAt: '', updatedAt: '' },
        { skillId: 'skill-2', name: 'Skill 2', description: 'Desc 2', toolNames: [], isPublished: false, createdAt: '', updatedAt: '' },
      ];

      (skillService.getAllSkills as jest.Mock).mockResolvedValue(mockSkills);

      await getAllSkills(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(mockSkills);
    });

    it('should return empty array when no skills exist', async () => {
      (skillService.getAllSkills as jest.Mock).mockResolvedValue([]);

      await getAllSkills(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith([]);
    });

    it('should handle errors gracefully', async () => {
      (skillService.getAllSkills as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await getAllSkills(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Failed to fetch skills',
      });
    });
  });

  describe('GET /api/skills/:skillId (getSkill)', () => {
    it('should return skill by ID', async () => {
      const mockSkill = {
        skillId: 'skill-123',
        name: 'Test Skill',
        description: 'A test skill',
        toolNames: ['tool1'],
        isPublished: true,
        createdAt: '',
        updatedAt: '',
      };

      mockRequest.params = { skillId: 'skill-123' };
      (skillService.getSkill as jest.Mock).mockResolvedValue(mockSkill);

      await getSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.getSkill).toHaveBeenCalledWith('skill-123');
      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(mockSkill);
    });

    it('should return 404 for non-existent skill', async () => {
      mockRequest.params = { skillId: 'non-existent' };
      (skillService.getSkill as jest.Mock).mockResolvedValue(null);

      await getSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Skill not found',
      });
    });

    it('should handle service error', async () => {
      mockRequest.params = { skillId: 'skill-123' };
      (skillService.getSkill as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await getSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Failed to fetch skill',
      });
    });
  });

  describe('PUT /api/skills/:skillId (updateSkill)', () => {
    it('should update existing skill', async () => {
      const existingSkill = {
        skillId: 'skill-123',
        name: 'Old Name',
        description: 'Old description',
        toolNames: ['old-tool'],
        isPublished: false,
        createdAt: '',
        updatedAt: '',
      };

      mockRequest.params = { skillId: 'skill-123' };
      mockRequest.body = {
        name: 'New Name',
        description: 'New description',
      };

      (skillService.getSkill as jest.Mock).mockResolvedValue(existingSkill);
      (skillService.updateSkill as jest.Mock).mockResolvedValue(undefined);

      await updateSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.updateSkill).toHaveBeenCalledWith({
        ...existingSkill,
        name: 'New Name',
        description: 'New description',
        skillId: 'skill-123',
      });
      expect(mockStatus).toHaveBeenCalledWith(200);
    });

    it('should return 404 for non-existent skill', async () => {
      mockRequest.params = { skillId: 'non-existent' };
      mockRequest.body = { name: 'New Name' };

      (skillService.getSkill as jest.Mock).mockResolvedValue(null);

      await updateSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Skill not found',
      });
      expect(skillService.updateSkill).not.toHaveBeenCalled();
    });

    it('should merge updates with existing skill', async () => {
      const existingSkill = {
        skillId: 'skill-123',
        name: 'Existing Name',
        description: 'Existing description',
        toolNames: ['tool1', 'tool2'],
        systemPrompt: 'Existing prompt',
        isPublished: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      mockRequest.params = { skillId: 'skill-123' };
      mockRequest.body = {
        isPublished: true,
      };

      (skillService.getSkill as jest.Mock).mockResolvedValue(existingSkill);
      (skillService.updateSkill as jest.Mock).mockResolvedValue(undefined);

      await updateSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.updateSkill).toHaveBeenCalledWith({
        ...existingSkill,
        isPublished: true,
        skillId: 'skill-123',
      });
    });

    it('should handle service error', async () => {
      mockRequest.params = { skillId: 'skill-123' };
      mockRequest.body = { name: 'New Name' };

      (skillService.getSkill as jest.Mock).mockResolvedValue({ skillId: 'skill-123' });
      (skillService.updateSkill as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await updateSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Failed to update skill',
      });
    });
  });

  describe('DELETE /api/skills/:skillId (deleteSkill)', () => {
    it('should delete existing skill', async () => {
      const existingSkill = {
        skillId: 'skill-123',
        name: 'Test Skill',
        description: 'Description',
        toolNames: [],
        isPublished: false,
        createdAt: '',
        updatedAt: '',
      };

      mockRequest.params = { skillId: 'skill-123' };

      (skillService.getSkill as jest.Mock).mockResolvedValue(existingSkill);
      (skillService.deleteSkill as jest.Mock).mockResolvedValue(undefined);

      await deleteSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.deleteSkill).toHaveBeenCalledWith('skill-123');
      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Skill deleted successfully',
      });
    });

    it('should return 404 for non-existent skill', async () => {
      mockRequest.params = { skillId: 'non-existent' };

      (skillService.getSkill as jest.Mock).mockResolvedValue(null);

      await deleteSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Skill not found',
      });
      expect(skillService.deleteSkill).not.toHaveBeenCalled();
    });

    it('should handle service error', async () => {
      mockRequest.params = { skillId: 'skill-123' };

      (skillService.getSkill as jest.Mock).mockResolvedValue({ skillId: 'skill-123' });
      (skillService.deleteSkill as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await deleteSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Failed to delete skill',
      });
    });
  });

  describe('POST /api/skills/sync (syncSkill)', () => {
    // Default NODE_ENV is undefined (treated as production), so allowed direction is prod-to-dev
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('should return 400 if skillId is missing', async () => {
      mockRequest.body = { direction: 'prod-to-dev' };

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'skillId and direction are required',
      });
      expect(skillService.syncSkill).not.toHaveBeenCalled();
    });

    it('should return 400 if direction is missing', async () => {
      mockRequest.body = { skillId: 'skill-123' };

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'skillId and direction are required',
      });
    });

    it('should return 400 for invalid direction', async () => {
      mockRequest.body = { skillId: 'skill-123', direction: 'invalid' };

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'direction must be "prod-to-dev" or "dev-to-prod"',
      });
    });

    it('should return 400 when direction does not match environment (prod env, dev-to-prod)', async () => {
      process.env.NODE_ENV = 'production';
      mockRequest.body = { skillId: 'skill-123', direction: 'dev-to-prod' };

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'In prod environment, only "prod-to-dev" sync is allowed',
      });
      expect(skillService.syncSkill).not.toHaveBeenCalled();
    });

    it('should return 400 when direction does not match environment (dev env, prod-to-dev)', async () => {
      process.env.NODE_ENV = 'development';
      mockRequest.body = { skillId: 'skill-123', direction: 'prod-to-dev' };

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'In dev environment, only "dev-to-prod" sync is allowed',
      });
      expect(skillService.syncSkill).not.toHaveBeenCalled();
    });

    it('should return 404 if skill not found in source', async () => {
      mockRequest.body = { skillId: 'non-existent', direction: 'prod-to-dev' };
      (skillService.syncSkill as jest.Mock).mockResolvedValue(null);

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Skill not found in source table',
      });
    });

    it('should sync skill prod-to-dev successfully in prod environment', async () => {
      process.env.NODE_ENV = 'production';
      const mockSkill = {
        skillId: 'skill-123',
        name: 'Test Skill',
        description: 'Desc',
        toolNames: ['tool1'],
        isPublished: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      mockRequest.body = { skillId: 'skill-123', direction: 'prod-to-dev' };
      (skillService.syncSkill as jest.Mock).mockResolvedValue(mockSkill);

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.syncSkill).toHaveBeenCalledWith('skill-123', 'prod-to-dev');
      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(mockSkill);
    });

    it('should sync skill dev-to-prod successfully in dev environment', async () => {
      process.env.NODE_ENV = 'development';
      const mockSkill = {
        skillId: 'skill-123',
        name: 'Test Skill',
        description: 'Desc',
        toolNames: [],
        isPublished: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      mockRequest.body = { skillId: 'skill-123', direction: 'dev-to-prod' };
      (skillService.syncSkill as jest.Mock).mockResolvedValue(mockSkill);

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(skillService.syncSkill).toHaveBeenCalledWith('skill-123', 'dev-to-prod');
      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(mockSkill);
    });

    it('should return 500 on service error', async () => {
      mockRequest.body = { skillId: 'skill-123', direction: 'prod-to-dev' };
      (skillService.syncSkill as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await syncSkill(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Failed to sync skill',
      });
    });
  });

  describe('GET /api/skills/sync-status (getSyncStatus)', () => {
    it('should return sync status with environment info', async () => {
      const syncStatusResult = {
        'skill-1': { inSync: true, existsInProd: true, existsInDev: true, changedFields: [] },
        'skill-2': { inSync: false, existsInProd: true, existsInDev: false, changedFields: [] },
      };
      (skillService.getSyncStatus as jest.Mock).mockResolvedValue(syncStatusResult);

      await getSyncStatus(mockRequest as Request, mockResponse as Response);

      expect(skillService.getSyncStatus).toHaveBeenCalled();
      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith({
        skills: syncStatusResult,
        environment: expect.stringMatching(/^(development|production)$/),
      });
    });

    it('should return 500 on service error', async () => {
      (skillService.getSyncStatus as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await getSyncStatus(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Failed to get sync status',
      });
    });
  });
});
