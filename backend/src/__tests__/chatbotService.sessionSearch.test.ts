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

describe('chatbotService.getUserSessions search filter', () => {
  beforeEach(() => jest.clearAllMocks());

  // --- FAIL CASES ---

  test('does not include summary in filter expression when no searchTerm', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true);

    const callParams = mockQuery.mock.calls[0][0];
    expect(callParams.FilterExpression ?? '').not.toContain('sessionSummary');
    expect(callParams.FilterExpression ?? '').not.toContain(':searchTerm');
  });

  test('does not search summary when searchTerm is empty string', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, '');

    const callParams = mockQuery.mock.calls[0][0];
    // empty string is falsy — no filter should be added
    expect(callParams.FilterExpression).not.toContain('sessionSummary');
  });

  // --- SUCCESS CASES ---

  test('includes title AND summary OR clause in FilterExpression when searchTerm provided', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, 'reCAPTCHA');

    const callParams = mockQuery.mock.calls[0][0];
    expect(callParams.FilterExpression).toContain('contains(#title, :searchTerm)');
    expect(callParams.FilterExpression).toContain('contains(sessionSummary.#summary, :searchTerm)');
    expect(callParams.ExpressionAttributeNames['#title']).toBe('title');
    expect(callParams.ExpressionAttributeNames['#summary']).toBe('summary');
    expect(callParams.ExpressionAttributeValues[':searchTerm']).toBe('reCAPTCHA');
  });

  test('OR-joins title and summary so either match returns the session', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, undefined, 'marketing');

    const { FilterExpression } = mockQuery.mock.calls[0][0];
    // The two contains() calls must be joined with OR (not AND)
    expect(FilterExpression).toMatch(/contains\(#title.*OR.*contains\(sessionSummary/);
  });

  test('combines search filter with other filters using AND', async () => {
    mockQuery.mockReturnValue(makeQueryResult([]));

    await chatbotDb.getUserSessions('user-1', 'agent', 50, true, undefined, 'agent-mode', 'report');

    const { FilterExpression } = mockQuery.mock.calls[0][0];
    // portalType filter AND the search OR-group
    expect(FilterExpression).toContain('portalType = :portalType');
    expect(FilterExpression).toContain('AND');
    expect(FilterExpression).toContain('contains(#title, :searchTerm)');
    expect(FilterExpression).toContain('contains(sessionSummary.#summary, :searchTerm)');
  });
});
