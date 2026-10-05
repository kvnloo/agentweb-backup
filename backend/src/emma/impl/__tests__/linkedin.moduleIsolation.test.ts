/**
 * ENG-2103 F2 — LinkedIn posting & outreach cluster (16th). Added in the
 * fresh-eyes review pass (round 1) that found this module, alone with
 * `twitter.ts`, had no module-isolation test among all 22 top-level
 * `emma/impl/*.ts` files — not a bug in the extraction itself, just a real
 * coverage gap in what proves it.
 *
 * Unlike most prior module-isolation tests, this one does NOT assert full
 * isolation from `services/db.ts` — a real, empirically confirmed (via the
 * `jest.doMock`-throws technique, not just reading import lists) transitive
 * chain exists: `linkedin.ts` statically imports `services/linkedInOutreachService.ts`,
 * which itself statically imports `./db` (the real `AWS.DynamoDB.DocumentClient`
 * -constructing module) at its own top level. So requiring `linkedin.ts` does
 * load `db.ts`'s module body.
 *
 * This is NOT a new circularity introduced by this extraction — `linkedin.ts`'s
 * cluster-16 header already documents `linkedInOutreachService.ts` as an
 * unconditionally-safe static import for a different reason (no path back to
 * `agentModeService.ts`); this test adds the narrower, previously-unstated
 * fact that it DOES reach `db.ts`. `agentModeService.ts` itself is confirmed
 * NOT reachable from this module at all — the isolation that actually matters
 * for this series' stated goal (a standalone module usable without the god
 * class) holds.
 */

describe('emma/impl/linkedin.ts transitive-import shape', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/db');
    jest.dontMock('../../../services/agentModeService');
  });

  it('does NOT import agentModeService.ts at module scope — the isolation that actually matters', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/linkedin.ts');
      });
      expect(() => require('../linkedin')).not.toThrow();
    });
  });

  it('DOES transitively load services/db.ts (via linkedInOutreachService.ts) — a known, pre-existing limitation, not a regression', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/db', () => {
        throw new Error('db.ts loaded');
      });
      expect(() => require('../linkedin')).toThrow('db.ts loaded');
    });
  });
});

/**
 * ENG-2103 (F2 fresh-eyes review round 1) — `resolveAccessibleAccount` is
 * called by two sibling functions in this same module
 * (`listLinkedInComments`, `reactToLinkedInPost`). Per the cluster-10 lesson,
 * a direct sibling call does not route through the exports-namespace object,
 * so an external `jest.spyOn(linkedinImpl, 'resolveAccessibleAccount')` would
 * silently fail to intercept those two call sites without the same-module
 * self-import (`import * as self from './linkedin'`) this review added.
 * Proves the indirection actually works, not just that it compiles — verified
 * directly by temporarily removing the `self.` prefix at both call sites and
 * confirming this exact test fails, then restoring it.
 */
describe('emma/impl/linkedin.ts self-import makes internal calls spy-observable', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('a jest.spyOn on the module namespace intercepts listLinkedInComments\'s internal resolveAccessibleAccount call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const linkedinImpl = require('../linkedin');

    const resolveSpy = jest.spyOn(linkedinImpl, 'resolveAccessibleAccount').mockResolvedValue(null);

    const result = await linkedinImpl.listLinkedInComments('user-1', 'acct-1', 'urn:li:post:1');

    // If the self-import indirection were missing, listLinkedInComments would call the
    // REAL resolveAccessibleAccount (which calls getAccountsWithOwnerIncludingOrgShared
    // and would not return null for an unmocked account lookup) instead of this mock.
    expect(resolveSpy).toHaveBeenCalledWith('user-1', 'acct-1', 'linkedin');
    expect(result).toEqual({ success: false, message: 'Account not found or access denied' });
  });

  it('a jest.spyOn on the module namespace intercepts reactToLinkedInPost\'s internal resolveAccessibleAccount call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const linkedinImpl = require('../linkedin');

    const resolveSpy = jest.spyOn(linkedinImpl, 'resolveAccessibleAccount').mockResolvedValue(null);

    const result = await linkedinImpl.reactToLinkedInPost('user-1', 'acct-1', 'urn:li:post:1');

    expect(resolveSpy).toHaveBeenCalledWith('user-1', 'acct-1', 'linkedin');
    expect(result).toEqual({ success: false, message: 'Account not found or access denied' });
  });
});
