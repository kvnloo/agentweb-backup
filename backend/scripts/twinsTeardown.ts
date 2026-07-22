/**
 * Reusable Arga twin teardown (ENG-402) — `npm run test:twins:teardown`.
 *
 * Reads `.env.twins.json`, tears down the provisioned session
 * (`arga previews twins teardown <run_id>`), and removes the local config file so
 * a later `npm run test:twins` skips cleanly instead of pointing at a dead twin.
 *
 * LIVE BEHAVIOR UNVERIFIED — validate on the first real run when Arga quota is
 * available. The CLI form matches `arga previews twins teardown --help`; twins
 * also auto-expire on their TTL, so an explicit teardown is a courtesy cleanup.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { loadTwinConfig, resolveArgaBin, resolveConfigPath } from '../src/__tests__/twins/twinSession';

function main(): void {
  const configPath = resolveConfigPath();
  const config = loadTwinConfig();
  if (!config) {
    // eslint-disable-next-line no-console
    console.log(`[twinsTeardown] No twin config at ${configPath} — nothing to tear down.`);
    return;
  }

  const bin = resolveArgaBin();
  try {
    execFileSync(bin, ['previews', 'twins', 'teardown', config.runId], { stdio: 'inherit' });
    // eslint-disable-next-line no-console
    console.log(`[twinsTeardown] Torn down runId=${config.runId}.`);
  } catch (err) {
    // Twins auto-expire on their TTL, so a failed explicit teardown is non-fatal —
    // warn loud, then still remove the local config so tests don't target a dead twin.
    // eslint-disable-next-line no-console
    console.warn(
      `[twinsTeardown] teardown failed (twin may have already expired): ${(err as Error).message}`,
    );
  }

  try {
    fs.unlinkSync(configPath);
    // eslint-disable-next-line no-console
    console.log(`[twinsTeardown] Removed ${configPath}.`);
  } catch {
    /* already gone — nothing to remove */
  }
}

main();
