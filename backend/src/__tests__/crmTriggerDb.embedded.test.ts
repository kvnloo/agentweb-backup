// Mock dotenv and aws-sdk before any imports
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn(),
  },
}));

// Mock the DynamoDB operations used by the logs functions
jest.mock('../config/aws', () => ({
  dynamodb: {
    put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
  },
}));

jest.mock('../config/constants', () => ({ TABLE_PREFIX: '' }));

import { crmTriggerDb } from '../services/crmTriggerDb';
import { crmDb } from '../services/db';
import { CRMTrigger } from '../types/crmTriggers';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const makeTrigger = (overrides: Partial<CRMTrigger> = {}): CRMTrigger => ({
  triggerId: 'trig_test_1',
  listId: 'list_1',
  userId: 'user_1',
  event: 'lead.created',
  name: 'Test Trigger',
  enabled: true,
  conditionExpression: 'true',
  action: {
    type: 'send_email',
    toType: 'list_owner',
    subjectTemplate: 'Subject',
    bodyTemplate: '<p>Body</p>',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('crmTriggerDb (embedded in list record)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockCrmDb.updateLeadList as jest.Mock).mockResolvedValue({});
  });

  // ── getTriggersByListId ──────────────────────────────────────────────────

  describe('getTriggersByListId', () => {
    it('returns empty array when list not found', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
      const result = await crmTriggerDb.getTriggersByListId('nonexistent');
      expect(result).toEqual([]);
    });

    it('returns empty array when list has no triggers field', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1' });
      const result = await crmTriggerDb.getTriggersByListId('list_1');
      expect(result).toEqual([]);
    });

    it('returns triggers array from list', async () => {
      const trigger = makeTrigger();
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [trigger] });
      const result = await crmTriggerDb.getTriggersByListId('list_1');
      expect(result).toEqual([trigger]);
    });
  });

  // ── getTriggerById ───────────────────────────────────────────────────────

  describe('getTriggerById', () => {
    it('returns null when list not found', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
      const result = await crmTriggerDb.getTriggerById('trig_test_1', 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when trigger not in list', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [] });
      const result = await crmTriggerDb.getTriggerById('trig_missing', 'list_1');
      expect(result).toBeNull();
    });

    it('returns matching trigger', async () => {
      const trigger = makeTrigger();
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [trigger] });
      const result = await crmTriggerDb.getTriggerById('trig_test_1', 'list_1');
      expect(result).toEqual(trigger);
    });
  });

  // ── createTrigger ────────────────────────────────────────────────────────

  describe('createTrigger', () => {
    it('throws when 20 triggers already exist', async () => {
      const twentyTriggers = Array.from({ length: 20 }, (_, i) =>
        makeTrigger({ triggerId: `trig_${i}` })
      );
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: twentyTriggers });

      await expect(
        crmTriggerDb.createTrigger({
          listId: 'list_1',
          userId: 'user_1',
          event: 'lead.created',
          name: 'New',
          enabled: true,
          conditionExpression: 'true',
          action: { type: 'send_email', toType: 'list_owner', subjectTemplate: 'S', bodyTemplate: 'B' },
        })
      ).rejects.toThrow('Maximum of 20');
    });

    it('creates trigger, appends to list, and returns it with generated id', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [] });

      const result = await crmTriggerDb.createTrigger({
        listId: 'list_1',
        userId: 'user_1',
        event: 'lead.created',
        name: 'New Trigger',
        enabled: true,
        conditionExpression: 'true',
        action: { type: 'send_email', toType: 'list_owner', subjectTemplate: 'Sub', bodyTemplate: 'Body' },
      });

      expect(result.triggerId).toMatch(/^trig_/);
      expect(result.name).toBe('New Trigger');
      expect(result.listId).toBe('list_1');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();

      expect(mockCrmDb.updateLeadList).toHaveBeenCalledWith(
        'list_1',
        expect.objectContaining({ triggers: expect.arrayContaining([result]) })
      );
    });
  });

  // ── updateTrigger ────────────────────────────────────────────────────────

  describe('updateTrigger', () => {
    it('throws when trigger not found', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [] });
      await expect(
        crmTriggerDb.updateTrigger('trig_missing', 'list_1', { name: 'New' })
      ).rejects.toThrow('Trigger not found');
    });

    it('replaces the trigger in the list with updated fields', async () => {
      const existing = makeTrigger({ name: 'Old Name' });
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [existing] });

      const result = await crmTriggerDb.updateTrigger('trig_test_1', 'list_1', { name: 'New Name' });

      expect(result.name).toBe('New Name');
      expect(result.triggerId).toBe('trig_test_1');
      expect(result.updatedAt).not.toBe(existing.updatedAt);

      expect(mockCrmDb.updateLeadList).toHaveBeenCalledWith(
        'list_1',
        { triggers: [expect.objectContaining({ name: 'New Name' })] }
      );
    });
  });

  // ── deleteTrigger ────────────────────────────────────────────────────────

  describe('deleteTrigger', () => {
    it('throws when trigger not found', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [] });
      await expect(
        crmTriggerDb.deleteTrigger('trig_missing', 'list_1')
      ).rejects.toThrow('Trigger not found');
    });

    it('removes the trigger from the list', async () => {
      const trigger = makeTrigger();
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [trigger] });

      await crmTriggerDb.deleteTrigger('trig_test_1', 'list_1');

      expect(mockCrmDb.updateLeadList).toHaveBeenCalledWith('list_1', { triggers: [] });
    });

    it('only removes the matching trigger when multiple exist', async () => {
      const t1 = makeTrigger({ triggerId: 'trig_1' });
      const t2 = makeTrigger({ triggerId: 'trig_2' });
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', triggers: [t1, t2] });

      await crmTriggerDb.deleteTrigger('trig_1', 'list_1');

      expect(mockCrmDb.updateLeadList).toHaveBeenCalledWith('list_1', { triggers: [t2] });
    });
  });
});
