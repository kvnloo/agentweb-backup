import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    update: jest.fn(),
  };
  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    S3: jest.fn(() => mockS3),
    config: { update: jest.fn() },
  };
});

import { crmDb } from '../services/db';

/**
 * ENG-1380 — CodeRabbit finding: crmDb.setLeadListCrmSyncConfig used to
 * replace externalCrmSyncConfigs.<provider> wholesale (read the map, merge
 * in JS, write the whole map back). A concurrent
 * crmDb.updateLeadListCrmSyncStatus nested-path write (lastPushSyncAt,
 * lastSyncStatus, etc.) landing between the read and the write here would be
 * silently clobbered by this call's stale snapshot of those same fields.
 * Now it writes field-by-field via targeted nested paths once the provider's
 * config already exists, so a concurrent status write on a sibling field can
 * never be stomped.
 */
describe('crmDb.setLeadListCrmSyncConfig', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB = new (AWS.DynamoDB as any).DocumentClient();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('writes the whole provider map on first-ever save (provider key does not exist yet)', async () => {
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: {} }) });

    await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', { autoSyncEnabled: true, webhookEnabled: true });

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET #ecs = :mergedMap, #updatedAt = :now');
    expect(params.ExpressionAttributeValues[':mergedMap']).toEqual({
      attio: { autoSyncEnabled: true, webhookEnabled: true },
    });
  });

  it('writes the whole provider map on first save even when a sibling provider already exists', async () => {
    mockDynamoDB.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Item: { externalCrmSyncConfigs: { hubspot: { autoSyncEnabled: false } } } }),
    });

    await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', { autoSyncEnabled: true });

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ExpressionAttributeValues[':mergedMap']).toEqual({
      hubspot: { autoSyncEnabled: false },
      attio: { autoSyncEnabled: true },
    });
  });

  it('writes field-by-field via targeted nested paths once the provider config already exists', async () => {
    mockDynamoDB.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Item: { externalCrmSyncConfigs: { attio: { autoSyncEnabled: false, lastSyncStatus: 'success' } } },
      }),
    });

    await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', {
      autoSyncEnabled: true,
      webhookEnabled: true,
    });

    const params = mockDynamoDB.update.mock.calls[0][0];
    // Never a whole-object replace — no :mergedMap value at all.
    expect(params.ExpressionAttributeValues[':mergedMap']).toBeUndefined();
    expect(params.UpdateExpression).toContain('SET #ecs.#provider.#autoSyncEnabled = :autoSyncEnabled');
    expect(params.UpdateExpression).toContain('#ecs.#provider.#webhookEnabled = :webhookEnabled');
    expect(params.UpdateExpression).toContain('#updatedAt = :now');
    expect(params.ExpressionAttributeNames['#provider']).toBe('attio');
    expect(params.ExpressionAttributeValues[':autoSyncEnabled']).toBe(true);
    expect(params.ExpressionAttributeValues[':webhookEnabled']).toBe(true);
    // The field this call didn't mention (lastSyncStatus) must not appear
    // anywhere in the expression — proving a concurrent
    // updateLeadListCrmSyncStatus write to it can't be clobbered.
    expect(params.UpdateExpression).not.toContain('lastSyncStatus');
    expect(params.ExpressionAttributeNames['#lastSyncStatus']).toBeUndefined();
  });

  it('REMOVEs a field whose value is explicitly undefined, once the provider config already exists', async () => {
    mockDynamoDB.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Item: { externalCrmSyncConfigs: { attio: { autoSyncEnabled: true, dealFieldMapping: [] } } },
      }),
    });

    await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', {
      autoSyncEnabled: true,
      externalPipelineId: undefined,
    });

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('REMOVE #ecs.#provider.#externalPipelineId');
    expect(params.ExpressionAttributeValues[':externalPipelineId']).toBeUndefined();
  });

  it('does not clobber a value the caller never mentions, once the provider config already exists', async () => {
    // Simulates the race CodeRabbit flagged: updateLeadListCrmSyncStatus set
    // lastPushSyncAt/lastSyncStatus concurrently between this call's read and
    // write. Since this config object doesn't mention those fields at all,
    // the targeted per-field write must never touch them.
    mockDynamoDB.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Item: {
          externalCrmSyncConfigs: {
            attio: { autoSyncEnabled: false, lastPushSyncAt: '2026-08-31T12:00:00.000Z', lastSyncStatus: 'success' },
          },
        },
      }),
    });

    await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', { autoSyncEnabled: true });

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).not.toContain('lastPushSyncAt');
    expect(params.UpdateExpression).not.toContain('lastSyncStatus');
  });

  it('removes only the provider key when config is null, leaving other providers and status fields untouched', async () => {
    await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', null);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('REMOVE #ecs.#provider SET #updatedAt = :now');
    expect(mockDynamoDB.get).not.toHaveBeenCalled();
  });
});
