/**
 * Behavioral contract for getUserSessions' scheduled-vs-live filtering.
 *
 * Context: the Emma/AgentMode chat-history sidebar pulls one recency-sorted
 * page of sessions and slices Live vs Scheduled client-side. Scheduled cron
 * runs (sessionType === 'scheduled') update daily, so they flood the top of
 * the list and starve the Live tab. The fix is to let the caller ask the DB
 * to exclude (Live tab) or isolate (Scheduled tab) scheduled sessions, so a
 * page comes back already containing the rows that tab wants.
 *
 * These assertions verify the QUERY we send to DynamoDB (the real contract),
 * not that a mock honors the filter — DynamoDB applies FilterExpression
 * server-side, so testing "returned rows are filtered" against a mock would
 * be tautological.
 */

const mockQuery = jest.fn();
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: mockQuery,
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

import { chatbotDb } from '../services/chatbotService';

function makeQueryResult(sessions: any[] = []) {
  return {
    promise: jest.fn().mockResolvedValue({ Items: sessions, LastEvaluatedKey: undefined }),
  };
}

describe('chatbotService.getUserSessions scheduled filter', () => {
  beforeEach(() => jest.clearAllMocks());

  // --- CONTRACT / FAIL CASES ---

  test('omits any sessionType clause when no sessionTypeFilter is given (back-compat)', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true);

    const { FilterExpression = '', ExpressionAttributeValues = {} } = mockQuery.mock.calls[0][0];
    expect(FilterExpression).not.toContain('sessionType');
    expect(ExpressionAttributeValues).not.toHaveProperty(':scheduledSessionType');
  });

  test('exclude-scheduled does NOT use an exact-equality match on scheduled (would invert the filter)', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, undefined, 'exclude-scheduled');

    const { FilterExpression } = mockQuery.mock.calls[0][0];
    // must be a "not equal" exclusion, never "sessionType = scheduled"
    expect(FilterExpression).not.toMatch(/sessionType\s*=\s*:scheduledSessionType/);
  });

  test('exclude-scheduled KEEPS legacy sessions that have no sessionType attribute', async () => {
    // The 500+ pre-sessionType sessions are non-scheduled and MUST stay visible
    // in Live. A bare `sessionType <> 'scheduled'` filter would silently drop
    // items where the attribute is absent, so attribute_not_exists is required.
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, undefined, 'exclude-scheduled');

    const { FilterExpression } = mockQuery.mock.calls[0][0];
    expect(FilterExpression).toContain('attribute_not_exists(sessionType)');
  });

  // --- SUCCESS CASES ---

  test('exclude-scheduled adds a not-scheduled clause with the scheduled value bound', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, undefined, 'exclude-scheduled');

    const { FilterExpression, ExpressionAttributeValues } = mockQuery.mock.calls[0][0];
    expect(FilterExpression).toContain('sessionType <> :scheduledSessionType');
    expect(ExpressionAttributeValues[':scheduledSessionType']).toBe('scheduled');
  });

  test('only-scheduled isolates scheduled sessions via exact equality', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, undefined, 'only-scheduled');

    const { FilterExpression, ExpressionAttributeValues } = mockQuery.mock.calls[0][0];
    expect(FilterExpression).toContain('sessionType = :scheduledSessionType');
    expect(ExpressionAttributeValues[':scheduledSessionType']).toBe('scheduled');
  });

  test('combines the scheduled filter with portalType using AND', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, undefined, 'exclude-scheduled');

    const { FilterExpression } = mockQuery.mock.calls[0][0];
    expect(FilterExpression).toContain('portalType = :portalType');
    expect(FilterExpression).toContain(' AND ');
  });
});
