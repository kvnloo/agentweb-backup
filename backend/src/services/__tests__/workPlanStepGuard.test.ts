/**
 * ENG-1221 — the destructive-update guard must live where the write happens.
 *
 * `manage_predefined_work_plan` promises two protections: `steps_mode: "merge"`
 * amends named steps without touching the others, and `confirm_step_removal`
 * gates any update that would drop steps or blank fields on the steps it keeps.
 *
 * Both were implemented inside the MCP tool. `PUT /api/admin/work-plans/:planId`
 * — the endpoint that actually writes — knew about neither. So a caller that
 * reached the endpoint directly got `steps_mode` silently ignored, a partial
 * array treated as a full replace, every omitted field erased, and HTTP 200
 * with `stepsChange: null` in response.
 *
 * That is not hypothetical. It destroyed all ten step descriptions on the
 * Google Pre-Launch Gate plan (~20.3k chars) on 2026-08-14, recovered only
 * because a snapshot happened to exist. The guard being one layer above the
 * damage is the whole defect.
 */

import {
  findStepContentLoss,
  summarizeStepChange,
  mergeWorkPlanSteps,
} from '../workPlanSteps';

const step = (n: number, over: Record<string, any> = {}) => ({
  stepCount: n,
  title: `Step ${n}: real title`,
  description: `A description for step ${n} that took someone a long time to write.`,
  requiredFunctionCalls: ['list_connected_accounts'],
  skillIds: ['skill-a'],
  ...over,
});

const TEN = Array.from({ length: 10 }, (_, i) => step(i + 1));

describe('findStepContentLoss (ENG-1221)', () => {
  it('flags the exact payload that destroyed the Pre-Launch Gate plan', () => {
    // stepCount + skillIds only, intending to "just change the skill".
    const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
    const loss = findStepContentLoss(TEN, partial);
    expect(loss).toHaveLength(10);
  });

  it('names which fields would be blanked, not merely that something would be', () => {
    const partial = [{ stepCount: 1, skillIds: ['skill-b'] }];
    const loss = findStepContentLoss([TEN[0]], partial);
    const fields = JSON.stringify(loss);
    expect(fields).toContain('description');
    expect(fields).toContain('title');
  });

  it('reports no loss when every step is re-sent whole', () => {
    expect(findStepContentLoss(TEN, TEN)).toHaveLength(0);
  });

  it('reports no loss when a field changes value rather than disappearing', () => {
    const edited = TEN.map((s) => ({ ...s, description: 'a different but present description' }));
    expect(findStepContentLoss(TEN, edited)).toHaveLength(0);
  });

  it('treats an empty string as blanking, not as a value', () => {
    // The failure mode is content vanishing. '' is how it vanishes in practice.
    const blanked = [{ ...TEN[0], description: '' }];
    expect(findStepContentLoss([TEN[0]], blanked).length).toBeGreaterThan(0);
  });
});

describe('summarizeStepChange (ENG-1221 AC3)', () => {
  it('reports a diff when steps actually changed', () => {
    const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
    const s = summarizeStepChange(TEN, partial, 'replace');
    expect(s).toBeTruthy();
    expect(s.stepsBefore).toBe(10);
  });

  it('counts removed steps so a shrink is visible in the response', () => {
    const s = summarizeStepChange(TEN, TEN.slice(0, 4), 'replace');
    expect(s.stepsBefore).toBe(10);
    expect(s.stepsAfter).toBe(4);
    expect(s.stepsRemoved).toBe(6);
  });

  it('names the dropped steps rather than only counting them', () => {
    const s = summarizeStepChange(TEN, TEN.slice(0, 9), 'replace');
    expect(JSON.stringify(s.droppedStepTitles)).toContain('Step 10');
  });
});

describe('mergeWorkPlanSteps — what the endpoint must do for steps_mode=merge', () => {
  it('changes only the named field and preserves everything else', () => {
    const merged = mergeWorkPlanSteps(TEN, [{ stepCount: 3, skillIds: ['skill-b'] }]);
    expect(merged).toHaveLength(10);
    const third = merged.find((s: any) => s.stepCount === 3);
    expect(third.skillIds).toEqual(['skill-b']);
    expect(third.description).toBe(TEN[2].description);
    expect(third.title).toBe(TEN[2].title);
  });

  it('leaves every untouched step byte-identical', () => {
    const merged = mergeWorkPlanSteps(TEN, [{ stepCount: 3, skillIds: ['skill-b'] }]);
    for (const n of [1, 2, 4, 5, 6, 7, 8, 9, 10]) {
      expect(merged.find((s: any) => s.stepCount === n)).toEqual(TEN[n - 1]);
    }
  });

  it('a merge of the real-world payload loses nothing', () => {
    // The same input that was destructive as a replace must be safe as a merge.
    const partial = TEN.map((s) => ({ stepCount: s.stepCount, skillIds: ['skill-b'] }));
    const merged = mergeWorkPlanSteps(TEN, partial);
    expect(findStepContentLoss(TEN, merged)).toHaveLength(0);
    expect(merged.every((s: any) => s.description)).toBe(true);
  });
});
