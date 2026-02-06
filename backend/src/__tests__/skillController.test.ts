import { Request, Response } from 'express';
import {
  createSkill,
  getAllSkills,
  getSkill,
  updateSkill,
  deleteSkill,
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
});
