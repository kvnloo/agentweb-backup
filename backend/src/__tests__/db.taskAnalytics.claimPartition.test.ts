/**
 * ENG-2837: lead-submission idempotency claims live in AW-Configs under a reserved system
 * partition. getTaskAnalytics scans the whole table; the claim partition must be excluded
 * SERVER-SIDE (Scan FilterExpression) so claims are neither counted as configs nor loaded
 * into the analytics process's memory. Other tables' scans stay unfiltered.
 */

const scanMock = jest.fn();

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn((params: any) => ({ promise: () => scanMock(params) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

import { taskDb } from '../services/db';
import { LEAD_SUBMISSION_CLAIM_PARTITION } from '../services/leadSubmissionIdempotency';

const now = new Date().toISOString();
const configsPages = [
  {
    Items: [
      { userId: 'user_1', configId: 'c1', createdAt: now },
      { userId: 'user_2', configId: 'c2', createdAt: now, isApiConfig: true },
      { userId: LEAD_SUBMISSION_CLAIM_PARTITION, configId: 'leadSubmission:aa', status: 'completed', completedAt: now },
    ],
    LastEvaluatedKey: { userId: 'user_2', configId: 'c2' },
  },
  { Items: [{ userId: LEAD_SUBMISSION_CLAIM_PARTITION, configId: 'leadSubmission:bb', status: 'in_progress' }] },
];

// A faithful-enough server: applies the "userId <> :value" filter the real Scan would.
function serve(params: any, page: any) {
  const excluded = params.ExpressionAttributeValues?.[':leadSubmissionClaimPartition'];
  const Items = params.FilterExpression && excluded
    ? page.Items.filter((i: any) => i.userId !== excluded)
    : page.Items;
  return { ...page, Items };
}

beforeEach(() => {
  scanMock.mockReset();
  scanMock.mockImplementation(async (params: any) => {
    if (!params.TableName.endsWith('AW-Configs')) return { Items: [] };
    return serve(params, params.ExclusiveStartKey ? configsPages[1] : configsPages[0]);
  });
});

describe('getTaskAnalytics excludes lead-submission claims server-side', () => {
  it('filters the claim partition in every AW-Configs Scan page, preserving pagination', async () => {
    await taskDb.getTaskAnalytics('2000-01-01', '2999-01-01');
    const configScans = scanMock.mock.calls.map((c) => c[0]).filter((p) => p.TableName.endsWith('AW-Configs'));
    expect(configScans).toHaveLength(2);
    for (const p of configScans) {
      expect(p.FilterExpression).toBeDefined();
      expect(Object.values(p.ExpressionAttributeValues)).toContain(LEAD_SUBMISSION_CLAIM_PARTITION);
    }
    expect(configScans[1].ExclusiveStartKey).toEqual({ userId: 'user_2', configId: 'c2' });
  });

  it('claims are not counted as configs', async () => {
    const a: any = await taskDb.getTaskAnalytics('2000-01-01', '2999-01-01');
    expect(a.websiteConfigs).toBe(1);
    expect(a.apiConfigs).toBe(1);
    expect(a.newWebsiteConfigs).toBe(1);
  });

  it('other tables are scanned without a filter', async () => {
    await taskDb.getTaskAnalytics('2000-01-01', '2999-01-01');
    const others = scanMock.mock.calls.map((c) => c[0]).filter((p) => !p.TableName.endsWith('AW-Configs'));
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) expect(p.FilterExpression).toBeUndefined();
  });
});
