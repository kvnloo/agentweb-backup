/**
 * ENG-1221 — the guard must fire at PUT /api/admin/work-plans/:planId itself.
 *
 * The helper-level tests prove the rules are correct. These prove the ENDPOINT
 * applies them, which is the actual defect: the rules existed, but only inside
 * `manage_predefined_work_plan`, one layer above the write. A caller reaching
 * the route directly got `steps_mode` silently ignored and every omitted field
 * erased, with HTTP 200 and a null diff in response.
 *
 * The payload in the first test is the one that actually destroyed all ten step
 * descriptions on the Google Pre-Launch Gate plan on 2026-08-14.
 */

import request from 'supertest';

describe('PUT /api/admin/work-plans/:planId — destructive step guard (ENG-1221)', () => {
  let app: any;
  let mockGetWorkPlan: jest.Mock;
  let mockUpdateWorkPlan: jest.Mock;

  const step = (n: number) => ({
    stepCount: n,
    title: `Step ${n}: a real title`,
    description: `Description ${n} — the content that took someone a long time to write.`,
    requiredFunctionCalls: ['list_connected_accounts'],
    skillIds: ['skill-a'],
  });
  const TEN = Array.from({ length: 10 }, (_, i) => step(i + 1));
  const plan = { planId: 'plan-1', title: 'Google Pre-Launch Gate', steps: TEN, steps_rev: 7 };

  beforeAll(() => {
    jest.resetModules();
    mockGetWorkPlan = jest.fn();
    mockUpdateWorkPlan = jest.fn();

    jest.doMock('../services/workPlanService', () => ({
      workPlanService: {
        getWorkPlan: mockGetWorkPlan,
        updateWorkPlan: mockUpdateWorkPlan,
        getAllWorkPlans: jest.fn(),
        createWorkPlan: jest.fn(),
        getWorkPlansByVisibility: jest.fn(),
        getSyncStatus: jest.fn(),
      },
    }));
    jest.doMock('../services/workPlanThumbnailService', () => ({
      workPlanThumbnailService: { generateAIThumbnail: jest.fn() },
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
    mockUpdateWorkPlan.mockResolvedValue(8);
  });

  describe('AC1 — the endpoint refuses a destructive replace', () => {
    it('rejects the exact payload that destroyed the Pre-Launch Gate plan', async () => {
      const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ steps: partial });
      expect(res.status).toBe(400);
      expect(res.body.stepContentLoss).toHaveLength(10);
      // The write must not have happened at all.
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it('rejects a payload that would drop steps', async () => {
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: TEN.slice(0, 4) });
      expect(res.status).toBe(400);
      expect(res.body.stepsWouldBeRemoved).toBe(6);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it('allows the same destructive write when confirm_step_removal is set', async () => {
      // The guard exists to stop ACCIDENTS, not to remove the capability.
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: TEN.slice(0, 4), confirm_step_removal: true });
      expect(res.status).toBe(200);
      expect(mockUpdateWorkPlan).toHaveBeenCalled();
    });

    it('allows a non-destructive replace that re-sends every step whole', async () => {
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ steps: TEN });
      expect(res.status).toBe(200);
      expect(mockUpdateWorkPlan).toHaveBeenCalled();
    });
  });

  describe('AC2 — steps_mode is honoured or rejected, never ignored', () => {
    it('honours steps_mode=merge and preserves the untouched fields', async () => {
      const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: partial, steps_mode: 'merge' });
      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0].steps;
      expect(written).toHaveLength(10);
      expect(written.every((s: any) => s.description)).toBe(true);
      expect(written.every((s: any) => s.skillIds[0] === 'skill-b')).toBe(true);
      expect(written[0].title).toBe(TEN[0].title);
    });

    it('targets a title-only merge entry by its title, not by its array position', async () => {
      // The route synthesises a stepCount for an entry that carried none —
      // normalizeWorkPlanSteps fills in the array position — and merge target
      // resolution trusts stepCount over title. So "amend the step titled
      // 'Step 7: a real title'", sent alone, landed on step 1 instead.
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: [{ title: 'Step 7: a real title', description: 'rewritten' }], steps_mode: 'merge' });
      expect(res.status).toBe(200);
      const written = mockUpdateWorkPlan.mock.calls[0][0].steps;
      expect(written).toHaveLength(10);
      expect(written.find((s: any) => s.stepCount === 7).description).toBe('rewritten');
      // The step that was NOT named must be untouched.
      expect(written.find((s: any) => s.stepCount === 1)).toEqual(TEN[0]);
    });

    it('does not treat a falsy stepCount as a selector', async () => {
      // `normalizeWorkPlanSteps` turns stepCount null/0/'' into the array
      // position, and merge resolution trusts stepCount over title. A presence
      // check (`!== undefined`) therefore promoted a non-selector into an
      // invented one, amending step 1 while the titled step stayed untouched.
      for (const bad of [null, 0, '']) {
        jest.clearAllMocks();
        mockGetWorkPlan.mockResolvedValue(plan);
        mockUpdateWorkPlan.mockResolvedValue(8);
        const res = await request(app)
          .put('/api/admin/work-plans/plan-1')
          .send({
            steps: [{ stepCount: bad, title: 'Step 7: a real title', description: 'rewritten' }],
            steps_mode: 'merge',
          });
        expect(res.status).toBe(200);
        const written = mockUpdateWorkPlan.mock.calls[0][0].steps;
        expect(written.find((s: any) => s.stepCount === 7).description).toBe('rewritten');
        expect(written.find((s: any) => s.stepCount === 1)).toEqual(TEN[0]);
      }
    });

    it('rejects an explicitly supplied null steps_mode instead of defaulting to replace', async () => {
      // Nullish coalescing turned a supplied-but-invalid value back into
      // "absent", so the caller silently got replace semantics.
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: TEN, steps_mode: null });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/steps_mode/i);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it('does not let a valid steps_mode mask an unsupported stepsMode', async () => {
      // `steps_mode ?? stepsMode` never looks at the second key once the first
      // is set — so one of the two supplied modes was accepted and disregarded.
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: TEN, steps_mode: 'merge', stepsMode: 'patch' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/steps_mode|stepsMode/i);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it('refuses a merge entry that names no step at all', async () => {
      // With neither stepCount nor title there is nothing to resolve against.
      // Silently amending whatever sat at that array position is the same
      // wrong-step edit the ambiguity check already refuses to make.
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: [{ description: 'rewritten' }], steps_mode: 'merge' });
      expect(res.status).toBe(400);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised steps_mode even when no steps are sent', async () => {
      // Validation nested under "steps were supplied" is accept-and-disregard
      // by another name: the caller is told 200 for a mode we never honoured.
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ title: 'Renamed', steps_mode: 'patch' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/steps_mode/i);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised steps_mode rather than silently replacing', async () => {
      // Accept-and-disregard is the failure: the caller believes a merge ran.
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: [{ stepCount: 1, skillIds: ['x'] }], steps_mode: 'patch' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/steps_mode/i);
      expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
    });
  });

  describe('AC3 — a step change always reports a diff', () => {
    it('returns stepsChange on a successful step write', async () => {
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: TEN, confirm_step_removal: true });
      expect(res.status).toBe(200);
      expect(res.body.stepsChange).toBeDefined();
      expect(res.body.stepsChange.stepsBefore).toBe(10);
    });

    it('does not invent a diff when steps were not part of the update', async () => {
      const res = await request(app).put('/api/admin/work-plans/plan-1').send({ title: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.stepsChange).toBeUndefined();
    });
  });

  describe('unchanged behaviour', () => {
    it('still 404s for a plan that does not exist', async () => {
      mockGetWorkPlan.mockResolvedValue(null);
      const res = await request(app).put('/api/admin/work-plans/nope').send({ title: 'x' });
      expect(res.status).toBe(404);
    });

    it('still rejects a non-array steps value', async () => {
      const res = await request(app)
        .put('/api/admin/work-plans/plan-1')
        .send({ steps: 'not-an-array' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must be an array/i);
    });
  });
});
