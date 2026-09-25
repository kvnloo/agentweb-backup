/**
 * ENG-2143 / OPS-4 (ENG-2149): the requirement-source backfill is dry-run by default, refuses
 * --apply without the exact table named in its env var, and never overwrites a set source.
 */
import {
  planRequirementBackfill,
  planRequirementRollback,
  assertApplyAllowed,
  APPLY_ENV_VAR,
  BACKFILL_SET_BY,
  type ScannedCapabilityRow,
} from '../scripts/eng2149-backfill-requirement-source';

const TABLE = 'AW-AccountCapabilityRequirements';
const NOW = '2026-09-25T12:00:00.000Z';

describe('assertApplyAllowed', () => {
  it('refuses unless the env var names the exact target table', () => {
    expect(() => assertApplyAllowed({}, TABLE)).toThrow(/--apply refused/);
    expect(() => assertApplyAllowed({ [APPLY_ENV_VAR]: 'true' }, TABLE)).toThrow(/--apply refused/);
    expect(() => assertApplyAllowed({ [APPLY_ENV_VAR]: `Dev-${TABLE}` }, TABLE)).toThrow(/--apply refused/);
    expect(() => assertApplyAllowed({ [APPLY_ENV_VAR]: TABLE }, TABLE)).not.toThrow();
  });
});

describe('planRequirementBackfill', () => {
  const row = (userId: string, extra: Partial<ScannedCapabilityRow> = {}): ScannedCapabilityRow => ({
    userId,
    capability: 'ad_platform_integration',
    requiredSince: '2026-05-01T00:00:00.000Z',
    ...extra,
  });

  it('marks rows as onboarding_intent unless named contracted, and leaves set rows alone', () => {
    const plan = planRequirementBackfill(
      [row('a'), row('b'), row('c', { requirementSource: 'contracted' })],
      new Set(['b']),
      NOW,
    );
    expect(plan.writes).toEqual([
      { userId: 'a', requirementSource: 'onboarding_intent', requirementVerifiedAt: '2026-05-01T00:00:00.000Z', requirementSetBy: BACKFILL_SET_BY },
      { userId: 'b', requirementSource: 'contracted', requirementVerifiedAt: NOW, requirementSetBy: BACKFILL_SET_BY },
    ]);
    expect(plan.alreadySet).toBe(1);
    expect(plan.unknownContracted).toEqual([]);
  });

  it('reports contracted ids that have no ad capability row, and ignores other row types', () => {
    const plan = planRequirementBackfill(
      [{ userId: 'x', capability: 'account_health_signal', requiredSince: NOW }],
      new Set(['x']),
      NOW,
    );
    expect(plan).toEqual({ writes: [], alreadySet: 0, unknownContracted: ['x'] });
  });
});

describe('planRequirementRollback', () => {
  it('selects exactly the rows written with the given --set-by value', () => {
    const rows: ScannedCapabilityRow[] = [
      { userId: 'a', capability: 'ad_platform_integration', requirementSource: 'onboarding_intent', requirementSetBy: BACKFILL_SET_BY },
      { userId: 'b', capability: 'ad_platform_integration', requirementSource: 'contracted', requirementSetBy: 'ops@example.com' },
      { userId: 'c', capability: 'ad_platform_integration', requirementSource: 'contracted', requirementSetBy: 'someone-else@example.com' },
      { userId: 'd', capability: 'account_health_signal', requirementSetBy: 'ops@example.com' },
    ];
    expect(planRequirementRollback(rows, 'ops@example.com').map((r) => r.userId)).toEqual(['b']);
    expect(planRequirementRollback(rows, BACKFILL_SET_BY).map((r) => r.userId)).toEqual(['a']);
  });
});
