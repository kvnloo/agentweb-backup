/**
 * Run the ENG-1312 replay fixtures on their real production turns (ENG-2135).
 *
 * Usage (on Atem / a host with production read access):
 *   npx ts-node --transpile-only src/scripts/runReplayFixtures.ts
 *
 * Loads real content for every fixture a golden-set case links to (agentModeReplayFixtureSource.ts)
 * and runs the unchanged checker. Prints ids, pass/fail and char/word counts only, never content.
 * The linked sessions are the reported regressions, so a FAIL on a real fixture shows the gate
 * catches the regression it was built for (ENG-1312 AC3).
 */

import { goldenSetStoreFromEnv } from '../loops/eval/goldenSetStore';
import { loadReplayFixtures } from '../loops/eval/agentModeReplayFixtureSource';
import { checkAllReplayFixtures } from '../loops/eval/agentModeReplayFixtures';

async function main(): Promise<void> {
  const { fixtures, notes } = await loadReplayFixtures({ store: goldenSetStoreFromEnv() });
  for (const note of notes) console.log(`note: ${note}`);
  const results = checkAllReplayFixtures(fixtures);
  for (const [i, r] of results.entries()) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} [${fixtures[i].isPlaceholder ? 'placeholder' : 'real'}] ${r.reason}`);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('runReplayFixtures failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
