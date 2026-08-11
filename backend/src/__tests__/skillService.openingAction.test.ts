import { Skill, SkillOpeningAction } from '../services/skillService';

describe('SkillService - openingAction (ENG-712)', () => {
  let skillService: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockPromise: jest.Mock;
  let mockCreateSet: jest.Mock;

  const mockTimestamp = '2026-08-10T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));
    mockCreateSet = jest.fn((arr) => ({ values: arr }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          scan: jest.fn(() => ({ promise: mockPromise })),
          delete: jest.fn(() => ({ promise: mockPromise })),
          batchGet: jest.fn(() => ({ promise: mockPromise })),
          createSet: mockCreateSet,
        })),
      },
    }));

    jest.doMock('uuid', () => ({
      v4: jest.fn(() => 'test-skill-id-712'),
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
    mockCreateSet.mockImplementation((arr) => ({ values: arr }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('brief openingAction', () => {
    it('FAIL: createSkill persists a brief openingAction', async () => {
      const briefAction: SkillOpeningAction = {
        type: 'brief',
        content: "Drop your artifact + your yap, and I'll draft from there.",
      };

      const skill = await skillService.createSkill(
        'LinkedIn Post Factory',
        'Drafts LinkedIn posts',
        ['create_post'],
        'system prompt',
        true,
        briefAction
      );

      expect(skill.openingAction).toEqual(briefAction);
      expect(mockPut).toHaveBeenCalled();
      const putArgs = mockPut.mock.calls[0][0];
      expect(putArgs.Item.openingAction).toEqual(briefAction);
    });
  });

  describe('prefetch openingAction', () => {
    it('FAIL: createSkill persists a prefetch openingAction with toolCalls', async () => {
      const prefetchAction: SkillOpeningAction = {
        type: 'prefetch',
        toolCalls: [
          { toolName: 'find_reply_candidates', args: { count: 5 } },
        ],
      };

      const skill = await skillService.createSkill(
        'Reply Guy',
        'Finds reply candidates',
        ['find_reply_candidates'],
        undefined,
        true,
        prefetchAction
      );

      expect(skill.openingAction).toEqual(prefetchAction);
    });
  });

  describe('backward compatibility', () => {
    it('FAIL: getSkill on a legacy item with no openingAction normalizes to undefined, not a fabricated default', async () => {
      const legacySkill = {
        skillId: 'legacy-712',
        name: 'Legacy Skill',
        description: 'Old skill, predates ENG-712',
        toolNames: ['tool1'],
        isPublished: true,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      };
      mockPromise.mockResolvedValueOnce({ Item: legacySkill });

      const result: Skill = await skillService.getSkill('legacy-712');

      expect(result.openingAction).toBeUndefined();
    });

    it('SUCCESS: createSkill with no openingAction still works exactly as before (no regression)', async () => {
      mockPromise.mockResolvedValueOnce({});

      const skill = await skillService.createSkill(
        'Plain Skill',
        'No opening action',
        ['tool1'],
        'system prompt'
      );

      expect(skill.skillId).toBe('test-skill-id-712');
      expect(skill.openingAction).toBeUndefined();
      expect(mockPut).toHaveBeenCalled();
      const putArgs = mockPut.mock.calls[0][0];
      expect(putArgs.Item.openingAction).toBeUndefined();
    });
  });

  describe('updateSkill', () => {
    it('FAIL: updateSkill persists an openingAction added to an existing skill, preserving other fields', async () => {
      const existing: Skill = {
        skillId: 'existing-712',
        name: 'Existing Skill',
        description: 'Desc',
        toolNames: ['tool1'],
        isPublished: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const updated: Skill = {
        ...existing,
        openingAction: { type: 'brief', content: 'Welcome back.' },
      };

      await skillService.updateSkill(updated);

      expect(mockPut).toHaveBeenCalled();
      const putArgs = mockPut.mock.calls[0][0];
      expect(putArgs.Item.name).toBe('Existing Skill');
      expect(putArgs.Item.openingAction).toEqual({ type: 'brief', content: 'Welcome back.' });
    });
  });
});
