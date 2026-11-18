/**
 * ENG-2816 (step 3): a share-link visitor must not be able to stop the OWNER's running turn.
 *
 * `POST /ishare/:id/stop` used to cancel the whole session for anyone holding the share token (ENG-2644 made it check the token).
 * A share link runs the visitor's turn inside the owner's own session, so "cancel the session" also cancelled the owner's turn.
 * Now a share-token stop cancels only when
 *  - the request carries the owner's own login (a real one: not a colleague, not a delegate, not a service token), OR
 *  - the turn that is running was started through a share route by a visitor (the in-process marker, set where the share turn's
 *    generation lock is claimed and cleared when it is released).
 * A stop that is ignored answers the SAME `200 {success: true}` (nothing to learn from it), and must neither mark the progress
 * complete nor leave a cancel flag behind that would cancel the NEXT turn.
 *
 * Mounts the REAL routes/agentMode.ts router, the REAL agentModeController and the REAL ChatbotDB over an in-memory DocumentClient.
 */
import express from 'express';
import request from 'supertest';
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';

const mockFake = new BranchFakeDynamo();

jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  return {
    ...actual,
    DynamoDB: Object.assign(function DynamoDB() { return {}; }, actual.DynamoDB, {
      DocumentClient: jest.fn(() => mockFake.client()),
    }),
  };
});

// Only the login check is replaced; the rest of the auth module stays real for the router.
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  getUserFromToken: jest.fn(),
}));

const mockCancelSession = jest.fn();
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), releaseSessionClients: jest.fn(), cancelSession: (...a: unknown[]) => mockCancelSession(...a) },
}));

import agentModeRoutes from '../routes/agentMode';
import { getUserFromToken } from '../middleware/auth';
import { isCancelled, clearCancel, progressStore, registerProgressCallback } from '../utils/sseProgress';
import { markShareVisitorTurn, clearShareVisitorTurn, isShareVisitorTurn } from '../services/shareVisitorTurnMarker';
import { tryClaimSessionGeneration, releaseSessionGeneration } from '../controllers/agentModeController';

const mockGetUserFromToken = getUserFromToken as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/agent-mode', agentModeRoutes);

const SESSION_ID = 's-owner';
const OWNER_ID = 'owner';
const SEEDED_SESSION = {
  sessionId: SESSION_ID, userId: OWNER_ID, title: 'Owner chat', portalType: 'agent', sessionType: 'regular',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', messageCount: 0, messages: [],
  interactiveShareMetadata: { isActive: true, token: 'TOK', sharedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
};

const stop = (token = 'TOK', authorization?: string) => {
  const req = request(app).post(`/api/agent-mode/ishare/${SESSION_ID}/stop?conversable=${token}`);
  return authorization ? req.set('Authorization', authorization) : req;
};
/** What the owner's live progress stream hears: a stop that is ignored must not tell it the turn is complete (markProgressComplete does). */
let progressEvents: Array<{ status: string }> = [];
let stopListening: () => void = () => undefined;
const progressCompleted = () => progressEvents.some((event) => event.status === 'complete');

beforeEach(() => {
  mockFake.tables.clear();
  mockFake.writeLog.length = 0;
  mockFake.getLog.length = 0;
  mockFake.seedSession(SEEDED_SESSION);
  mockCancelSession.mockReset();
  mockGetUserFromToken.mockReset().mockResolvedValue({ user: null });
  clearCancel(SESSION_ID);
  progressStore.delete(SESSION_ID);
  clearShareVisitorTurn(SESSION_ID);
  releaseSessionGeneration(SESSION_ID);
  progressEvents = [];
  stopListening = registerProgressCallback(SESSION_ID, (progress) => progressEvents.push(progress));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  stopListening();
  clearShareVisitorTurn(SESSION_ID);
  releaseSessionGeneration(SESSION_ID);
  jest.restoreAllMocks();
});

describe('POST /ishare/:id/stop: who may cancel a running turn (ENG-2816 step 3)', () => {
  describe('a visitor (the share token, no login)', () => {
    it('stops a turn that a VISITOR started through a share route', async () => {
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      markShareVisitorTurn(SESSION_ID);

      const res = await stop();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(isCancelled(SESSION_ID)).toBe(true);
      expect(mockCancelSession).toHaveBeenCalledWith(SESSION_ID);
      // ...and tells the progress stream the turn is over, as it always did (so the check below is not vacuous).
      expect(progressCompleted()).toBe(true);
    });

    it('CANNOT stop the owner\'s turn: it answers the same 200, cancels nothing, and leaves no cancel flag behind', async () => {
      // The owner's own turn holds the session lock; no share route marked it a visitor's.
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);

      const res = await stop();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(isCancelled(SESSION_ID)).toBe(false);
      expect(mockCancelSession).not.toHaveBeenCalled();
      expect(progressCompleted()).toBe(false);
    });

    it('cannot stop a turn that did not come through a share route at all (a scheduled run, an owner /generate)', async () => {
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      expect(isShareVisitorTurn(SESSION_ID)).toBe(false);
      await stop();
      expect(isCancelled(SESSION_ID)).toBe(false);
      expect(mockCancelSession).not.toHaveBeenCalled();
    });

    it('with NOTHING running, an ignored stop does not leave a stale cancel flag that would cancel the next turn', async () => {
      const res = await stop();
      expect(res.body).toEqual({ success: true });
      expect(isCancelled(SESSION_ID)).toBe(false);
      expect(mockCancelSession).not.toHaveBeenCalled();
    });

    it('an ignored stop does not mark the progress complete (the owner\'s live stream is untouched)', async () => {
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      await stop();
      expect(progressCompleted()).toBe(false);
    });

    it('answers an ignored stop and a real one identically (nothing for a visitor to learn from it)', async () => {
      const ignored = await stop();
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      markShareVisitorTurn(SESSION_ID);
      const real = await stop();
      expect({ status: ignored.status, body: ignored.body }).toEqual({ status: real.status, body: real.body });
    });

    it('once the visitor\'s turn ends (lock released) a later stop is ignored again', async () => {
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      markShareVisitorTurn(SESSION_ID);
      releaseSessionGeneration(SESSION_ID);
      expect(isShareVisitorTurn(SESSION_ID)).toBe(false);
      await stop();
      expect(isCancelled(SESSION_ID)).toBe(false);
    });
  });

  describe('the owner\'s own login on their share link', () => {
    const ownerLogin = () => mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER_ID }, decoded: { userId: OWNER_ID } });

    it('stops their own turn, whatever is running', async () => {
      ownerLogin();
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID); // an owner turn: no visitor marker
      const res = await stop('TOK', 'Bearer owner.jwt');
      expect(res.body).toEqual({ success: true });
      expect(isCancelled(SESSION_ID)).toBe(true);
      expect(mockCancelSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it('stops a visitor\'s turn too', async () => {
      ownerLogin();
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      markShareVisitorTurn(SESSION_ID);
      await stop('TOK', 'Bearer owner.jwt');
      expect(isCancelled(SESSION_ID)).toBe(true);
    });

    it('still needs the share token: the owner\'s login does not replace it', async () => {
      ownerLogin();
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      const res = await stop('wrong-token', 'Bearer owner.jwt');
      expect(res.status).toBe(401);
      expect(isCancelled(SESSION_ID)).toBe(false);
    });
  });

  describe('anything that is not the owner\'s own login is a visitor, and never an error', () => {
    it.each([
      ['a colleague\'s login', { user: { userId: 'colleague' }, decoded: { userId: 'colleague' } }],
      ['an admin delegate token for the owner', { user: { userId: OWNER_ID }, decoded: { userId: 'admin', delegateAccess: { adminUserId: 'admin', targetUserId: OWNER_ID } } }],
      ['a service self-call token', { user: { userId: OWNER_ID }, decoded: { userId: OWNER_ID, _svc: true } }],
      ['an invalid or expired login', { user: null }],
    ])('%s cannot stop the owner\'s turn', async (_name, auth) => {
      mockGetUserFromToken.mockResolvedValue(auth);
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      const res = await stop('TOK', 'Bearer something.jwt');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(isCancelled(SESSION_ID)).toBe(false);
    });

    it('but can stop a visitor\'s turn like any other visitor', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: { userId: 'colleague' }, decoded: { userId: 'colleague' } });
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      markShareVisitorTurn(SESSION_ID);
      await stop('TOK', 'Bearer colleague.jwt');
      expect(isCancelled(SESSION_ID)).toBe(true);
    });
  });

  describe('the link checks of ENG-2644 are unchanged and come first', () => {
    it('refuses a wrong token with 401, an expired share with 410, and a missing session with 404, whatever is running', async () => {
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      markShareVisitorTurn(SESSION_ID);
      expect((await stop('nope')).status).toBe(401);
      mockFake.seedSession({ ...SEEDED_SESSION, interactiveShareMetadata: { ...SEEDED_SESSION.interactiveShareMetadata, expiresAt: '2020-01-01T00:00:00.000Z' } });
      expect((await stop()).status).toBe(410);
      expect((await request(app).post('/api/agent-mode/ishare/missing/stop?conversable=TOK')).status).toBe(404);
      expect(isCancelled(SESSION_ID)).toBe(false);
    });
  });
});
