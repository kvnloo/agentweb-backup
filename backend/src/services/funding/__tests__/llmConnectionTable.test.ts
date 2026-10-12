/**
 * ENG-2105 (A1): the table definition and the BYOK switch.
 */
const createTable = jest.fn((_params: any) => ({ promise: async () => ({}) }));
jest.mock('aws-sdk', () => {
  class DynamoDB {
    createTable = createTable;
    updateTimeToLive = () => ({ promise: async () => ({}) });
    static DocumentClient = class {};
  }
  return { __esModule: true, default: { DynamoDB, S3: class {}, config: { update: jest.fn() } }, DynamoDB, S3: class {}, config: { update: jest.fn() } };
});
jest.mock('../../settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));

import { settingsService } from '../../settingsService';
import { CRITICAL_TABLE_SPECS } from '../../ensureCriticalTables';
import { __resetFundingFlagsCacheForTests, isByokEnabledFor } from '../fundingFlags';
import {
  LLM_CONNECTIONS_ORG_INDEX,
  LLM_CONNECTIONS_OWNER_INDEX,
  LLM_CONNECTIONS_PROVIDER_INDEX,
  LLM_CONNECTIONS_TABLE,
  LLM_CONNECTIONS_TABLE_SPEC as SPEC,
} from '../llmConnectionDb';

describe('AW-LlmConnections table definition', () => {
  it('defines every key attribute and nothing unused, which DynamoDB rejects at create time', () => {
    const defined = new Set(SPEC.AttributeDefinitions.map((a) => a.AttributeName));
    const used = new Set([
      ...SPEC.KeySchema.map((k) => k.AttributeName),
      ...(SPEC.GlobalSecondaryIndexes ?? []).flatMap((g) => g.KeySchema.map((k) => k.AttributeName)),
    ]);
    expect([...defined].sort()).toEqual([...used].sort());
    expect(SPEC.KeySchema).toEqual([{ AttributeName: 'connectionId', KeyType: 'HASH' }]);
  });

  it('is the table the store reads, with the indexes it queries', () => {
    expect(SPEC.TableName).toBe(LLM_CONNECTIONS_TABLE);
    expect((SPEC.GlobalSecondaryIndexes ?? []).map((g) => g.IndexName).sort()).toEqual(
      [LLM_CONNECTIONS_ORG_INDEX, LLM_CONNECTIONS_OWNER_INDEX, LLM_CONNECTIONS_PROVIDER_INDEX].sort(),
    );
  });

  it('is exactly what scripts/create-tables.ts creates', async () => {
    const { createLlmConnectionsTable } = require('../../../scripts/create-tables');
    await createLlmConnectionsTable();
    expect(createTable).toHaveBeenCalledTimes(1);
    expect(createTable.mock.calls[0][0]).toEqual(SPEC);
  });

  it('is delete-protected, on-demand, and ensured at boot', () => {
    expect(SPEC.DeletionProtectionEnabled).toBe(true);
    expect(SPEC.BillingMode).toBe('PAY_PER_REQUEST');
    expect(CRITICAL_TABLE_SPECS).toContain(SPEC);
  });
});

describe('isByokEnabledFor', () => {
  const row = (flags: object) => ({ settingValue: JSON.stringify({ claudeSubscription: { enabled: false, allowUserIds: [] }, killSwitch: false, ...flags }) });
  const getSetting = settingsService.getSetting as jest.Mock;
  beforeEach(() => {
    __resetFundingFlagsCacheForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['no settings row', null, 'u1', false],
    ['disabled, user listed', row({ byok: { enabled: false, allowUserIds: ['u1'] } }), 'u1', false],
    ['enabled, nobody listed', row({ byok: { enabled: true, allowUserIds: [] } }), 'u1', false],
    ['enabled, another user listed', row({ byok: { enabled: true, allowUserIds: ['u2'] } }), 'u1', false],
    ['enabled, user listed', row({ byok: { enabled: true, allowUserIds: ['u2', 'u1'] } }), 'u1', true],
    ['enabled for everyone', row({ byok: { enabled: true, allowUserIds: ['*'] } }), 'anyone', true],
    ['kill switch on, user listed', row({ byok: { enabled: true, allowUserIds: ['*'] }, killSwitch: true }), 'u1', false],
  ])('%s', async (_label, setting, userId, expected) => {
    getSetting.mockResolvedValue(setting);
    expect(await isByokEnabledFor(userId as string)).toBe(expected);
  });
});
