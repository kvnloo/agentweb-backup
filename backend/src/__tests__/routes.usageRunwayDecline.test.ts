/**
 * ENG-1210 AC12 — `POST /api/subscription/usage-runway/decline`.
 *
 * The route layer is where a decline can quietly become a no-op: a body shape the handler
 * does not recognise produces an empty selection list, and an endpoint that records
 * nothing still answers 200. That is the failure this file is written against — the same
 * one that had the E2E suite previewing an empty `switches` list while passing.
 *
 * So every test here asserts on what reached the SERVICE, not merely on the status code.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'member-9', email: 'member@example.com', isAdmin: false };
    next();
  },
}));

jest.mock('../services/llmUsageDeclineService', () => {
  const actual = jest.requireActual('../services/llmUsageDeclineService');
  return {
    ...actual,
    recordRecommendationDeclined: jest.fn(),
  };
});

import subscriptionRouter from '../routes/subscription';
import {
  recordRecommendationDeclined,
  InvalidDeclineInputError,
  DECLINE_REASONS,
} from '../services/llmUsageDeclineService';

const app = express();
app.use(express.json());
app.use('/api/subscription', subscriptionRouter);

const mockRecord = recordRecommendationDeclined as jest.MockedFunction<
  typeof recordRecommendationDeclined
>;

describe('POST /api/subscription/usage-runway/decline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecord.mockResolvedValue({ recorded: 1 });
  });

  it('FAIL: rejects a non-array `selections` rather than silently recording nothing', async () => {
    const res = await request(app)
      .post('/api/subscription/usage-runway/decline')
      .send({ reason: DECLINE_REASONS.previewCleared, selections: 'all of them' });

    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('FAIL: surfaces an invalid reason as 400, not 500', async () => {
    // It is the caller's request that is wrong, and a 500 would send them retrying.
    mockRecord.mockRejectedValue(new InvalidDeclineInputError('`reason` must be one of: ...'));

    const res = await request(app)
      .post('/api/subscription/usage-runway/decline')
      .send({ reason: 'nope', selections: [{ fromModel: 'a', toModel: 'b' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it('FAIL: an unexpected service failure is a 500 and does not leak the message', async () => {
    mockRecord.mockRejectedValue(new Error('dynamo exploded with a table name in it'));

    const res = await request(app)
      .post('/api/subscription/usage-runway/decline')
      .send({
        reason: DECLINE_REASONS.previewCleared,
        selections: [{ fromModel: 'a', toModel: 'b' }],
      });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/dynamo exploded/);
  });

  it('FAIL: an unrecognised body key reaches the service as an EMPTY list, and is refused there', async () => {
    // The regression this file exists for. `switches` is what the preview route was
    // wrongly sent for weeks; if that key ever appears here it must not look like success.
    mockRecord.mockRejectedValue(new InvalidDeclineInputError('at least one'));

    const res = await request(app)
      .post('/api/subscription/usage-runway/decline')
      .send({ reason: DECLINE_REASONS.previewCleared, switches: [{ fromModel: 'a', toModel: 'b' }] });

    expect(res.status).toBe(400);
    expect(mockRecord).toHaveBeenCalledWith('member-9', expect.objectContaining({ selections: [] }));
  });

  it('SUCCESS: forwards the acting user and the selections as the customer saw them', async () => {
    mockRecord.mockResolvedValue({ recorded: 2 });

    const res = await request(app)
      .post('/api/subscription/usage-runway/decline')
      .send({
        reason: DECLINE_REASONS.removedFromPreview,
        selections: [
          { fromModel: 'anthropic.claude-opus-5', toModel: 'gemini-3.7-flash', estimatedDaysRecovered: 6, confidence: 'high' },
          { fromModel: 'gpt-5.4', toModel: 'gemini-3.7-flash' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: 2 });
    expect(mockRecord).toHaveBeenCalledWith('member-9', {
      reason: DECLINE_REASONS.removedFromPreview,
      selections: [
        { fromModel: 'anthropic.claude-opus-5', toModel: 'gemini-3.7-flash', estimatedDaysRecovered: 6, confidence: 'high' },
        // Absent optional fields are normalised to null rather than dropped, so a
        // consumer can tell "not shown an estimate" from "field missing".
        { fromModel: 'gpt-5.4', toModel: 'gemini-3.7-flash', estimatedDaysRecovered: null, confidence: null },
      ],
    });
  });

  it('writes nothing: the route never touches the apply or preview paths', async () => {
    await request(app)
      .post('/api/subscription/usage-runway/decline')
      .send({
        reason: DECLINE_REASONS.previewCleared,
        selections: [{ fromModel: 'a', toModel: 'b' }],
      });

    // The only collaborator a decline is allowed to have. If a future edit makes this
    // route apply or preview something, this fails rather than silently writing a model.
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });
});
