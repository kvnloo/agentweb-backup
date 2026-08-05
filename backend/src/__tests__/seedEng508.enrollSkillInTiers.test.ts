/**
 * ENG-508/ENG-867 — tier enrollment semantics for the LinkedIn Profile Reader seed.
 *
 * Enrollment must follow the RUNTIME rule (getAllowedSkills): a tier whose
 * allowedSkills is absent, EMPTY, or contains '*' already grants every skill.
 * Two things must hold:
 *
 *  1. An EMPTY list is never appended to. Appending a skillId there would flip the
 *     tier from "all skills allowed" to "only this one skill allowed" — a severe
 *     entitlement regression for every user on that tier.
 *  2. Reachability is judged by the same rule used to enroll, so the seed cannot
 *     skip a tier as wildcard and then fail claiming the skill is unreachable
 *     (the inconsistency Greptile flagged: findTiersAllowingSkill does
 *     `tier.allowedSkills || ['*']`, and `[]` is truthy, so it reads an empty list
 *     as "allows nothing" while the runtime reads it as wildcard).
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

  it('treats an EMPTY allowedSkills list as wildcard: never appends, and still reports reachable', async () => {
    setTiers([{ name: 'Free', allowedSkills: [] }]);

    const res = await enrollSkillInTiers(SKILL, false);

    // The dangerous regression: an empty list must not gain a single entry.
    expect(res.changed).toEqual([]);
    expect(mockSetSetting).not.toHaveBeenCalled();
    // And the seed must NOT then claim the skill is unreachable.
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

  it('handles a missing subscription_types setting as all-wildcard', async () => {
    mockGetSetting.mockResolvedValue(null);

    const res = await enrollSkillInTiers(SKILL, false);

    expect(res).toEqual({ changed: [], alreadyAllowed: [], reachable: true });
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('predicates mirror the runtime rule (absent / empty / star are all wildcard)', () => {
    expect(tierIsWildcard({ name: 'a' })).toBe(true);
    expect(tierIsWildcard({ name: 'a', allowedSkills: [] })).toBe(true);
    expect(tierIsWildcard({ name: 'a', allowedSkills: ['*'] })).toBe(true);
    expect(tierIsWildcard({ name: 'a', allowedSkills: ['x'] })).toBe(false);

    expect(tierAllowsSkill({ allowedSkills: [] }, SKILL)).toBe(true);
    expect(tierAllowsSkill({ allowedSkills: ['x'] }, SKILL)).toBe(false);
    expect(tierAllowsSkill({ allowedSkills: ['x', SKILL] }, SKILL)).toBe(true);
  });
});
