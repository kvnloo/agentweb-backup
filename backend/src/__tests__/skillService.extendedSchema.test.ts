import { Skill } from '../services/skillService';

describe('SkillService - Extended Schema', () => {
  let skillService: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockScan: jest.Mock;
  let mockPromise: jest.Mock;
  let mockCreateSet: jest.Mock;

  const mockTimestamp = '2026-03-11T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));
    mockScan = jest.fn(() => ({ promise: mockPromise }));
    mockCreateSet = jest.fn((arr) => ({ values: arr }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          scan: mockScan,
          delete: jest.fn(() => ({ promise: mockPromise })),
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
    mockPut.mockReturnValue({ promise: mockPromise });
    mockGet.mockReturnValue({ promise: mockPromise });
    mockScan.mockReturnValue({ promise: mockPromise });
    mockCreateSet.mockImplementation((arr) => ({ values: arr }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Extended Skill interface', () => {
    it('FAIL: existing skills without triggerMode should default to install_only when read', async () => {
      // Simulate a legacy skill from DB (no triggerMode field)
      const legacySkill = {
        skillId: 'legacy-1',
        name: 'Legacy Skill',
        description: 'Old skill without new fields',
        toolNames: ['tool1'],
        isPublished: true,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
        // NOTE: no triggerMode, no category, no schedule, etc.
      };
      mockPromise.mockResolvedValueOnce({ Item: legacySkill });

      const result = await skillService.getSkill('legacy-1');
      // After normalization, triggerMode should default to 'install_only'
      expect(result.triggerMode).toBe('install_only');
    });

    it('FAIL: skills with new fields should preserve them through get/put cycle', async () => {
      const extendedSkill: Skill = {
        skillId: 'ext-1',
        name: 'Extended Skill',
        description: 'Skill with new fields',
        toolNames: ['tool1'],
        isPublished: true,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
        category: 'digest',
        triggerMode: 'scheduled',
        schedule: {
          frequency: 'weekly',
          preferredTime: '09:00',
          deliveryChannels: ['slack'],
        },
        welcomeMessage: 'Welcome to this skill!',
        llmModel: 'claude-sonnet-4-20250514',
        maxIterations: 10,
        isBuiltIn: false,
        ownerId: 'user-123',
        visibility: 'public',
      };
      mockPromise.mockResolvedValueOnce({ Item: extendedSkill });

      const result = await skillService.getSkill('ext-1');
      expect(result.category).toBe('digest');
      expect(result.triggerMode).toBe('scheduled');
      expect(result.schedule).toEqual({
        frequency: 'weekly',
        preferredTime: '09:00',
        deliveryChannels: ['slack'],
      });
      expect(result.welcomeMessage).toBe('Welcome to this skill!');
      expect(result.llmModel).toBe('claude-sonnet-4-20250514');
      expect(result.maxIterations).toBe(10);
      expect(result.isBuiltIn).toBe(false);
      expect(result.ownerId).toBe('user-123');
      expect(result.visibility).toBe('public');
    });

    it('FAIL: Skill interface should accept category field', () => {
      // TypeScript compilation test - if Skill interface doesn't have category,
      // this would fail at compile time. At runtime, we verify the shape.
      const skill: Skill = {
        skillId: 'test',
        name: 'Test',
        description: 'Desc',
        toolNames: [],
        isPublished: false,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
        category: 'tool_bundle',
        triggerMode: 'on_demand',
      };
      expect(skill.category).toBe('tool_bundle');
      expect(skill.triggerMode).toBe('on_demand');
    });

    it('SUCCESS: existing skill CRUD still works with no new fields set', async () => {
      mockPromise.mockResolvedValueOnce({});

      const result = await skillService.createSkill(
        'Basic Skill',
        'A basic skill',
        ['tool1'],
        'system prompt'
      );

      // Should still work without new fields
      expect(result.skillId).toBe('test-skill-id-456');
      expect(result.name).toBe('Basic Skill');
      expect(mockPut).toHaveBeenCalled();
    });

    it('persists the existing welcomeMessage field on create', async () => {
      mockPromise.mockResolvedValueOnce({});

      const result = await skillService.createSkill(
        'Brief skill', 'Starts with a static brief', [], undefined, false,
        'Bring the artifact and the context.'
      );

      expect(result.welcomeMessage).toBe('Bring the artifact and the context.');
      expect(mockPut.mock.calls[0][0].Item.welcomeMessage).toBe('Bring the artifact and the context.');
    });
  });
});
