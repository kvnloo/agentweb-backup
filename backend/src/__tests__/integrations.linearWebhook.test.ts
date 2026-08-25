/**
 * Linear webhook route — Done-only resolve bridge + FB-synced issue enrichment.
 *
 * Contract under test:
 *   - HMAC-SHA256 signature (`linear-signature` over the raw payload bytes) is enforced for every
 *     event type when LINEAR_WEBHOOK_SECRET is set
 *   - customer comms fire only on an Issue update that transitions into the configured Done state
 *   - completed-type states that are not Done, already-Done edits, and Issue create events fire no
 *     resolve bridge
 *   - missing LINEAR_DONE_STATE_ID fails loud for Issue updates and never fires customer comms
 *   - customer-reported bugs require a well-formed `customer-symptom-verification:v1` comment
 *     (Result/Evidence type/Checked/Method/Verifier fields present) before Done sticks — from ANY
 *     Linear author, including the fix's own implementer (ENG-1556, 2026-08-25); only the
 *     structured-content requirement is enforced, not who posted it
 *   - Issue create carrying the "Featurebase" label triggers funnel enrichment
 *   - Featurebase enrichment errors return 200 so Linear does not retry-storm
 */
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';

jest.mock('../services/intakeService', () => ({
  notifyCanonicalResolved: jest.fn().mockResolvedValue({ ticketNumbers: [1, 2] }),
  enrichFeaturebaseSyncedIssue: jest.fn().mockResolvedValue({
    labelNames: ['Status: Activation', 'Activated', 'Needs PM'],
  }),
}));

// Prefixed `mock` deliberately — Jest's hoisting only allows a jest.mock() factory to reference
// module-scope variables whose name starts with "mock". Historically the only authorId the
// verification gate trusted; ENG-1556 (2026-08-25, Harsha's directive) removed that author-identity
// restriction from `hasCustomerSymptomVerification()`, so this id is now just an example author —
// kept as a named constant purely for readability, not because it carries any special meaning to
// the gate anymore.
const mockHarshaLinearUserId = '142fef82-4d45-4070-99be-c5debe565ac6';

jest.mock('../services/linearService', () => ({
  getIssueCommentsDetailed: jest.fn().mockResolvedValue([
    {
      body: [
        '<!-- customer-symptom-verification:v1 -->',
        '- Result: pass',
        '- Evidence type: customer-symptom',
        '- Checked: the customer-facing symptom',
        '- Method: independent production readback',
        '- Verifier: post-merge-verifier/run-123',
      ].join('\n'),
      createdAt: '2026-08-20T00:00:00.000Z',
      authorId: mockHarshaLinearUserId,
    },
  ]),
  reopenIssue: jest.fn().mockResolvedValue(undefined),
  addIssueComment: jest.fn().mockResolvedValue(undefined),
}));

import integrationsRouter from '../routes/integrations';
const intake = require('../services/intakeService');
const linear = require('../services/linearService');

const app = express();
// Mirror app.ts: raw body for the linear webhook path, json elsewhere.
app.use('/api/integrations/linear/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/integrations', integrationsRouter);

const SECRET = 'lin_whsec_test';
const DONE_STATE_ID = 'b36918be-3026-4a37-b788-47eef453a581';
const MERGED_STATE_ID = '11111111-1111-1111-1111-111111111111';
const PATH = '/api/integrations/linear/webhook';

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** A transition INTO Done: state is Done and updatedFrom carries the prior non-Done stateId. */
function transitionIntoDone(overrides: Record<string, any> = {}): any {
  return {
    type: 'Issue',
    action: 'update',
    data: {
      id: 'issue-1',
      title: 'A customer bug',
      labels: [{ name: 'Bug' }, { name: 'Customer Reported' }],
      state: { id: DONE_STATE_ID, name: 'Done', type: 'completed' },
    },
    updatedFrom: { stateId: MERGED_STATE_ID },
    ...overrides,
  };
}

/** An Issue-creation event as Featurebase's FB->Linear sync produces it. */
function fbCreateEvent(overrides: Record<string, any> = {}): any {
  return {
    action: 'create',
    type: 'Issue',
    data: {
      id: 'issue-uuid-1',
      title: 'Add a disable Emma tips toggle',
      labelIds: ['lab-fb'],
      labels: [{ id: 'lab-fb', name: 'Featurebase', color: '#716AE9' }],
      state: { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
      ...overrides.data,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'data')),
  };
}

async function post(body: any, opts: { sig?: string; unsigned?: boolean } = {}): Promise<request.Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  let req = request(app).post(PATH).set('Content-Type', 'application/json');
  if (!opts.unsigned) {
    req = req.set('linear-signature', opts.sig ?? sign(raw));
  }
  return req.send(raw);
}

const realSecret = process.env.LINEAR_WEBHOOK_SECRET;
const realDoneId = process.env.LINEAR_DONE_STATE_ID;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.LINEAR_WEBHOOK_SECRET = SECRET;
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
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
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
    const res = await post(transitionIntoDone({ updatedFrom: { title: 'old title' } }));
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

  it('action:create for a Done-state issue fires no resolve bridge because it is not a transition', async () => {
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

describe('POST /api/integrations/linear/webhook — customer symptom verification gate (ENG-1268)', () => {
  it('does not add a preflight comment dependency for an explicitly non-customer issue', async () => {
    const res = await post(transitionIntoDone({
      data: {
        id: 'issue-1',
        title: 'An internal bug',
        labels: [{ name: 'Bug' }],
        state: { id: DONE_STATE_ID, name: 'Done', type: 'completed' },
      },
    }));

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(linear.getIssueCommentsDetailed).not.toHaveBeenCalled();
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
  });

  it('blocks a customer-reported bug with no verification record and explains the missing evidence', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      { body: 'Fixed in PR #123.', createdAt: '2026-08-20T00:00:00.000Z' },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toMatchObject({ ok: false, blocked: 'customer verification required' });
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
    expect(linear.reopenIssue).toHaveBeenCalledWith('issue-1', 'Verifying');
    expect(linear.addIssueComment).toHaveBeenCalledWith(
      'issue-1',
      expect.stringContaining('actual customer-facing symptom'),
    );
  });

  it('rejects the three RankAI false-fixed comment shapes as code claims, not symptom proof', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      { body: 'Fixed and deployed on 2026-07-24.', createdAt: '2026-07-24T00:00:00.000Z' },
      { body: 'The patch merged; resolving this.', createdAt: '2026-07-30T00:00:00.000Z' },
      { body: 'Confirmed the code is live in production.', createdAt: '2026-08-03T00:00:00.000Z' },
    ]);

    await post(transitionIntoDone());

    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
    expect(linear.reopenIssue).toHaveBeenCalledWith('issue-1', 'Verifying');
  });

  it('rejects a marker that reports code deployment instead of a customer-facing check', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Checked: PR #123 merged',
          '- Method: GitHub checks green',
          '- Verifier: fix-author',
        ].join('\n'),
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    ]);

    await post(transitionIntoDone());

    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
    expect(linear.reopenIssue).toHaveBeenCalledWith('issue-1', 'Verifying');
  });

  it('allows self-authored evidence when the structured symptom fields are present (ENG-1556)', async () => {
    // Was "rejects self-authored evidence..." until ENG-1556 (2026-08-25, Harsha's directive):
    // "i don't give a shit about that fix anymore that no one can verify their own fixes, we do
    // that all the time, remove that as a rule." The Verifier text "fix-author" was never a
    // trusted prefix, but that content check is gone too (grep confirms TRUSTED_VERIFIER_PREFIX
    // no longer exists) — only presence of a well-formed structured record matters now.
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: live customer pixel fired',
          '- Method: raw production readback',
          '- Verifier: fix-author',
        ].join('\n'),
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });

  it('allows a free-text human name as Verifier (ENG-1268 gap superseded by ENG-1556)', async () => {
    // Originally reproduced a live incident: Harsha reviewed the evidence himself, directly, and
    // wrote "Verifier: Harsha Vankayalapati (direct review, live session, 2026-08-24)" with every
    // other field correctly filled in — and the gate rejected it anyway, because only the literal
    // "post-merge-verifier/" prefix was ever accepted. ENG-1556 (2026-08-25, Harsha's directive)
    // removed the trusted-prefix content check entirely — a bare, well-formed Verifier value from
    // any author is now accepted; only the structured Result/Evidence type/Checked/Method fields
    // are still enforced.
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: the exact reported symptom',
          '- Method: live production readback, reviewed independently of the implementer',
          '- Verifier: Harsha Vankayalapati (direct review, live session, 2026-08-24)',
        ].join('\n'),
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });

  it('allows "harsha-direct" with no run identifier — the trusted-prefix format check is gone (ENG-1556)', async () => {
    // Was "rejects... the prefix alone is not a record": TRUSTED_VERIFIER_PREFIX required a
    // "/<something>" suffix, so a bare "harsha-direct" failed the regex. ENG-1556 deleted
    // TRUSTED_VERIFIER_PREFIX entirely (grep confirms no remaining reference) — any non-empty
    // Verifier text now satisfies the field-presence check.
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: the exact reported symptom',
          '- Method: live production readback',
          '- Verifier: harsha-direct',
        ].join('\n'),
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });

  it('allows a near-miss prefix that merely starts with the old trusted string (ENG-1556 — no format check remains)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: the exact reported symptom',
          '- Method: live production readback',
          '- Verifier: harsha-direct-ish/2026-08-24',
        ].join('\n'),
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });

  it('allows a properly structured harsha-direct attestation to reach the resolve bridge', async () => {
    // `harsha-direct/...` carries no special meaning to the gate post-ENG-1556 (it's just text in
    // the Verifier field, same as any other value), and authorId is likewise no longer inspected —
    // this comment happens to use both, but neither is why it passes; it passes because the
    // structured Result/Evidence type/Checked/Method fields are present and well-formed.
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: the exact reported symptom',
          '- Method: live production readback, reviewed independently of the implementer',
          '- Verifier: harsha-direct/2026-08-24-live-session',
        ].join('\n'),
        createdAt: '2026-08-24T00:00:00.000Z',
        authorId: mockHarshaLinearUserId,
      },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });

  it('allows a perfectly formatted verifier record posted by anyone other than Harsha\'s own Linear account (ENG-1556, supersedes the CodeRabbit finding of 2026-08-24)', async () => {
    // Until 2026-08-25 this was "rejects...", added in direct response to a CodeRabbit finding
    // that comment TEXT alone (without author binding) let anyone impersonate Harsha's sign-off.
    // ENG-1268/ENG-1465 then surfaced the cost of that fix: no engineer — Anurag included — could
    // ever self-certify their own thoroughly-tested fix, no matter how solid the evidence. Harsha's
    // explicit, authorized ruling on ENG-1556 (2026-08-25): "i don't give a shit about that fix
    // anymore that no one can verify their own fixes, we do that all the time, remove that as a
    // rule." This is not a re-introduction of the vulnerability CodeRabbit flagged — it's the
    // deliberate removal of the identity gate entirely, by the product owner's own instruction.
    // The structured-evidence requirement (Result/Evidence type/Checked/Method) that made the old
    // exploit "perfectly formatted" is exactly what still has to be true for ANY author now.
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: the exact reported symptom',
          '- Method: live production readback, reviewed independently of the implementer',
          '- Verifier: harsha-direct/2026-08-24-self-attested',
        ].join('\n'),
        createdAt: '2026-08-24T00:00:00.000Z',
        authorId: 'cabadf7c-b95d-4455-b9ec-df11d5d83f5f', // Manan Varma, not Harsha — now fine
      },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });

  it('allows a well-formed verifier record with no author on the comment at all (ENG-1556 — author is never inspected)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: the exact reported symptom',
          '- Method: live production readback',
          '- Verifier: post-merge-verifier/run-999',
        ].join('\n'),
        createdAt: '2026-08-24T00:00:00.000Z',
        // authorId omitted — e.g. a deleted user or a system/API path that didn't resolve one.
        // Previously this alone was fatal (authorId === HARSHA_LINEAR_USER_ID could never be true
        // for undefined); the author check no longer exists, so this is just a well-formed record.
      },
    ]);

    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });

  it('still blocks Done when a required structured field (Method) is missing, regardless of author — the content requirement is unchanged (ENG-1556 AC2)', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: [
          '<!-- customer-symptom-verification:v1 -->',
          '- Result: pass',
          '- Evidence type: customer-symptom',
          '- Checked: the exact reported symptom',
          '- Verifier: post-merge-verifier/run-1000',
          // Method: intentionally omitted
        ].join('\n'),
        createdAt: '2026-08-25T00:00:00.000Z',
        authorId: 'cabadf7c-b95d-4455-b9ec-df11d5d83f5f', // Manan Varma — author no longer matters
      },
    ]);

    await post(transitionIntoDone());

    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
    expect(linear.reopenIssue).toHaveBeenCalledWith('issue-1', 'Verifying');
  });

  it('fails closed on the reporter-ticket rail when expanded labels are absent', async () => {
    linear.getIssueCommentsDetailed.mockResolvedValueOnce([
      {
        body: '[reporter-ticket #42 customer@example.com] Affected user: customer@example.com',
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    ]);
    const event = transitionIntoDone();
    delete event.data.labels;

    await post(event);

    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
    expect(linear.reopenIssue).toHaveBeenCalledWith('issue-1', 'Verifying');
  });

  it('allows a complete symptom-level verification record to reach the existing resolve bridge', async () => {
    const res = await post(transitionIntoDone());

    expect(res.body).toEqual({ ok: true, notified: 2, ticketNumbers: [1, 2] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
    expect(linear.reopenIssue).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/linear/webhook — config guard (AC5)', () => {
  it('missing LINEAR_DONE_STATE_ID fails loud for Issue updates and never fires', async () => {
    delete process.env.LINEAR_DONE_STATE_ID;
    const res = await post(transitionIntoDone());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/LINEAR_DONE_STATE_ID/);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('missing LINEAR_DONE_STATE_ID does not block Featurebase-synced issue creation enrichment', async () => {
    delete process.env.LINEAR_DONE_STATE_ID;
    const res = await post(fbCreateEvent());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enriched: true, labels: ['Status: Activation', 'Activated', 'Needs PM'] });
    expect(intake.enrichFeaturebaseSyncedIssue).toHaveBeenCalledWith({
      issueId: 'issue-uuid-1',
      title: 'Add a disable Emma tips toggle',
    });
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/linear/webhook — FB-synced issue enrichment (ENG-187 #4)', () => {
  it('Issue create with the Featurebase label -> enrichment with issue id + title, no bridge call', async () => {
    const res = await post(fbCreateEvent());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enriched: true, labels: ['Status: Activation', 'Activated', 'Needs PM'] });
    expect(intake.enrichFeaturebaseSyncedIssue).toHaveBeenCalledWith({
      issueId: 'issue-uuid-1',
      title: 'Add a disable Emma tips toggle',
    });
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('signature verification stays intact for creation events: bad signature -> 401, no enrichment', async () => {
    const res = await post(fbCreateEvent(), { sig: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('Issue create WITHOUT the Featurebase label (our own bug canonical) -> untouched', async () => {
    const ev = fbCreateEvent({
      data: {
        id: 'issue-uuid-2',
        title: 'crash on save',
        labelIds: ['lab-bug', 'lab-crep'],
        labels: [
          { id: 'lab-bug', name: 'Bug', color: '#eb5757' },
          { id: 'lab-crep', name: 'Customer Reported', color: '#95a2b3' },
        ],
        state: { id: 'st-todo', name: 'Todo', type: 'unstarted' },
      },
    });
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(res.body.enriched).toBeUndefined();
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('Issue create with no labels at all -> untouched, no error log', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ev = fbCreateEvent({
      data: { id: 'issue-uuid-3', title: 'plain', labelIds: [], labels: [], state: { type: 'backlog' } },
    });
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('Issue update with the Featurebase label -> no enrichment (creation-only)', async () => {
    const res = await post(fbCreateEvent({ action: 'update' }));
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('non-Issue types (Comment create) -> no enrichment', async () => {
    const res = await post({ action: 'create', type: 'Comment', data: { id: 'c1', body: 'hi' } });
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('payload contract drift (labelIds but no expanded labels array) -> loud error, no silent skip', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ev = fbCreateEvent();
    delete ev.data.labels;
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('issue-uuid-1'));
    errSpy.mockRestore();
  });

  it('enrichment throwing -> 200 ok:false (never crash the route)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    intake.enrichFeaturebaseSyncedIssue.mockRejectedValueOnce(new Error('linear down'));
    const res = await post(fbCreateEvent());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    errSpy.mockRestore();
  });
});

describe('POST /api/integrations/linear/webhook — signature and error handling', () => {
  it('valid signature -> transition into Done fires', async () => {
    const res = await post(transitionIntoDone());
    expect(res.status).toBe(200);
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledTimes(1);
  });

  it('wrong signature -> 401, never fires', async () => {
    const res = await post(transitionIntoDone(), { sig: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('malformed JSON with valid signature -> 200 ok:false (no throw, no retry storm)', async () => {
    const res = await post('{not-json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });
});
