/**
 * ENG-1793 fresh-eyes follow-up: modifyWorkPlan's fix calls
 * chatbotDb.getChatSession(sessionId, true) claiming the strongly-consistent
 * read protects it from missing a same-turn requiredFunctionCalls failure.
 * That claim was false — getChatSessionRecord (the call that actually reads
 * workPlan/calledFunctions/failedFunctions off the AW-ChatSessions record)
 * never accepted a consistentRead parameter, so the flag only ever reached
 * the unrelated AW-ChatMessages read in getMessagesFromMessagesTable.
 *
 * These tests exercise the real chatbotDb.getChatSessionRecord /
 * getChatSession implementations against a mocked dynamodb.get and assert
 * `ConsistentRead: true` actually appears in the params sent to DynamoDB —
 * not just that some mock was called with a `true` argument.
 */

const getPromiseMock = jest.fn();
const queryPromiseMock = jest.fn();
const getParamsSpy = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn((params: any) => {
        getParamsSpy(params);
        return { promise: () => getPromiseMock(params) };
      }),
      query: jest.fn(() => ({ promise: queryPromiseMock })),
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

const mockSessionId = 'sess-consistent-read-1';

describe('chatbotService - getChatSessionRecord / getChatSession consistentRead (ENG-1793 follow-up)', () => {
  beforeEach(() => {
    getPromiseMock.mockReset();
    queryPromiseMock.mockReset();
    getParamsSpy.mockReset();
    getPromiseMock.mockResolvedValue({ Item: { sessionId: mockSessionId, workPlan: { title: 'p', steps: [] } } });
    queryPromiseMock.mockResolvedValue({ Items: [] });
  });

  describe('getChatSessionRecord', () => {
    it('omits ConsistentRead by default (preserves prior eventually-consistent behavior)', async () => {
      await chatbotDb.getChatSessionRecord(mockSessionId);

      expect(getParamsSpy).toHaveBeenCalledTimes(1);
      const params = getParamsSpy.mock.calls[0][0];
      expect(params.ConsistentRead).toBeUndefined();
    });

    it('passes ConsistentRead: true to dynamodb.get when consistentRead=true', async () => {
      await chatbotDb.getChatSessionRecord(mockSessionId, true);

      expect(getParamsSpy).toHaveBeenCalledTimes(1);
      const params = getParamsSpy.mock.calls[0][0];
      expect(params).toMatchObject({
        TableName: expect.any(String),
        Key: { sessionId: mockSessionId },
        ConsistentRead: true,
      });
    });

    it('omits ConsistentRead when explicitly false', async () => {
      await chatbotDb.getChatSessionRecord(mockSessionId, false);

      const params = getParamsSpy.mock.calls[0][0];
      expect(params.ConsistentRead).toBeUndefined();
    });
  });

  describe('getChatSession', () => {
    it('threads consistentRead=true through to the underlying AW-ChatSessions dynamodb.get, not just the messages-table read', async () => {
      await chatbotDb.getChatSession(mockSessionId, true);

      // The session-record read (AW-ChatSessions) must itself be strongly consistent —
      // this is the read that surfaces workPlan/calledFunctions/failedFunctions, which
      // is what modifyWorkPlan's ENG-1793 fix actually depends on.
      expect(getParamsSpy).toHaveBeenCalledTimes(1);
      const params = getParamsSpy.mock.calls[0][0];
      expect(params.ConsistentRead).toBe(true);
    });

    it('defaults to eventually-consistent (no ConsistentRead) when called with no second argument', async () => {
      await chatbotDb.getChatSession(mockSessionId);

      const params = getParamsSpy.mock.calls[0][0];
      expect(params.ConsistentRead).toBeUndefined();
    });
  });
});
