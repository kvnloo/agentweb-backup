/**
 * ENG-1469 — the admin API accepts an optional `display` block for
 * customer-readable browse metadata (title/summary/categories/channel/suite/
 * stepLabels/nextPlanIds), validated field-by-field, with present/absent/null
 * semantics that must never erase steps or unrelated fields.
 *
 * These pin the ENDPOINT behavior (POST create + PUT update), not just the
 * standalone validator — the same class of gap ENG-1221 exists to close
 * elsewhere in this router.
 */
import request from 'supertest';

describe('Admin WorkPlan routes — display metadata (ENG-1469)', () => {
  let app: any;
  let mockGetWorkPlan: jest.Mock;
  let mockUpdateWorkPlan: jest.Mock;
  let mockCreateWorkPlan: jest.Mock;

  const plan = {
    planId: 'plan-1',
    title: 'Meta Pre-Launch Gate',
    description: 'Gate a Meta launch',
    steps: [
      { stepCount: 1, title: 'Scope the launch' },
      { stepCount: 2, title: 'Inventory assets' },
    ],
    visibility: 'system',
    isBuiltIn: true,
    createdAt: '2026-08-04T08:00:00.000Z',
    updatedAt: '2026-08-04T09:00:00.000Z',
    steps_rev: 'rev-1',
    ownerId: 'owner-1',
    thumbnail_url: 'https://s3/existing-thumb.png',
    thumbnail_source: 'ai',
  };

  const validDisplay = {
    version: 1,
    title: 'Launch a Meta campaign',
    summary: 'Get your first Meta campaign live in under a day.',
    categories: ['paid-ads', 'strategy'],
    channel: 'meta',
    suite: { id: 'meta-launch', name: 'Meta Launch Suite', position: 1 },
    stepLabels: ['Scope it', 'Gather assets'],
    nextPlanIds: ['plan-2'],
  };

  beforeAll(() => {
    jest.resetModules();
    mockGetWorkPlan = jest.fn();
    mockUpdateWorkPlan = jest.fn();
    mockCreateWorkPlan = jest.fn();

    jest.doMock('../services/workPlanService', () => ({
      workPlanService: {
        getWorkPlan: mockGetWorkPlan,
        updateWorkPlan: mockUpdateWorkPlan,
        createWorkPlan: mockCreateWorkPlan,
        getAllWorkPlans: jest.fn(),
        getWorkPlansByVisibility: jest.fn(),
        getSyncStatus: jest.fn(),
      },
    }));
    jest.doMock('../services/workPlanThumbnailService', () => ({
      workPlanThumbnailService: { generateAIThumbnail: jest.fn().mockResolvedValue(undefined) },
    }));
    jest.doMock('../middleware/auth', () => ({
      authenticateToken: (_r: any, _s: any, n: any) => n(),
    }));
    jest.doMock('../middleware/admin', () => ({ isAdmin: (_r: any, _s: any, n: any) => n() }));

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/admin/work-plans', require('../routes/adminWorkPlanRoutes').default);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkPlan.mockResolvedValue(plan);
    mockUpdateWorkPlan.mockResolvedValue('rev-2');
    mockCreateWorkPlan.mockImplementation(async (input: any) => ({
      ...input,
      planId: 'new-plan-id',
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    }));
  });

  // ── POST /  (create) ───────────────────────────────────────────────────

  describe('POST / with display', () => {
    it('accepts a valid display block and stores it on the created plan', async () => {
      const res = await request(app)
        .post('/api/admin/work-plans')
        .send({ title: 'New Plan', steps: [{ title: 'Step 1' }, { title: 'Step 2' }], display: validDisplay });

      expect(res.status).toBe(201);
      expect(mockCreateWorkPlan).toHaveBeenCalledWith(
        expect.objectContaining({ display: expect.objectContaining({ version: 1, title: validDisplay.title }) }),
      );
      expect(res.body.display).toEqual(expect.objectContaining({ nextPlanIds: ['plan-2'] }));
    });

    it('creates a plan with no display block at all when none is supplied', async () => {
      const res = await request(app)
        .post('/api/admin/work-plans')
        .send({ title: 'New Plan', steps: [{ title: 'Step 1' }] });

      expect(res.status).toBe(201);
      expect(mockCreateWorkPlan).toHaveBeenCalledWith(expect.objectContaining({ display: undefined }));
    });

    it('rejects an invalid display block with 400 and never creates the plan', async () => {
      const res = await request(app)
        .post('/api/admin/work-plans')
        .send({ title: 'New Plan', steps: [{ title: 'Step 1' }], display: { version: 2 } });

      expect(res.status).toBe(400);
      expect(mockCreateWorkPlan).not.toHaveBeenCalled();
    });

    it('rejects step labels beyond the number of steps being created', async () => {
      const res = await request(app).post('/api/admin/work-plans').send({
        title: 'New Plan',
        steps: [{ title: 'Only step' }],
        display: { version: 1, stepLabels: ['one', 'two'] },
      });

      expect(res.status).toBe(400);
      expect(mockCreateWorkPlan).not.toHaveBeenCalled();
    });
  });

  // ── PUT /:planId  (update) ─────────────────────────────────────────────

  describe('PUT /:planId with display', () => {
    it('accepts a valid display block and writes it', async () => {
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ display: validDisplay });

      expect(res.status).toBe(200);
      expect(mockUpdateWorkPlan).toHaveBeenCalledWith(
        expect.objectContaining({ display: expect.objectContaining({ nextPlanIds: ['plan-2'] }) }),
        expect.anything(),
      );
      expect(res.body.display.suite).toEqual({ id: 'meta-launch', name: 'Meta Launch Suite', position: 1 });
    });

    it('preserves the existing display block when the key is absent from the request', async () => {
      mockGetWorkPlan.mockResolvedValue({ ...plan, display: validDisplay });

      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ title: 'Renamed only' });

      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0];
      expect(written.display).toEqual(validDisplay);
      expect(written.title).toBe('Renamed only');
    });

    it('removes the display block when explicitly sent as null', async () => {
      mockGetWorkPlan.mockResolvedValue({ ...plan, display: validDisplay });

      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ display: null });

      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0];
      expect(written.display).toBeUndefined();
      expect('display' in written).toBe(true); // explicit undefined, not simply omitted
    });

    it('never touches thumbnail-owned fields while editing display', async () => {
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ display: validDisplay });

      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0];
      expect(written.thumbnail_url).toBe(plan.thumbnail_url);
      expect(written.thumbnail_source).toBe(plan.thumbnail_source);
    });

    it('preserves unrelated unknown-to-display fields (e.g. ownerId) untouched', async () => {
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ display: validDisplay });

      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0];
      expect(written.ownerId).toBe('owner-1');
    });

    it('does not touch or drop the existing steps array when only display changes', async () => {
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ display: validDisplay });

      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0];
      expect(written.steps).toEqual(plan.steps);
    });

    it('rejects a plan recommending itself and never writes', async () => {
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ display: { version: 1, nextPlanIds: ['plan-1'] } });

      expect(res.status).toBe(400);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown version', { version: 2 }],
      ['unknown category', { version: 1, categories: ['unknown'] }],
      ['duplicate categories', { version: 1, categories: ['strategy', 'strategy'] }],
      ['too many categories', { version: 1, categories: ['strategy', 'paid-ads', 'founder-led-sales', 'event-led-sales', 'content', 'strategy'] }],
      ['oversized title', { version: 1, title: 'x'.repeat(81) }],
      ['oversized summary', { version: 1, summary: 'x'.repeat(181) }],
      ['wrong-type title', { version: 1, title: 42 }],
      ['invalid channel', { version: 1, channel: 'carrier-pigeon' }],
      ['invalid suite slug', { version: 1, suite: { id: 'Not A Slug', name: 'x', position: 1 } }],
      ['suite position below range', { version: 1, suite: { id: 'ok-slug', name: 'x', position: 0 } }],
      ['suite position above range', { version: 1, suite: { id: 'ok-slug', name: 'x', position: 100 } }],
      ['stepLabels beyond step count', { version: 1, stepLabels: ['a', 'b', 'c'] }],
      ['duplicate nextPlanIds', { version: 1, nextPlanIds: ['plan-2', 'plan-2'] }],
      ['wrong-type nextPlanIds entry', { version: 1, nextPlanIds: [42] }],
      ['too many nextPlanIds', { version: 1, nextPlanIds: ['a', 'b', 'c', 'd'] }],
    ])('rejects %s with 400 and never writes', async (_label, display) => {
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ display });
      expect(res.status).toBe(400);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it('still enforces the expectedStepsRev stake when display is edited', async () => {
      const err = new Error('Work plan steps changed');
      mockUpdateWorkPlan.mockRejectedValueOnce(err);

      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ display: validDisplay, expectedStepsRev: 'stale-rev' });

      expect(res.status).toBe(409);
      expect(mockUpdateWorkPlan).toHaveBeenCalledWith(
        expect.objectContaining({ display: expect.any(Object) }),
        { expectedStepsRev: 'stale-rev' },
      );
    });

    it('renders a legacy plan (no display block) unaffected when display is not part of the request', async () => {
      mockGetWorkPlan.mockResolvedValue({ ...plan, display: undefined });

      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ title: 'Legacy plan renamed' });

      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0];
      expect(written.display).toBeUndefined();
    });
  });
});
