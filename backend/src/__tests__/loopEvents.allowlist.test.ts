/**
 * ENG-911: hireemma.ai's homepage silently drops telemetry on every visit.
 *
 * Root cause: the AI-Readiness quiz popup (mounted site-wide, including `/`)
 * auto-fires a `roadmap_popup_viewed` event ~9s after mount, and its
 * "book a stack review" CTA fires `book_started` on click. Neither event
 * type was ever added to its loop's `allowedEventTypes` manifest, so
 * POST /api/loop-events rejects both with 400 event_type_not_allowed — a
 * well-formed, intentionally-named client event silently dropped because the
 * server-side allowlist drifted, not because anything is malformed.
 *
 * Confirmed live against production (2026-08-11): the homepage's `landed`
 * event (loop ai-eval-funnel) returns 201; roadmap_popup_viewed (loop
 * ai-readiness-funnel) returns 400 event_type_not_allowed.
 */

jest.mock('aws-sdk', () => {
  const mockDynamoDB = { put: jest.fn() };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    config: { update: jest.fn() },
  };
});

import express from 'express';
import request from 'supertest';
import AWS from 'aws-sdk';
import loopEventsRoutes from '../routes/loopEvents';
import { registerOrReplaceLoop } from '../loops';
import { aiReadinessManifest } from '../loops/instances/ai-readiness-funnel/manifest';
import { aiEvalManifest } from '../loops/instances/ai-eval-funnel/manifest';

describe('POST /api/loop-events — allowlist drift (ENG-911)', () => {
  let app: express.Express;
  let mockPut: jest.Mock;

  beforeAll(() => {
    // registerOrReplaceLoop (not the app.ts production bootstrap functions,
    // which also wire Slack/cron/AWS side effects this test doesn't need)
    // populates the same in-memory LOOP_REGISTRY the route reads from —
    // exactly what production registration does for the route's purposes,
    // with none of the unrelated setup.
    registerOrReplaceLoop(aiReadinessManifest);
    registerOrReplaceLoop(aiEvalManifest);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPut = (AWS.DynamoDB.DocumentClient as any)().put;
    mockPut.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

    app = express();
    app.use(express.json());
    app.use('/api/loop-events', loopEventsRoutes);
  });

  it('accepts roadmap_popup_viewed for ai-readiness-funnel (the popup that fires on every homepage visit)', async () => {
    const res = await request(app)
      .post('/api/loop-events')
      .send({
        loopId: 'ai-readiness-funnel',
        eventType: 'roadmap_popup_viewed',
        subjectId: 'test-subject-1',
        dimensions: { landerPath: '/', surface: 'site_popup', offer: 'ai_readiness_roadmap' },
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(mockPut).toHaveBeenCalled();
  });

  it('accepts book_started for ai-eval-funnel (the popup CTA click)', async () => {
    const res = await request(app)
      .post('/api/loop-events')
      .send({
        loopId: 'ai-eval-funnel',
        eventType: 'book_started',
        subjectId: 'test-subject-2',
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('still rejects a genuinely unknown event type — the allowlist is not disabled, just corrected', async () => {
    const res = await request(app)
      .post('/api/loop-events')
      .send({
        loopId: 'ai-readiness-funnel',
        eventType: 'totally_made_up_event',
        subjectId: 'test-subject-3',
      });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'event_type_not_allowed', eventType: 'totally_made_up_event' });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('still accepts the homepage landed event unaffected by this fix', async () => {
    const res = await request(app)
      .post('/api/loop-events')
      .send({
        loopId: 'ai-eval-funnel',
        eventType: 'landed',
        subjectId: 'test-subject-4',
      });
    expect(res.status).toBe(201);
  });
});
