/**
 * ENG-2840 (W2-9): the four /api/emma routes behind the MCP meeting and event reads (routes/emmaMeetingEventRoutes.ts). Each runs Emma's own
 * tool through Emma's registry with `{ userId: req.user.userId }` as the only context, after checking the body by name and value; a
 * share-link visitor is refused Luma; Emma's "no Luma key" success becomes a "not connected" refusal; a phone number never leaves.
 * The router here stands in for emmaApi's (its auth and budget middleware have their own tests): a fake user is set on every request.
 */
import express, { Router } from 'express';
import request from 'supertest';

const mockExecute = jest.fn();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { execute: (...args: unknown[]) => mockExecute(...args) } }));
jest.mock('../emma/fathomTools', () => ({}));
jest.mock('../emma/lumaTools', () => ({}));

import { registerMeetingEventRoutes, LUMA_KEY_REJECTED_MESSAGE, LUMA_NOT_CONNECTED_MESSAGE } from '../routes/emmaMeetingEventRoutes';
import { EvaluationDenied } from '../services/evaluationPolicy';

let requestExtras: Record<string, unknown> = {};
const router = Router();
router.use((req: any, _res: any, next: any) => {
  req.user = { userId: 'caller-1', email: 'caller@example.com', isAdmin: true };
  Object.assign(req, requestExtras);
  next();
});
registerMeetingEventRoutes(router);
const app = express();
app.use(express.json());
app.use('/api/emma', router);

const post = (path: string, body: unknown) => request(app).post(`/api/emma/${path}`).send(body as any);

beforeEach(() => {
  mockExecute.mockReset();
  requestExtras = {};
});

describe('identity: req.user.userId only', () => {
  it('runs Emma\'s tool with { userId } and nothing else, whatever else the request carries', async () => {
    requestExtras = { delegateInfo: { adminUserId: 'admin-9', isDelegated: true }, isSelfCall: true };
    mockExecute.mockResolvedValue({ success: true, meetings: [] });
    const res = await post('fathom-meetings', { created_after: '2026-11-01' });
    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [name, args, context] = mockExecute.mock.calls[0];
    expect(name).toBe('fathom_get_meetings');
    expect(args).toStrictEqual({ created_after: '2026-11-01T00:00:00.000Z' });
    expect(context).toStrictEqual({ userId: 'caller-1' });
  });

  it('refuses any identity field in the body by name (400), calling nothing', async () => {
    for (const [path, body] of [
      ['fathom-meetings', { userId: 'victim' }],
      ['fathom-transcript', { recording_id: 1, user_id: 'victim' }],
      ['luma-events', { owner_user_id: 'victim' }],
      ['luma-guests', { event: 'evt-a', userId: 'victim' }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not an input/);
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('each route runs its own tool with only the checked values', async () => {
    mockExecute.mockResolvedValue({ success: true });
    await post('fathom-transcript', { recording_id: '810527663' });
    await post('luma-events', { after: '2026-11-01T09:00', before: '2026-12-01', limit: 10, cursor: 'c2', calendar_id: 'cal-1' });
    await post('luma-guests', { event: 'evt-abc', approval_status: 'waitlist', answer_labels: ['company'], max_guests: 20, include_registration_answers: true });
    expect(mockExecute.mock.calls.map((c) => [c[0], c[1], c[2]])).toStrictEqual([
      ['fathom_get_transcript', { recording_id: 810527663 }, { userId: 'caller-1' }],
      ['luma_list_events', { after: '2026-11-01T09:00:00.000Z', before: '2026-12-01T00:00:00.000Z', limit: 10, cursor: 'c2', calendar_id: 'cal-1' }, { userId: 'caller-1' }],
      ['luma_get_guests', { event: 'evt-abc', approval_status: 'waitlist', answer_labels: ['company'], max_guests: 20, include_registration_answers: true }, { userId: 'caller-1' }],
    ]);
  });
});

describe('bad input is refused (400) before anything runs', () => {
  it.each<[string, unknown, RegExp]>([
    ['fathom-meetings', { created_after: 'yesterday' }, /created_after must be an ISO 8601/],
    ['fathom-meetings', { created_after: '2026-11-02', created_before: '2026-11-01' }, /created_after must not be later/],
    ['fathom-meetings', { limit: 5 }, /"limit" is not an input/],
    ['fathom-transcript', {}, /recording_id is required/],
    ['fathom-transcript', { recording_id: '12/../34' }, /recording_id is required and must be a positive whole number/],
    ['fathom-transcript', { recording_id: 0 }, /recording_id/],
    ['fathom-transcript', { recording_id: 1.5 }, /recording_id/],
    ['luma-events', { limit: 101 }, /limit must be a whole number from 1 to 100/],
    ['luma-events', { cursor: 'x&y=1' }, /cursor must be/],
    ['luma-events', { calendar_id: 'cal/../x' }, /calendar_id must be/],
    ['luma-guests', { event: 'https://luma.com/event/manage/evt-abc' }, /event is required and must be an event id/],
    ['luma-guests', { event: 'evt-abc', include_phone: true }, /"include_phone" is not an input/],
    ['luma-guests', { event: 'evt-abc', approval_status: 'everyone' }, /approval_status must be one of/],
    ['luma-guests', { event: 'evt-abc', answer_labels: ['a', 'b', 'c', 'd', 'e', 'f'] }, /answer_labels must be/],
    ['luma-guests', { event: 'evt-abc', max_guests: 500 }, /max_guests must be/],
    ['luma-guests', [1, 2], /must be an object/],
  ])('%s %j', async (path, body, re) => {
    const res = await post(path, body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(re);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('Luma', () => {
  it('"no key" (Emma\'s success that pulled nothing) becomes a not-connected refusal without Emma\'s browser instruction', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, connected: false, nothing_pulled: true, reason: 'no_key', message: 'NOTHING WAS PULLED: continue with the browser session-cookie path' });
    const res = await post('luma-events', {});
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ success: false, connected: false, message: LUMA_NOT_CONNECTED_MESSAGE });
    mockExecute.mockResolvedValueOnce({ success: true, connected: false, nothing_pulled: true, reason: 'key_rejected', message: 'browser' });
    const rejected = await post('luma-guests', { event: 'evt-abc' });
    expect(rejected.body).toStrictEqual({ success: false, connected: false, message: LUMA_KEY_REJECTED_MESSAGE });
  });

  it('never asks Emma for phone numbers and strips any phone_number from the answer', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, guests: [{ guest_id: 'g1', email: 'g@example.com', name: 'G', phone_number: '+15551234567' }], has_more: false });
    const res = await post('luma-guests', { event: 'evt-abc' });
    expect(mockExecute.mock.calls[0][1]).toStrictEqual({ event: 'evt-abc' });
    expect(res.body.guests).toStrictEqual([{ guest_id: 'g1', email: 'g@example.com', name: 'G' }]);
    expect(JSON.stringify(res.body)).not.toMatch(/5551234567/);
  });

  it('a share-link visitor (a restricted self-call) is refused Luma (403), as Emma refuses it these tools; Fathom is not affected', async () => {
    requestExtras = { restrictionProfile: 'share_visitor' };
    for (const [path, body] of [['luma-events', {}], ['luma-guests', { event: 'evt-abc' }]] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/not available to a shared-link visitor/);
    }
    expect(mockExecute).not.toHaveBeenCalled();
    mockExecute.mockResolvedValueOnce({ success: true, meetings: [] });
    expect((await post('fathom-meetings', {})).status).toBe(200);
  });
});

describe('answers and failures', () => {
  it('Emma\'s refusal passes through as HTTP 200 { success: false, message }', async () => {
    mockExecute.mockResolvedValueOnce({ success: false, message: 'No Fathom account connected. Please connect your Fathom account in Settings → Connected Accounts to use this tool.' });
    const res = await post('fathom-meetings', {});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/No Fathom account connected/);
  });

  it('an unexpected failure is a 500 with a fixed text, never the exception\'s own words', async () => {
    mockExecute.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:8000 secret-detail'));
    const res = await post('fathom-transcript', { recording_id: 5 });
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ message: 'The Fathom transcript could not be read' });
  });

  it('an evaluation sandbox refusal from Emma\'s registry is a 403', async () => {
    mockExecute.mockRejectedValueOnce(new EvaluationDenied('Tool "luma_list_events" is not available in this sandbox workspace'));
    const res = await post('luma-events', {});
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/sandbox workspace/);
  });
});
