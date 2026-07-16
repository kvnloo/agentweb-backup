/**
 * ENG-347 — unit tests for the shared-secret middleware guarding
 * POST /api/agent-mode/run-scheduled-chats.
 *
 * Behavioral contract (from the Linear issue, human-reviewed):
 *   1. Without a valid credential the request is rejected with 401 and
 *      nothing downstream executes (next() is never called).
 *   2. With the shared secret header the request passes through unchanged.
 *
 * Rollout behavior (fail-open by design, see middleware doc comment):
 *   When SCHEDULED_CHATS_SERVICE_SECRET is unset, requests pass through
 *   (pre-ENG-347 behavior) so the backend's daily auto-deploy cannot break
 *   the manually-deployed agent-engine. Enforcement starts when the env var
 *   is set.
 */
import { Request, Response } from 'express';
import {
  requireScheduledChatsServiceSecret,
  SERVICE_SECRET_HEADER,
  SCHEDULED_CHATS_SERVICE_SECRET_ENV,
} from '../middleware/serviceAuth';

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

describe('requireScheduledChatsServiceSecret (ENG-347)', () => {
  const SECRET = 'correct-horse-battery-staple';
  const originalValue = process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];
    } else {
      process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV] = originalValue;
    }
    jest.restoreAllMocks();
  });

  describe('when the env secret is set (enforcement on)', () => {
    beforeEach(() => {
      process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV] = SECRET;
    });

    it('rejects a request with no secret header: 401, next() never called', () => {
      const res = mockRes();
      const next = jest.fn();

      requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a wrong secret of the same length: 401, next() never called', () => {
      const res = mockRes();
      const next = jest.fn();
      const wrongSameLength = SECRET.slice(0, -1) + 'X';

      requireScheduledChatsServiceSecret(mockReqWithHeader(wrongSameLength), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a wrong secret of a different length: 401 (timing-safe length-mismatch path)', () => {
      const res = mockRes();
      const next = jest.fn();

      requireScheduledChatsServiceSecret(mockReqWithHeader('short'), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects an empty secret header: 401, next() never called', () => {
      const res = mockRes();
      const next = jest.fn();

      requireScheduledChatsServiceSecret(mockReqWithHeader(''), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts the correct secret: next() called, response untouched', () => {
      const res = mockRes();
      const next = jest.fn();

      requireScheduledChatsServiceSecret(mockReqWithHeader(SECRET), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('when the env secret is unset (pre-rollout, fail-open by design)', () => {
    beforeEach(() => {
      delete process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];
    });

    it('passes the request through and warns exactly once per process', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const next1 = jest.fn();
      const res1 = mockRes();
      requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), res1, next1);
      expect(next1).toHaveBeenCalledTimes(1);
      expect(res1.status).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(SCHEDULED_CHATS_SERVICE_SECRET_ENV);

      // Second unauthenticated request: still passes, but no repeat warning
      // (agent-engine polls this endpoint continuously — no log flooding).
      const next2 = jest.fn();
      requireScheduledChatsServiceSecret(mockReqWithHeader(undefined), mockRes(), next2);
      expect(next2).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
