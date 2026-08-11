/**
 * ENG-1082 — Emma's release-notes corpus is loaded into her knowledge base as
 * source `user-release` (chatbotService.ts). The 2026-05-12 entry states that
 * "co-owner roles do not exist", which ENG-954 made false on 2026-08-09.
 *
 * The fix is additive: release notes are a dated historical record, so the May
 * entry stays exactly as written and a later-dated entry carries the current
 * fact. These tests pin both halves.
 */
import { userReleaseNotes } from '../docs/user-release';

const entriesFor = (date: string) => userReleaseNotes.filter((n) => n.date === date);
const textFor = (date: string) => entriesFor(date).flatMap((n) => n.changes).join('\n');

describe('user release notes — org access control (ENG-954)', () => {
  it('has an entry dated 2026-08-09', () => {
    expect(entriesFor('2026-08-09')).toHaveLength(1);
  });

  it('states that an organization can have multiple owners and multiple admins', () => {
    const text = textFor('2026-08-09');
    expect(text).toMatch(/more than one owner|multiple owners/i);
    expect(text).toMatch(/admin/i);
  });

  it('names the three roles: owner, admin, member', () => {
    const text = textFor('2026-08-09').toLowerCase();
    expect(text).toContain('owner');
    expect(text).toContain('admin');
    expect(text).toContain('member');
  });

  it('states that only an owner can grant or revoke the owner role, remove an owner, or delete the org', () => {
    const text = textFor('2026-08-09');
    expect(text).toMatch(/only an owner/i);
    expect(text).toMatch(/delete the organi[sz]ation/i);
    expect(text).toMatch(/last owner|at least one owner/i);
  });

  // Greptile P1 on #2350: the first draft said owners "manage billing", which is
  // false — billing hangs off the singular billing root (`org.ownerUserId`) whose
  // personal Stripe customer holds the subscription (routes/org.ts
  // `billingRootMayDepart`). A non-billing-root owner hitting the billing routes
  // mutates their own subscription and leaves the org's plan unchanged.
  it('does not claim that every owner can manage the organization’s billing', () => {
    const text = textFor('2026-08-09');
    expect(text).not.toMatch(/owners can do everything[^\n]*manage billing/i);
    expect(text).toMatch(/only that person can change the plan/i);
  });

  it('leaves the 2026-05-12 historical entry untouched', () => {
    const may = textFor('2026-05-12');
    expect(may).toMatch(/co-owner roles do not exist/i);
  });

  it('carries the current fact on a later date than the superseded May entry', () => {
    const dates = userReleaseNotes.map((n) => n.date);
    expect(dates.indexOf('2026-08-09')).toBeLessThan(dates.indexOf('2026-05-12'));
    expect(new Date('2026-08-09').getTime()).toBeGreaterThan(new Date('2026-05-12').getTime());
  });
});
