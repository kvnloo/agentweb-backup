## ENG-2113: turn-preamble golden file updated for the Smartlead push tools (2026-10-28)

The ENG-2113 PR C0 golden test (`agentModeService.prepareTurnContext.golden.test.ts`) pins the exact tool list the turn preamble offers. ENG-673 (c26c6e72f) added eight Smartlead push tools to the foundation set, so all 17 fixtures failed on main (CI runs no jest suites, so main stayed green). Regenerated with `UPDATE_GOLDEN=1`: the diff is exactly those eight names added to each fixture, nothing removed or reordered. Test-only change.
