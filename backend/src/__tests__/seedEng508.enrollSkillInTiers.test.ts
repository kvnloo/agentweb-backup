/**
 * ENG-508/ENG-867 — tier enrollment semantics for the LinkedIn Profile Reader seed.
 *
 * Enrollment must follow the RUNTIME rule (getAllowedSkills). Since ENG-1978 only an
 * explicit '*' is a wildcard: an EMPTY allowedSkills list means NO skills and an absent
 * one is a malformed row the runtime refuses to resolve. Two things must hold:
 *
 *  1. Empty and malformed tiers are never appended to. Doing so would widen a deliberate
 *     zero-skill tier (or "repair" a malformed row) from a seed script.
 *  2. Reachability is judged by the same rule used to enroll, so the seed cannot skip a
 *     tier and then claim the skill is reachable through it.
 */

const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: (...a: any[]) => mockGetSetting(...a),
    setSetting: (...a: any[]) => mockSetSetting(...a),
  },
}));

import { enrollSkillInTiers, tierIsWildcard, tierAllowsSkill } from '../scripts/seed-eng508-linkedin-profile-reader-skill';

const SKILL = 'profile-reader-id';
const setTiers = (tiers: any[]) =>
  mockGetSetting.mockResolvedValue({ settingValue: JSON.stringify(tiers) });

describe('enrollSkillInTiers (ENG-508)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetSetting.mockResolvedValue(undefined);
  });

  it('leaves an EMPTY allowedSkills list alone (it means no skills) and does not report it reachable', async () => {
    setTiers([{ name: 'Free', allowedSkills: [] }]);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res.changed).toEqual([]);
    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(res.reachable).toBe(false);
  });

  it('leaves a tier with no allowedSkills field alone (malformed) and does not report it reachable', async () => {
    setTiers([{ name: 'Broken' }]);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res.changed).toEqual([]);
    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(res.reachable).toBe(false);
  });

  it('still reports reachable when a wildcard tier sits next to an empty one', async () => {
    setTiers([
      { name: 'Free', allowedSkills: [] },
      { name: 'Enterprise', allowedSkills: ['*'] },
    ]);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res.changed).toEqual([]);
    expect(res.alreadyAllowed).toEqual(['Enterprise (wildcard)']);
    expect(res.reachable).toBe(true);
  });

  it('appends the skillId to explicit non-wildcard tiers and persists once', async () => {
    setTiers([
      { name: 'Pro', allowedSkills: ['other-skill'] },
      { name: 'Starter', allowedSkills: ['other-skill'] },
    ]);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res.changed).toEqual(['Pro', 'Starter']);
    expect(res.reachable).toBe(true);
    expect(mockSetSetting).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockSetSetting.mock.calls[0][1]);
    expect(written[0].allowedSkills).toContain(SKILL);
    expect(written[1].allowedSkills).toContain(SKILL);
  });

  it('is idempotent — a tier already listing the skill is untouched', async () => {
    setTiers([{ name: 'Pro', allowedSkills: ['other-skill', SKILL] }]);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res.changed).toEqual([]);
    expect(res.alreadyAllowed).toEqual(['Pro']);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('dry-run reports the intended change without writing', async () => {
    setTiers([{ name: 'Pro', allowedSkills: ['other-skill'] }]);

    const res = await enrollSkillInTiers(SKILL, true);

    expect(res.changed).toEqual(['Pro']);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('handles a missing subscription_types setting as unreachable (the runtime resolves no tier)', async () => {
    mockGetSetting.mockResolvedValue(null);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res).toEqual({ changed: [], alreadyAllowed: [], reachable: false });
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('reports an empty tier list as unreachable (it reaches nothing at runtime)', async () => {
    setTiers([]);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res).toEqual({ changed: [], alreadyAllowed: [], reachable: false });
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('predicates mirror the runtime rule (only an explicit star is a wildcard)', () => {
    expect(tierIsWildcard({ name: 'a' })).toBe(false);
    expect(tierIsWildcard({ name: 'a', allowedSkills: [] })).toBe(false);
    expect(tierIsWildcard({ name: 'a', allowedSkills: ['*'] })).toBe(true);
    expect(tierIsWildcard({ name: 'a', allowedSkills: ['x'] })).toBe(false);

    expect(tierAllowsSkill({ allowedSkills: [] }, SKILL)).toBe(false);
    expect(tierAllowsSkill({ name: 'a' }, SKILL)).toBe(false);
    expect(tierAllowsSkill({ allowedSkills: ['x'] }, SKILL)).toBe(false);
    expect(tierAllowsSkill({ allowedSkills: ['x', SKILL] }, SKILL)).toBe(true);
  });
});
