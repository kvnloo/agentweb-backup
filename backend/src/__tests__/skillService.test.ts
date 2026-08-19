import { Skill } from '../services/skillService';

describe('SkillService', () => {
  let skillService: any;
  let SkillService: any;
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
    SkillService = module.SkillService;
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

    it('should respect isPublished flag when creating a skill', async () => {
      mockPromise.mockResolvedValueOnce({});

      const result = await skillService.createSkill(
        'Published Skill',
        'Description',
        [],
        undefined,
        true // isPublished
      );

      expect(result.isPublished).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({ isPublished: true })
      }));
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

      expect(result).toEqual({ ...mockSkill, triggerMode: 'install_only' });
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

    it('excludes a pending-review skill whose stale publication flag is true', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [{ skillId: 'pending', name: 'Pending', description: 'Desc', toolNames: [], isPublished: true, visibility: 'pending_review', createdAt: mockTimestamp, updatedAt: mockTimestamp }] });
      expect(await skillService.getPublishedSkills()).toEqual([]);
    });
  });

  describe('getSkillsAvailableToUser', () => {
    it('preserves the owner but not another member\'s pending-review skill', async () => {
      const owned = { skillId: 'owned', ownerId: 'member', visibility: 'pending_review', isPublished: true };
      jest.spyOn(skillService, 'getPublishedSkills').mockResolvedValue([]);
      jest.spyOn(skillService, 'getSkillsByOwner').mockResolvedValue([owned]);
      jest.spyOn(skillService, 'getSkillsByOrg').mockResolvedValue([{ skillId: 'other', ownerId: 'owner', visibility: 'pending_review', isPublished: true }]);
      expect(await skillService.getSkillsAvailableToUser('member', 'org')).toEqual([owned]);
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

    /**
     * ENG-947: a bulk migration cannot make a read-then-write safe by re-reading —
     * the row can still change between the read and the put. `expectedUpdatedAt`
     * turns the put into a compare-and-swap so the write itself is the check.
     * Omitting it must leave every existing caller byte-identical.
     */
    describe('optimistic concurrency (ENG-947)', () => {
      const skill = {
        skillId: 'skill-1',
        name: 'Test',
        description: 'Desc',
        isPublished: false,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      };

      it('sends no ConditionExpression when no expected timestamp is given', async () => {
        await skillService.updateSkill(skill);
        const params = mockPut.mock.calls[mockPut.mock.calls.length - 1][0];
        expect(params.ConditionExpression).toBeUndefined();
        expect(params.ExpressionAttributeValues).toBeUndefined();
      });

      it('guards the put on the expected updatedAt when one is given', async () => {
        await skillService.updateSkill(skill, mockTimestamp);
        const params = mockPut.mock.calls[mockPut.mock.calls.length - 1][0];
        expect(params.ConditionExpression).toBe('updatedAt = :expectedUpdatedAt');
        expect(params.ExpressionAttributeValues).toEqual({ ':expectedUpdatedAt': mockTimestamp });
      });

      it('stamps the written item from the clock, not from the expected timestamp', async () => {
        // The expected value is the row's CURRENT stamp; the item must carry a NEW
        // one. Pick an expected that differs from the frozen clock so the two are
        // actually distinguishable here.
        const priorStamp = '2020-01-01T00:00:00.000Z';
        await skillService.updateSkill({ ...skill, updatedAt: priorStamp }, priorStamp);
        const params = mockPut.mock.calls[mockPut.mock.calls.length - 1][0];
        expect(params.Item.updatedAt).not.toBe(priorStamp);
        expect(params.ExpressionAttributeValues).toEqual({ ':expectedUpdatedAt': priorStamp });
      });

      it('propagates a ConditionalCheckFailedException so the caller can skip the row', async () => {
        const conflict: any = new Error('The conditional request failed');
        conflict.code = 'ConditionalCheckFailedException';
        mockPromise.mockRejectedValueOnce(conflict);
        await expect(skillService.updateSkill(skill, mockTimestamp)).rejects.toMatchObject({
          code: 'ConditionalCheckFailedException',
        });
      });

      it('guards on an empty-string expected timestamp rather than silently skipping the check', async () => {
        // A row with a falsy updatedAt must not degrade into an unconditional write.
        await skillService.updateSkill(skill, '');
        const params = mockPut.mock.calls[mockPut.mock.calls.length - 1][0];
        expect(params.ConditionExpression).toBe('updatedAt = :expectedUpdatedAt');
        expect(params.ExpressionAttributeValues).toEqual({ ':expectedUpdatedAt': '' });
      });
    });
  });

  describe('deleteSkill', () => {
    it('should delete skill by skillId', async () => {
      await skillService.deleteSkill('skill-1');
      expect(mockDelete).toHaveBeenCalled();
    });
  });

  describe('withdrawFromReview (ENG-932)', () => {
    const pendingSkill = {
      skillId: 'skill-1',
      name: 'Test Skill',
      description: 'Description',
      toolNames: ['tool1'],
      isPublished: false,
      ownerId: 'owner-1',
      visibility: 'pending_review',
      createdAt: mockTimestamp,
      updatedAt: mockTimestamp,
    };

    it('moves a pending_review skill back to private, owned by the requester', async () => {
      mockPromise
        .mockResolvedValueOnce({ Item: pendingSkill }) // getSkill
        .mockResolvedValueOnce({}); // updateSkill put

      const result = await skillService.withdrawFromReview('skill-1', 'owner-1');

      expect(result.visibility).toBe('private');
      expect(result.reviewFeedback).toBeUndefined();
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({ visibility: 'private' }),
      }));
    });

    it('leaves the skill content unchanged aside from visibility', async () => {
      mockPromise
        .mockResolvedValueOnce({ Item: pendingSkill })
        .mockResolvedValueOnce({});

      await skillService.withdrawFromReview('skill-1', 'owner-1');

      const putCall = mockPut.mock.calls[0][0];
      expect(putCall.Item.name).toBe(pendingSkill.name);
      expect(putCall.Item.description).toBe(pendingSkill.description);
      expect(putCall.Item.skillId).toBe(pendingSkill.skillId);
    });

    it('throws "Skill not found" for a missing skill', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });
      await expect(skillService.withdrawFromReview('nope', 'owner-1'))
        .rejects.toThrow('Skill not found');
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('throws "Not authorized" when the requester does not own the skill', async () => {
      mockPromise.mockResolvedValueOnce({ Item: pendingSkill });
      await expect(skillService.withdrawFromReview('skill-1', 'someone-else'))
        .rejects.toThrow('Not authorized');
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('throws "Skill is not pending review" for a private skill', async () => {
      mockPromise.mockResolvedValueOnce({ Item: { ...pendingSkill, visibility: 'private' } });
      await expect(skillService.withdrawFromReview('skill-1', 'owner-1'))
        .rejects.toThrow('Skill is not pending review');
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('throws "Skill is not pending review" for an already-public skill', async () => {
      mockPromise.mockResolvedValueOnce({ Item: { ...pendingSkill, visibility: 'public' } });
      await expect(skillService.withdrawFromReview('skill-1', 'owner-1'))
        .rejects.toThrow('Skill is not pending review');
      expect(mockPut).not.toHaveBeenCalled();
    });
  });

  describe('syncSkill', () => {
    const mockSkill = {
      skillId: 'skill-1',
      name: 'Test Skill',
      description: 'Description',
      toolNames: ['tool1', 'tool2'],
      isPublished: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    it('should read from prod table and write to dev table for prod-to-dev', async () => {
      mockPromise
        .mockResolvedValueOnce({ Item: mockSkill }) // get from source
        .mockResolvedValueOnce({}); // put to target

      const result = await skillService.syncSkill('skill-1', 'prod-to-dev');

      expect(result).toEqual(expect.objectContaining({ skillId: 'skill-1', name: 'Test Skill' }));
      // Should read from AW-Skills (prod) and write to Dev-AW-Skills (dev)
      expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'AW-Skills',
        Key: { skillId: 'skill-1' },
      }));
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'Dev-AW-Skills',
      }));
    });

    it('should read from dev table and write to prod table for dev-to-prod', async () => {
      mockPromise
        .mockResolvedValueOnce({ Item: mockSkill }) // get from source
        .mockResolvedValueOnce({}); // put to target

      const result = await skillService.syncSkill('skill-1', 'dev-to-prod');

      expect(result).toEqual(expect.objectContaining({ skillId: 'skill-1' }));
      expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'Dev-AW-Skills',
      }));
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'AW-Skills',
      }));
    });

    it('should return null if skill not found in source table', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });

      const result = await skillService.syncSkill('non-existent', 'prod-to-dev');
      expect(result).toBeNull();
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('should convert DynamoDB Set toolNames when writing to target', async () => {
      const skillWithSet = {
        ...mockSkill,
        toolNames: { values: ['tool1', 'tool2'] },
      };
      mockPromise
        .mockResolvedValueOnce({ Item: skillWithSet })
        .mockResolvedValueOnce({});

      const result = await skillService.syncSkill('skill-1', 'prod-to-dev');

      expect(result?.toolNames).toEqual(['tool1', 'tool2']);
      expect(mockCreateSet).toHaveBeenCalledWith(['tool1', 'tool2']);
    });
  });

  describe('getSyncStatus', () => {
    const skill1 = {
      skillId: 'skill-1',
      name: 'Skill One',
      description: 'Desc',
      toolNames: ['tool1'],
      isPublished: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    it('should return inSync=true when prod and dev skills match on content fields', async () => {
      const devSkill = { ...skill1, updatedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' };
      // First scan = prod table, second scan = dev table
      mockPromise
        .mockResolvedValueOnce({ Items: [skill1] })
        .mockResolvedValueOnce({ Items: [devSkill] });

      const result = await skillService.getSyncStatus();

      expect(result['skill-1']).toEqual({
        inSync: true,
        existsInProd: true,
        existsInDev: true,
        changedFields: [],
      });
    });

    it('should return inSync=false with changedFields when content fields differ', async () => {
      const devSkill = { ...skill1, name: 'Different Name' };
      mockPromise
        .mockResolvedValueOnce({ Items: [skill1] })
        .mockResolvedValueOnce({ Items: [devSkill] });

      const result = await skillService.getSyncStatus();

      expect(result['skill-1'].inSync).toBe(false);
      expect(result['skill-1'].changedFields).toEqual(['name']);
      expect(result['skill-1'].existsInProd).toBe(true);
      expect(result['skill-1'].existsInDev).toBe(true);
    });

    it('should report multiple changed fields', async () => {
      const devSkill = { ...skill1, name: 'Different', description: 'New desc', isPublished: false };
      mockPromise
        .mockResolvedValueOnce({ Items: [skill1] })
        .mockResolvedValueOnce({ Items: [devSkill] });

      const result = await skillService.getSyncStatus();

      expect(result['skill-1'].changedFields).toEqual(['name', 'description', 'isPublished']);
    });

    it('should return existsInDev=false when skill only in prod', async () => {
      mockPromise
        .mockResolvedValueOnce({ Items: [skill1] })
        .mockResolvedValueOnce({ Items: [] });

      const result = await skillService.getSyncStatus();

      expect(result['skill-1']).toEqual({
        inSync: false,
        existsInProd: true,
        existsInDev: false,
        changedFields: [],
      });
    });

    it('should return existsInProd=false when skill only in dev', async () => {
      mockPromise
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Items: [skill1] });

      const result = await skillService.getSyncStatus();

      expect(result['skill-1']).toEqual({
        inSync: false,
        existsInProd: false,
        existsInDev: true,
        changedFields: [],
      });
    });

    it('should handle empty tables', async () => {
      mockPromise
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Items: [] });

      const result = await skillService.getSyncStatus();

      expect(result).toEqual({});
    });
  });
});
