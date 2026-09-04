/**
 * ENG-1698 hardening: calledFunctions writers (reset on new plan, increment on
 * tool dispatch, clamped decrement on step completion/skip) used independent
 * read-modify-write DynamoDB calls with no concurrency guard, so a writer
 * computing its value from a stale read could silently undo a concurrent
 * writer's change. mutateCalledFunctions adds optimistic locking on
 * calledFunctionsVersion: a conflicting concurrent write must make this
 * writer retry against fresh state, not clobber it.
 */

const getPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn(() => ({ promise: getPromiseMock })),
      update: jest.fn((params: any) => ({ promise: () => updatePromiseMock(params) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
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

const mockSessionId = 'sess-lock-1';

function conditionalCheckFailedError() {
  const err: any = new Error('The conditional request failed');
  err.code = 'ConditionalCheckFailedException';
  return err;
}

describe('chatbotService - calledFunctions optimistic locking (ENG-1698)', () => {
  beforeEach(() => {
    getPromiseMock.mockReset();
    updatePromiseMock.mockReset();
  });

  it('retries against a freshly-read state when a concurrent writer wins the race', async () => {
    // First read: stale state before a concurrent writer's reset lands.
    getPromiseMock
      .mockResolvedValueOnce({
        Item: { sessionId: mockSessionId, calledFunctions: { generate_image: 5 }, calledFunctionsVersion: 3 },
      })
      // Second read (after conflict): concurrent writer already reset + bumped version.
      .mockResolvedValueOnce({
        Item: { sessionId: mockSessionId, calledFunctions: {}, calledFunctionsVersion: 4 },
      });

    // First write attempt loses the race (version moved under it).
    updatePromiseMock
      .mockRejectedValueOnce(conditionalCheckFailedError())
      .mockResolvedValueOnce({
        Attributes: { sessionId: mockSessionId, calledFunctions: { you_search_web: 2 }, calledFunctionsVersion: 5 },
      });

    const result = await chatbotDb.incrementCalledFunctions(mockSessionId, { you_search_web: 2 });

    expect(getPromiseMock).toHaveBeenCalledTimes(2);
    expect(updatePromiseMock).toHaveBeenCalledTimes(2);

    // Second attempt must recompute from the FRESH (post-reset) baseline, not
    // merge the stale generate_image:5 the first read saw.
    const secondAttemptParams = updatePromiseMock.mock.calls[1][0];
    expect(secondAttemptParams.ExpressionAttributeValues[':calledFunctions']).toEqual({ you_search_web: 2 });
    expect(secondAttemptParams.ExpressionAttributeValues[':currentVersion']).toBe(4);
    expect(secondAttemptParams.ExpressionAttributeValues[':nextVersion']).toBe(5);

    expect(result.calledFunctions).toEqual({ you_search_web: 2 });
  });

  it('a reset landing after a concurrent increment read does not get silently overwritten back to stale data', async () => {
    // Simulates: increment reads first (sees old plan's leftover credit),
    // reset (from a new plan launch) commits in between, increment's write
    // then conflicts and must retry against the reset's cleared state.
    getPromiseMock
      .mockResolvedValueOnce({
        Item: { sessionId: mockSessionId, calledFunctions: { generate_image: 5 }, calledFunctionsVersion: 1 },
      })
      .mockResolvedValueOnce({
        Item: { sessionId: mockSessionId, calledFunctions: {}, calledFunctionsVersion: 2 },
      });

    updatePromiseMock
      .mockRejectedValueOnce(conditionalCheckFailedError())
      .mockResolvedValueOnce({
        Attributes: { sessionId: mockSessionId, calledFunctions: { generate_image: 1 }, calledFunctionsVersion: 3 },
      });

    const result = await chatbotDb.incrementCalledFunctions(mockSessionId, { generate_image: 1 });

    // Final persisted state reflects the NEW plan's own single call, not
    // 5 (stale) + 1 = 6 -- the old credit must not resurrect.
    expect(result.calledFunctions).toEqual({ generate_image: 1 });
  });

  it('decrementCalledFunctionsClamped clamps at 0 even when retrying against a fresh read', async () => {
    getPromiseMock.mockResolvedValueOnce({
      Item: { sessionId: mockSessionId, calledFunctions: { generate_image: 0 }, calledFunctionsVersion: 7 },
    });
    updatePromiseMock.mockResolvedValueOnce({
      Attributes: { sessionId: mockSessionId, calledFunctions: { generate_image: 0 }, calledFunctionsVersion: 8 },
    });

    await chatbotDb.decrementCalledFunctionsClamped(mockSessionId, { generate_image: 1 });

    const params = updatePromiseMock.mock.calls[0][0];
    expect(params.ExpressionAttributeValues[':calledFunctions']).toEqual({ generate_image: 0 });
  });

  it('gives up after exhausting retries on persistent conflicts', async () => {
    getPromiseMock.mockResolvedValue({
      Item: { sessionId: mockSessionId, calledFunctions: {}, calledFunctionsVersion: 1 },
    });
    updatePromiseMock.mockRejectedValue(conditionalCheckFailedError());

    await expect(
      chatbotDb.mutateCalledFunctions(mockSessionId, (current) => ({ ...current, x: 1 }), 3)
    ).rejects.toThrow('The conditional request failed');

    expect(updatePromiseMock).toHaveBeenCalledTimes(3);
  });
});
