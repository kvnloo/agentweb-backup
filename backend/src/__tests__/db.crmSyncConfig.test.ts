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

// Helper: pull the { alias -> field } map back out of ExpressionAttributeNames
// so tests can assert on real field names without hardcoding index positions.
function nameForField(names: Record<string, string>, field: string): string | undefined {
  return Object.entries(names).find(([, v]) => v === field)?.[0];
}

/**
 * ENG-1380 — CodeRabbit findings on crmDb.setLeadListCrmSyncConfig, both
 * fixed here:
 *
 * 1. It used to replace externalCrmSyncConfigs.<provider> — or, on a
 *    provider's first-ever save, the WHOLE externalCrmSyncConfigs map
 *    including every other already-connected provider — wholesale (read,
 *    merge in JS, write the whole thing back). A concurrent
 *    updateLeadListCrmSyncStatus nested-path write for ANY provider landing
 *    between the read and the write here would be silently clobbered. Now
 *    it always writes via targeted nested paths once externalCrmSyncConfigs
 *    exists as an attribute at all; the only remaining special case is that
 *    attribute not existing on the item yet at all (the very first CRM
 *    connection ever made for this list), which bootstraps it via a
 *    conditional write.
 *
 * 2. The targeted per-field write used to alias each field by its own name
 *    (#${field}). Every real ExternalCrmSyncConfig carries a `provider`
 *    field, which silently overwrote the OTHER #provider alias already
 *    bound to the provider VALUE ('attio'/'hubspot'), corrupting every
 *    #ecs.#provider.* path in the same expression. Now uses collision-proof
 *    indexed aliases (#f0/:v0, #f1/:v1, ...).
 */
describe('crmDb.setLeadListCrmSyncConfig', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB = new (AWS.DynamoDB as any).DocumentClient();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  describe('externalCrmSyncConfigs does not exist on the item at all (first-ever connection)', () => {
    it('bootstraps a single-provider map with a conditional write', async () => {
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: {} }) });

      await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', { provider: 'attio', autoSyncEnabled: true });

      const params = mockDynamoDB.update.mock.calls[0][0];
      expect(params.UpdateExpression).toBe('SET #ecs = :singleProviderMap, #updatedAt = :now');
      expect(params.ConditionExpression).toBe('attribute_not_exists(#ecs)');
      expect(params.ExpressionAttributeValues[':singleProviderMap']).toEqual({
        attio: { provider: 'attio', autoSyncEnabled: true },
      });
    });

    it('falls through to a targeted per-field write when the conditional bootstrap loses a race', async () => {
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: {} }) });
      // First update() call (the conditional bootstrap) loses the race —
      // someone else's concurrent first-connection save landed first.
      const condFailure: any = new Error('conditional check failed');
      condFailure.code = 'ConditionalCheckFailedException';
      mockDynamoDB.update
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(condFailure) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', { provider: 'attio', autoSyncEnabled: true });

      expect(mockDynamoDB.update).toHaveBeenCalledTimes(2);
      const secondCallParams = mockDynamoDB.update.mock.calls[1][0];
      // The fallback write must be the targeted per-field form, not another
      // wholesale replace — no :singleProviderMap value on the second call.
      expect(secondCallParams.ExpressionAttributeValues[':singleProviderMap']).toBeUndefined();
      expect(secondCallParams.ConditionExpression).toBeUndefined();
      const providerAlias = nameForField(secondCallParams.ExpressionAttributeNames, 'provider');
      expect(providerAlias).toBeDefined();
      expect(secondCallParams.UpdateExpression).toContain(`#ecs.#provider.${providerAlias} = ${providerAlias!.replace('#f', ':v')}`);
    });

    it('propagates a genuine DynamoDB error from the conditional bootstrap (not a lost race)', async () => {
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: {} }) });
      const realError: any = new Error('throughput exceeded');
      realError.code = 'ProvisionedThroughputExceededException';
      mockDynamoDB.update.mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(realError) });

      await expect(
        crmDb.setLeadListCrmSyncConfig('list-1', 'attio', { provider: 'attio', autoSyncEnabled: true })
      ).rejects.toThrow('throughput exceeded');
      expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('externalCrmSyncConfigs already exists on the item (any provider ever connected before)', () => {
    it('writes field-by-field via targeted nested paths for a provider connecting for the first time', async () => {
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { externalCrmSyncConfigs: { hubspot: { autoSyncEnabled: false } } } }),
      });

      await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', { autoSyncEnabled: true });

      const params = mockDynamoDB.update.mock.calls[0][0];
      // No conditional write, no wholesale replace — a direct nested SET
      // against the already-existing #ecs map, whether or not "attio" was
      // already one of its keys.
      expect(params.ConditionExpression).toBeUndefined();
      expect(params.ExpressionAttributeValues[':mergedMap']).toBeUndefined();
      expect(params.ExpressionAttributeValues[':singleProviderMap']).toBeUndefined();
      expect(params.ExpressionAttributeNames['#provider']).toBe('attio');
      const alias = nameForField(params.ExpressionAttributeNames, 'autoSyncEnabled');
      expect(params.UpdateExpression).toContain(`#ecs.#provider.${alias} = ${alias!.replace('#f', ':v')}`);
      // hubspot's own entry must never appear anywhere in this write.
      expect(JSON.stringify(params)).not.toContain('hubspot');
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
      expect(params.ExpressionAttributeValues[':mergedMap']).toBeUndefined();
      expect(params.ExpressionAttributeValues[':singleProviderMap']).toBeUndefined();
      const autoSyncAlias = nameForField(params.ExpressionAttributeNames, 'autoSyncEnabled')!;
      const webhookAlias = nameForField(params.ExpressionAttributeNames, 'webhookEnabled')!;
      expect(params.UpdateExpression).toContain(`SET #ecs.#provider.${autoSyncAlias} = ${autoSyncAlias.replace('#f', ':v')}`);
      expect(params.UpdateExpression).toContain(`#ecs.#provider.${webhookAlias} = ${webhookAlias.replace('#f', ':v')}`);
      expect(params.UpdateExpression).toContain('#updatedAt = :now');
      expect(params.ExpressionAttributeNames['#provider']).toBe('attio');
      // The field this call didn't mention (lastSyncStatus) must not appear
      // anywhere in the expression — proving a concurrent
      // updateLeadListCrmSyncStatus write to it can't be clobbered.
      expect(nameForField(params.ExpressionAttributeNames, 'lastSyncStatus')).toBeUndefined();
      expect(params.UpdateExpression).not.toContain('lastSyncStatus');
    });

    it('REMOVEs a field whose value is explicitly undefined', async () => {
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
      const alias = nameForField(params.ExpressionAttributeNames, 'externalPipelineId')!;
      expect(params.UpdateExpression).toContain(`REMOVE #ecs.#provider.${alias}`);
      expect(params.ExpressionAttributeValues[alias.replace('#f', ':v')]).toBeUndefined();
    });

    it('does not clobber a value the caller never mentions', async () => {
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
      expect(nameForField(params.ExpressionAttributeNames, 'lastPushSyncAt')).toBeUndefined();
      expect(nameForField(params.ExpressionAttributeNames, 'lastSyncStatus')).toBeUndefined();
    });

    // CodeRabbit finding (ENG-1380): every real ExternalCrmSyncConfig carries
    // a `provider` field. Aliasing per-field by the field's own name
    // (#${field}) meant iterating this field overwrote the #provider alias
    // that was supposed to hold the provider VALUE ('attio'), corrupting
    // every #ecs.#provider.* path in the whole expression.
    it('does not corrupt the #provider alias when the config object itself has a `provider` field', async () => {
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { externalCrmSyncConfigs: { attio: { autoSyncEnabled: false } } },
        }),
      });

      await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', {
        provider: 'attio',
        listId: 'list-1',
        autoSyncEnabled: true,
      });

      const params = mockDynamoDB.update.mock.calls[0][0];
      // #provider must still resolve to the provider VALUE, not the literal
      // string "provider" — this is the actual regression this test guards.
      expect(params.ExpressionAttributeNames['#provider']).toBe('attio');
      // Every SET/REMOVE path must still be anchored under externalCrmSyncConfigs.attio.
      const pathClauses = params.UpdateExpression.match(/#ecs\.#provider\.\S+/g) ?? [];
      expect(pathClauses.length).toBeGreaterThan(0);
      // The config's own `provider` field must still be persisted (as its
      // own, separately-aliased field) — it's just not allowed to clobber
      // the #provider alias while doing so.
      const providerFieldAlias = Object.entries(params.ExpressionAttributeNames as Record<string, string>)
        .filter(([alias, field]) => alias !== '#provider' && field === 'provider');
      expect(providerFieldAlias.length).toBe(1);
    });

    it('does not corrupt the #ecs or #updatedAt aliases when the config object has fields named ecs or updatedAt', async () => {
      mockDynamoDB.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { externalCrmSyncConfigs: { attio: { autoSyncEnabled: false } } },
        }),
      });

      await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', {
        updatedAt: '2020-01-01T00:00:00.000Z',
        autoSyncEnabled: true,
      });

      const params = mockDynamoDB.update.mock.calls[0][0];
      expect(params.ExpressionAttributeNames['#ecs']).toBe('externalCrmSyncConfigs');
      // The top-level list updatedAt must still be stamped with a fresh
      // timestamp (:now), not silently reassigned to the caller's stale value.
      expect(params.UpdateExpression).toContain('#updatedAt = :now');
      expect(params.ExpressionAttributeValues[':now']).toBeTruthy();
    });
  });

  it('removes only the provider key when config is null, leaving other providers and status fields untouched', async () => {
    await crmDb.setLeadListCrmSyncConfig('list-1', 'attio', null);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('REMOVE #ecs.#provider SET #updatedAt = :now');
    expect(mockDynamoDB.get).not.toHaveBeenCalled();
  });
});
