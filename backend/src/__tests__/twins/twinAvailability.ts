/**
 * Shared availability guard for the opt-in Arga twin suites (ENG-401/ENG-402).
 *
 * A twin suite can only run when the Arga CLI is authenticated AND the account
 * can actually provision a twin. On the free plan, provisioning is metered
 * against a monthly "validation run" quota (`arga whoami` →
 * "Validation runs: N/10 remaining this month"); when it hits 0, `provision`
 * rejects with a hard limit error. Rather than let that surface as a RED suite
 * (these suites are opt-in and never gate a merge), we detect it up front and
 * SKIP with a clear reason. Any other provisioning failure still throws (fails
 * loud) inside the individual suite.
 *
 * Not a `*.test.ts` file, so Jest never treats it as a suite.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

export interface TwinRunner {
  /** Path to an authenticated Arga CLI, or null if none is available. */
  arga: string | null;
  /** Non-null → the suite must skip; the string explains why. */
  skipReason: string | null;
}

const NO_ARGA = 'Arga CLI not authenticated (run `arga login`)';

/**
 * Locate an authenticated Arga CLI and decide whether a twin can be provisioned.
 * Runs `arga whoami` once and inspects the plan + remaining validation-run quota.
 */
export function resolveTwinRunner(): TwinRunner {
  const candidates = ['arga', path.join(process.env.HOME || '', '.local/bin/arga')];
  for (const bin of candidates) {
    let out: string;
    try {
      out = execFileSync(bin, ['whoami'], { encoding: 'utf8' });
    } catch {
      continue; // not this binary / not authenticated — try the next
    }
    const plan = (/Plan:\s*(\w+)/i.exec(out)?.[1] ?? 'unknown').toLowerCase();
    // Paid/team plans are not capped by the free monthly quota — attempt provisioning.
    if (plan !== 'free' && plan !== 'unknown') {
      return { arga: bin, skipReason: null };
    }
    const m = /Validation runs:\s*(\d+)\s*\/\s*(\d+)\s*remaining/i.exec(out);
    if (!m) {
      // whoami format changed — don't guess; attempt provisioning and let it fail loud.
      return { arga: bin, skipReason: null };
    }
    const remaining = parseInt(m[1], 10);
    return remaining > 0
      ? { arga: bin, skipReason: null }
      : {
          arga: bin,
          skipReason: `Arga free-plan monthly validation-run quota exhausted (0/${m[2]}) — cannot provision a twin`,
        };
  }
  return { arga: null, skipReason: NO_ARGA };
}
