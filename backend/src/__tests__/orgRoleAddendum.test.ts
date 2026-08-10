/**
 * ENG-954 — Emma's org-role context must match the product.
 *
 * The prior single addendum asserted "co-owner roles do not exist on this
 * platform" and was gated on `orgRole === "member"`, so an admin received no org
 * context at all. Both are now wrong; these pin the replacement.
 */
import { getEmmaSystemContext } from '../services/chatbotService';

describe('Emma org-role context', () => {
  it('never claims co-owner roles do not exist, for any role', () => {
    for (const role of ['owner', 'admin', 'member', undefined]) {
      const ctx = getEmmaSystemContext(undefined, role);
      expect(ctx).not.toMatch(/co-owner roles do not exist/i);
      expect(ctx).not.toMatch(/only one owner is supported/i);
      expect(ctx).not.toMatch(/there is only \*\*1 owner\*\*/i);
    }
  });

  it('gives an ADMIN org context — previously they got none', () => {
    const ctx = getEmmaSystemContext(undefined, 'admin');
    expect(ctx).toMatch(/the current user is an \*\*admin\*\*/i);
    expect(ctx).toMatch(/delete the organization/i);
  });

  it('tells an owner that succession is promote-then-leave', () => {
    const ctx = getEmmaSystemContext(undefined, 'owner');
    expect(ctx).toMatch(/the current user is an \*\*owner\*\*/i);
    expect(ctx).toMatch(/promote someone else to owner first/i);
  });

  it('no longer tells a member that only the owner can edit Brand Guidelines', () => {
    const ctx = getEmmaSystemContext(undefined, 'member');
    expect(ctx).toMatch(/the current user is a \*\*member\*\*/i);
    // The editors[] grant has always been able to delegate this.
    expect(ctx).toMatch(/unless\*\* an owner or admin has added them as an editor/i);
  });

  it('adds nothing for a solo user with no org role', () => {
    const solo = getEmmaSystemContext(undefined, undefined);
    expect(solo).not.toMatch(/Organization membership —/);
  });

  it('each role gets exactly one addendum, never two', () => {
    for (const role of ['owner', 'admin', 'member']) {
      const matches = getEmmaSystemContext(undefined, role).match(/## Organization membership —/g);
      expect(matches).toHaveLength(1);
    }
  });
});
