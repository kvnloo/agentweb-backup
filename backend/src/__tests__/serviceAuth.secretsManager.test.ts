/**
 * ENG-359 — Secrets Manager resolution path for the run-scheduled-chats
 * shared-secret middleware. The SM helper (`getSecret`) is mocked so these
 * tests never touch AWS.
 *
 * Behavioral contract (human-authored — DO NOT weaken):
 *   1. Env override unset + SM returns a secret → enforcement is ON: a request
 *      with no / wrong x-service-secret header is 401'd and next() is not
 *      called; the correct header calls next().
 *   2. Env override unset + SM returns nothing (no key), a non-JSON blob, or
 *      throws → fail-open: next() is called (never a 500) and a once-per-process
 *      warning is emitted.
 *   3. The SM read is cached: N requests within the TTL window trigger exactly
 *      one getSecret call; a read past the TTL re-reads; deleting the SM secret
 *      flips enforcement back to fail-open after the TTL (the rollback lever).
 *   4. The env override still wins over SM and performs no SM read.
 */

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
}));

import { Request, Response } from 'express';
import { getSecret } from '../utils/secretsManager';
import {
  requireScheduledChatsServiceSecret,
  SERVICE_SECRET_HEADER,
  SCHEDULED_CHATS_SERVICE_SECRET_ENV,
  SCHEDULED_CHATS_SERVICE_SECRET_SM_ID,
  SCHEDULED_CHATS_SERVICE_SECRET_SM_KEY,
  __resetScheduledChatsSecretCacheForTests,
} from '../middleware/serviceAuth';

const mockGetSecret = getSecret as jest.MockedFunction<typeof getSecret>;

function mockReqWithHeader(value?: string): Request {
  return {
    header: jest.fn((name: string) =>
      name.toLowerCase() === SERVICE_SECRET_HEADER ? value : undefined
    ),
  } as unknown as Request;
}

function mockRes(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
}

const SM_SECRET = 'sm-resolved-secret-value';
const smPayload = (value: string) =>
  JSON.stringify({ [SCHEDULED_CHATS_SERVICE_SECRET_SM_KEY]: value });

describe('requireScheduledChatsServiceSecret — Secrets Manager path (ENG-359)', () => {
  const originalEnv = process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV]; // force the SM path
    __resetScheduledChatsSecretCacheForTests();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];
    } else {
      process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV] = originalEnv;
    }
    jest.restoreAllMocks();
  });

  describe('env unset + SM returns a secret → enforcement ON', () => {
    beforeEach(() => {
      mockGetSecret.mockResolvedValue(smPayload(SM_SECRET));
    });

    it('reads from the prod/AgentWeb/ScheduledChatsServiceSecret id', async () => {
      await requireScheduledChatsServiceSecret(
        mockReqWithHeader(SM_SECRET),
        mockRes(),
        jest.fn()
      );
      expect(mockGetSecret).toHaveBeenCalledWith(SCHEDULED_CHATS_SERVICE_SECRET_SM_ID);
    });

    it('rejects a missing header: 401, next() never called', async () => {
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a wrong secret: 401, next() never called', async () => {
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader('not-the-secret'), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts the correct secret: next() called, response untouched', async () => {
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader(SM_SECRET), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('env unset + SM has no usable secret → fail-open', () => {
    it('SM returns an object without the key → next() + warns once', async () => {
      mockGetSecret.mockResolvedValue('{}');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const next1 = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), mockRes(), next1);
      expect(next1).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(SCHEDULED_CHATS_SERVICE_SECRET_SM_ID);

      // Second request within the TTL: still fails open, no repeat warning.
      const next2 = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), mockRes(), next2);
      expect(next2).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('SM read throws (as the real getSecret wraps it) → fail-open + warn once, never 500', async () => {
      // The real getSecret catches AWS errors and re-throws
      // `new Error('Failed to fetch secret: ...')` (dropping the AWS code), and
      // logs the underlying cause itself — so serviceAuth just fails open and
      // records the impact via its once-per-process warn.
      mockGetSecret.mockRejectedValue(
        new Error(`Failed to fetch secret: ${SCHEDULED_CHATS_SERVICE_SECRET_SM_ID}`)
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('SM returns a non-JSON blob → fail-open (no crash)', async () => {
      mockGetSecret.mockResolvedValue('not-json-at-all');
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader('whatever'), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('SM returns a blank value for the key → fail-open', async () => {
      mockGetSecret.mockResolvedValue(smPayload('   '));
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader('   '), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('SM returns an empty string → fail-open', async () => {
      mockGetSecret.mockResolvedValue('');
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader('x'), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('SM returns a JSON scalar (not an object) → fail-open', async () => {
      mockGetSecret.mockResolvedValue('"just-a-string"');
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader('x'), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('SM returns JSON null → fail-open', async () => {
      mockGetSecret.mockResolvedValue('null');
      const res = mockRes();
      const next = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader('x'), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('TTL cache', () => {
    it('reads SM exactly once across N requests within the window', async () => {
      mockGetSecret.mockResolvedValue(smPayload(SM_SECRET));

      for (let i = 0; i < 5; i++) {
        await requireScheduledChatsServiceSecret(
          mockReqWithHeader(SM_SECRET),
          mockRes(),
          jest.fn()
        );
      }
      expect(mockGetSecret).toHaveBeenCalledTimes(1);
    });

    it('de-dupes concurrent reads into a single getSecret call', async () => {
      let resolveGet: (v: string) => void = () => {};
      mockGetSecret.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveGet = resolve;
        })
      );

      const inFlight = [0, 1, 2].map(() =>
        requireScheduledChatsServiceSecret(mockReqWithHeader(SM_SECRET), mockRes(), jest.fn())
      );
      resolveGet(smPayload(SM_SECRET));
      await Promise.all(inFlight);

      expect(mockGetSecret).toHaveBeenCalledTimes(1);
    });

    it('re-reads SM after the TTL expires', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      mockGetSecret.mockResolvedValue(smPayload(SM_SECRET));

      nowSpy.mockReturnValue(0);
      await requireScheduledChatsServiceSecret(mockReqWithHeader(SM_SECRET), mockRes(), jest.fn());
      expect(mockGetSecret).toHaveBeenCalledTimes(1);

      // Within the TTL → served from cache.
      nowSpy.mockReturnValue(299_000);
      await requireScheduledChatsServiceSecret(mockReqWithHeader(SM_SECRET), mockRes(), jest.fn());
      expect(mockGetSecret).toHaveBeenCalledTimes(1);

      // Past the TTL → re-read.
      nowSpy.mockReturnValue(301_000);
      await requireScheduledChatsServiceSecret(mockReqWithHeader(SM_SECRET), mockRes(), jest.fn());
      expect(mockGetSecret).toHaveBeenCalledTimes(2);
    });

    it('deleting the SM secret flips enforcement back to fail-open after the TTL', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      // t=0: SM has the secret → enforcing (missing header → 401).
      nowSpy.mockReturnValue(0);
      mockGetSecret.mockResolvedValue(smPayload(SM_SECRET));
      const res1 = mockRes();
      const next1 = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), res1, next1);
      expect(res1.status).toHaveBeenCalledWith(401);
      expect(next1).not.toHaveBeenCalled();

      // Secret deleted from SM: the real getSecret surfaces this as a wrapped
      // `Failed to fetch secret` throw (ResourceNotFoundException → wrapped).
      mockGetSecret.mockRejectedValue(
        new Error(`Failed to fetch secret: ${SCHEDULED_CHATS_SERVICE_SECRET_SM_ID}`)
      );

      // Past the TTL → re-read → now fails open (rollback lever, no redeploy).
      nowSpy.mockReturnValue(301_000);
      const res2 = mockRes();
      const next2 = jest.fn();
      await requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), res2, next2);
      expect(next2).toHaveBeenCalledTimes(1);
      expect(res2.status).not.toHaveBeenCalled();
    });
  });

  describe('env override wins over Secrets Manager', () => {
    it('correct env secret → passes, and SM is never read', () => {
      process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV] = 'env-wins';
      const res = mockRes();
      const next = jest.fn();
      requireScheduledChatsServiceSecret(mockReqWithHeader('env-wins'), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(mockGetSecret).not.toHaveBeenCalled();
    });

    it('env set + wrong header → 401 without any SM read', () => {
      process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV] = 'env-wins';
      const res = mockRes();
      const next = jest.fn();
      requireScheduledChatsServiceSecret(mockReqWithHeader('bad'), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
      expect(mockGetSecret).not.toHaveBeenCalled();
    });
  });
});
