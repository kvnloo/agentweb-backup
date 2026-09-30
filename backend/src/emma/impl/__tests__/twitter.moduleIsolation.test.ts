/**
 * ENG-2103 F2 — Twitter/X cluster (17th). Added in the fresh-eyes review pass
 * (round 1) that found this module, alone with `linkedin.ts`, had no
 * module-isolation test among all 22 top-level `emma/impl/*.ts` files.
 *
 * Unlike most prior module-isolation tests, this one does NOT assert full
 * isolation from `services/db.ts` — a real, empirically confirmed (via the
 * `jest.doMock`-throws technique, not just reading import lists — this
 * specific chain was NOT caught by cluster 17's own "confirmed safe by
 * npm run typecheck" verification, which checked `twitterService.ts`'s own
 * import list but not what ITS dependencies import) transitive chain exists:
 * `twitter.ts` statically imports `services/twitterService.ts`, which itself
 * statically imports `services/connectedAccountsDb.ts`, which imports `./db`
 * (the real `AWS.DynamoDB.DocumentClient`-constructing module) at its own top
 * level. So requiring `twitter.ts` does load `db.ts`'s module body.
 *
 * This is NOT a new circularity introduced by this extraction:
 * `agentModeService.ts` already statically imported `twitterService.ts`
 * before F2 touched this cluster (cluster 17's own header note: "matching
 * agentModeService.ts's pre-existing static import of it"), so the chain
 * `agentModeService.ts -> twitterService.ts -> connectedAccountsDb.ts -> db.ts`
 * already existed in production before this PR. `agentModeService.ts` itself
 * is confirmed NOT reachable from this module at all — the isolation that
 * actually matters for this series' stated goal (a standalone module usable
 * without the god class) holds.
 */

describe('emma/impl/twitter.ts transitive-import shape', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/db');
    jest.dontMock('../../../services/agentModeService');
  });

  it('does NOT import agentModeService.ts at module scope — the isolation that actually matters', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/twitter.ts');
      });
      expect(() => require('../twitter')).not.toThrow();
    });
  });

  it('DOES transitively load services/db.ts (via twitterService.ts -> connectedAccountsDb.ts) — a known, pre-existing limitation, not a regression', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/db', () => {
        throw new Error('db.ts loaded');
      });
      expect(() => require('../twitter')).toThrow('db.ts loaded');
    });
  });
});
