/**
 * ENG-1819 review follow-up: getMostRecentRealUserMessage (used by the work-plan
 * auto-continuation stop-check) must correctly exclude every known server-authored
 * `role: 'user'` message kind and must not silently give up on a tool-call-heavy
 * round that exhausts a single page before reaching the real user turn underneath it.
 *
 * These tests exercise the real chatbotDb.getMostRecentRealUserMessage implementation
 * against a mocked dynamodb.query and assert the actual params sent to DynamoDB
 * (ScanIndexForward, Limit, ExclusiveStartKey, ConsistentRead) — not just that some
 * mock resolved a plausible-looking value.
 */

const queryPromiseMock = jest.fn();
const queryParamsSpy = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Item: null }) })),
      query: jest.fn((params: any) => {
        queryParamsSpy(params);
        return { promise: () => queryPromiseMock(params) };
      }),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({ upload: jest.fn().mockReturnThis(), promise: jest.fn().mockResolvedValue({}) })),
  config: { update: jest.fn() },
}));

jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));

import { chatbotDb } from '../services/chatbotService';

const mockSessionId = 'sess-most-recent-real-user-1';

const item = (role: string, content: string, metadata: any = {}) => ({
  message: { role, content, metadata },
});

describe('chatbotService.getMostRecentRealUserMessage (ENG-1819)', () => {
  beforeEach(() => {
    queryPromiseMock.mockReset();
    queryParamsSpy.mockReset();
  });

  it('returns the most recent genuine user message', async () => {
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        item('assistant', 'Report generated.'),
        item('user', 'please stop for now'),
        item('assistant', 'Working on it.'),
      ],
    });

    const result = await chatbotDb.getMostRecentRealUserMessage(mockSessionId);

    expect(result).toEqual({ content: 'please stop for now', timestamp: undefined });
    const params = queryParamsSpy.mock.calls[0][0];
    expect(params).toMatchObject({
      TableName: expect.any(String),
      KeyConditionExpression: 'sessionId = :sessionId',
      ScanIndexForward: false,
      Limit: 25,
    });
    expect(params.ExclusiveStartKey).toBeUndefined();
    expect(params.ConsistentRead).toBeUndefined();
  });

  it('excludes the server-injected auto-continuation directive', async () => {
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        item('user', '[SYSTEM] This is an automatic continuation...', { kind: 'auto-continuation' }),
        item('user', 'the real instruction'),
      ],
    });

    const result = await chatbotDb.getMostRecentRealUserMessage(mockSessionId);

    expect(result?.content).toBe('the real instruction');
  });

  it('excludes the runVerifiedChat auto-delegated-answer breadcrumb (no kind field at all)', async () => {
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        item('user', '[Full autonomy] Proceed with "Option A".', { autoDelegatedAnswer: true, questionId: 'q1' }),
        item('user', 'stop, do not do any more work'),
      ],
    });

    const result = await chatbotDb.getMostRecentRealUserMessage(mockSessionId);

    expect(result?.content).toBe('stop, do not do any more work');
  });

  it('paginates past a page fully exhausted by tool-call rows to find the real user message underneath', async () => {
    // Page 1: 25 assistant/tool-call rows from one tool-call-heavy round, no user message at all.
    const page1Items = Array.from({ length: 25 }, (_, i) => item('assistant', `tool call result ${i}`));
    queryPromiseMock
      .mockResolvedValueOnce({ Items: page1Items, LastEvaluatedKey: { sessionId: mockSessionId, messageIndex: 10 } })
      .mockResolvedValueOnce({ Items: [item('user', 'stop, that is enough')] });

    const result = await chatbotDb.getMostRecentRealUserMessage(mockSessionId);

    expect(result?.content).toBe('stop, that is enough');
    expect(queryParamsSpy).toHaveBeenCalledTimes(2);
    expect(queryParamsSpy.mock.calls[0][0].ExclusiveStartKey).toBeUndefined();
    expect(queryParamsSpy.mock.calls[1][0].ExclusiveStartKey).toEqual({ sessionId: mockSessionId, messageIndex: 10 });
  });

  it('gives up after MAX_PAGES and returns null rather than paginating forever', async () => {
    queryPromiseMock.mockImplementation(() =>
      Promise.resolve({ Items: [item('assistant', 'x')], LastEvaluatedKey: { sessionId: mockSessionId, messageIndex: 1 } })
    );

    const result = await chatbotDb.getMostRecentRealUserMessage(mockSessionId);

    expect(result).toBeNull();
    // Bounded — must not follow LastEvaluatedKey indefinitely.
    expect(queryParamsSpy.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('stops paginating (does not call again) once a page has no LastEvaluatedKey', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [item('assistant', 'x')] }); // no LastEvaluatedKey

    const result = await chatbotDb.getMostRecentRealUserMessage(mockSessionId);

    expect(result).toBeNull();
    expect(queryParamsSpy).toHaveBeenCalledTimes(1);
  });

  it('passes ConsistentRead: true through to every page when requested', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [item('user', 'hello')] });

    await chatbotDb.getMostRecentRealUserMessage(mockSessionId, true);

    expect(queryParamsSpy.mock.calls[0][0]).toMatchObject({ ConsistentRead: true });
  });

  it('returns null (fails safe) when the query itself throws', async () => {
    queryPromiseMock.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await chatbotDb.getMostRecentRealUserMessage(mockSessionId);

    expect(result).toBeNull();
    consoleErrorSpy.mockRestore();
  });
});
