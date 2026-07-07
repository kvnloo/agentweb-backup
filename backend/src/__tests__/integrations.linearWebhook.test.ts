/**
 * Linear webhook -> resolve bridge (ENG-222).
 *
 * Contract under test — customer comms fire ONLY on the transition INTO the configured Done state:
 *   - completed-type states that are NOT Done (Merged, Verifying) fire nothing
 *   - an edit (title/label) on an already-Done issue (`updatedFrom` has no stateId) fires nothing
 *   - `action:'create'` fires nothing
 *   - the transition into Done (updatedFrom.stateId present, != Done; new state = Done) fires the
 *     resolve bridge exactly once
 *   - a completed-type state whose ID is not the configured Done ID fires nothing
 *   - missing LINEAR_DONE_STATE_ID fails loud (200 ok:false, distinct error), never fires
 *   - HMAC-SHA256 `linear-signature` enforced when LINEAR_WEBHOOK_SECRET is set
 *   - handler errors return 200 (never let Linear retry-storm on our own errors)
 */
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';

jest.mock('../services/intakeService', () => ({
  notifyCanonicalResolved: jest.fn().mockResolvedValue({ ticketNumbers: [1, 2] }),
}));

import integrationsRouter from '../routes/integrations';
const intake = require('../services/intakeService');

const app = express();
// Mirror app.ts: raw body for the linear webhook path, json elsewhere.
app.use('/api/integrations/linear/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/integrations', integrationsRouter);

const DONE_STATE_ID = 'b36918be-3026-4a37-b788-47eef453a581';
const MERGED_STATE_ID = '11111111-1111-1111-1111-111111111111';
const PATH = '/api/integrations/linear/webhook';

/** A transition INTO Done: state is Done and updatedFrom carries the prior (non-Done) stateId. */
function transitionIntoDone(overrides: Record<string, any> = {}): any {
  return {
    type: 'Issue',
    action: 'update',
    data: {
      id: 'issue-1',
      title: 'A customer bug',
      state: { id: DONE_STATE_ID, name: 'Done', type: 'completed' },
    },
    updatedFrom: { stateId: MERGED_STATE_ID },
    ...overrides,
  };
}

async function post(
  body: any,
  opts: { secret?: string; sig?: string } = {},
): Promise<request.Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  let req = request(app).post(PATH).set('Content-Type', 'application/json');
  if (opts.secret !== undefined) {
    const sig =
      opts.sig ?? crypto.createHmac('sha256', opts.secret).update(raw).digest('hex');
    req = req.set('linear-signature', sig);
  } else if (opts.sig) {
    req = req.set('linear-signature', opts.sig);
  }
  return req.send(raw);
}

const realSecret = process.env.LINEAR_WEBHOOK_SECRET;
const realDoneId = process.env.LINEAR_DONE_STATE_ID;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINEAR_WEBHOOK_SECRET;
  process.env.LINEAR_DONE_STATE_ID = DONE_STATE_ID;
});
afterAll(() => {
  if (realSecret === undefined) delete process.env.LINEAR_WEBHOOK_SECRET;
  else process.env.LINEAR_WEBHOOK_SECRET = realSecret;
  if (realDoneId === undefined) delete process.env.LINEAR_DONE_STATE_ID;
  else process.env.LINEAR_DONE_STATE_ID = realDoneId;
});

describe('POST /api/integrations/linear/webhook — Done-only transition gating', () => {
  it('AC3: transition into Done fires the resolve bridge exactly once', async () => {
    const res = await post(transitionIntoDone());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledWith('issue-1', 'A customer bug');
  });

  it('AC1: moving into Merged (started type) fires zero customer comms', async () => {
    const res = await post({
      type: 'Issue',
      action: 'update',
      data: { id: 'issue-1', title: 'x', state: { id: MERGED_STATE_ID, name: 'Merged', type: 'started' } },
      updatedFrom: { stateId: 'some-backlog-id' },
    });
    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('AC1: moving into Verifying (completed type, non-Done ID) fires nothing', async () => {
    const res = await post({
      type: 'Issue',
      action: 'update',
      data: {
        id: 'issue-1',
        title: 'x',
        state: { id: 'verifying-state-id', name: 'Verifying', type: 'completed' },
      },
      updatedFrom: { stateId: MERGED_STATE_ID },
    });
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('AC2: a title edit on an already-Done issue (no stateId in updatedFrom) fires nothing', async () => {
    const res = await post(
      transitionIntoDone({ updatedFrom: { title: 'old title' } }),
    );
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('AC2: an update with no updatedFrom at all fires nothing', async () => {
    const ev = transitionIntoDone();
    delete ev.updatedFrom;
    const res = await post(ev);
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('action:create for a Done-state issue fires nothing (not a transition)', async () => {
    const res = await post(transitionIntoDone({ action: 'create', updatedFrom: undefined }));
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('AC4: a completed-type state whose ID is not the configured Done ID fires nothing', async () => {
    const res = await post({
      type: 'Issue',
      action: 'update',
      data: {
        id: 'issue-1',
        title: 'x',
        state: { id: 'other-completed-id', name: 'Released', type: 'completed' },
      },
      updatedFrom: { stateId: MERGED_STATE_ID },
    });
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('does not fire when updatedFrom.stateId already equals Done (Done -> Done no-op)', async () => {
    const res = await post(transitionIntoDone({ updatedFrom: { stateId: DONE_STATE_ID } }));
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('ignores non-Issue events', async () => {
    const res = await post(transitionIntoDone({ type: 'Comment' }));
    expect(res.body.notified).toBe(0);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/linear/webhook — config guard (AC5)', () => {
  it('missing LINEAR_DONE_STATE_ID fails loud (200 ok:false) and never fires', async () => {
    delete process.env.LINEAR_DONE_STATE_ID;
    const res = await post(transitionIntoDone());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/LINEAR_DONE_STATE_ID/);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/linear/webhook — signature enforcement', () => {
  it('valid signature (secret set) -> fires', async () => {
    process.env.LINEAR_WEBHOOK_SECRET = 'lin_whsec';
    const res = await post(transitionIntoDone(), { secret: 'lin_whsec' });
    expect(res.status).toBe(200);
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
  });

  it('wrong signature -> 401, never fires', async () => {
    process.env.LINEAR_WEBHOOK_SECRET = 'lin_whsec';
    const res = await post(transitionIntoDone(), { sig: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('malformed JSON with no secret -> 200 ok:false (no throw, no retry storm)', async () => {
    const res = await post('{not-json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });
});
