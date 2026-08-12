/**
 * Metering guard — the lint substitute for "charge where you record".
 *
 * Three tickets on this subsystem (ENG-200, ENG-454, ENG-1134) were all the same
 * shape: a call site that recorded without charging, or charged without recording.
 * ENG-1134 in particular shipped a comment asserting "no separate deduction path
 * exists for this call" that was simply false — and nothing made it checkable, so
 * it stayed false for three weeks while every agent-mode turn was billed twice.
 *
 * These tests make the two invariants mechanical instead of a matter of memory.
 *
 * Modelled on sdkConstructionGuard.test.ts, which does the same job for direct
 * SDK construction. Same rule applies to the allowlists here: entries come OFF as
 * call sites migrate to the chokepoint. Adding one requires a documented reason,
 * because every entry is a place the two books can silently drift apart.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC_ROOT);
const rel = (f: string) => path.relative(SRC_ROOT, f).replace(/\\/g, '/');

describe('metering guard: the quota counter is only charged from known sites', () => {
  /**
   * Charging the counter directly means the spend does NOT get a ledger row,
   * because only meterUserUsage does both. Every entry below is a deliberate
   * exception that pairs its own recordUsage elsewhere.
   */
  const ALLOWED_DIRECT_CHARGERS = new Set([
    // The chokepoint itself: records to the ledger AND charges, together.
    'services/usageRecorderService.ts',
    // The counter implementation.
    'services/tokenUsageService.ts',
    // The coding-agent loop records each of its own turns via recordUsage
    // (feature 'coding_agent') and hands its callers a usageTotals summary to
    // charge once. Recording and charging are split across the two on purpose.
    'emma/tools.ts',
    'services/codingAgentSubpageService.ts',
  ]);

  it('has no unapproved direct callers of incrementUserTokenUsage', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const r = rel(file);
      if (ALLOWED_DIRECT_CHARGERS.has(r)) continue;
      const src = fs.readFileSync(file, 'utf8');
      // Match calls, not imports/type positions.
      if (/\bincrementUserTokenUsage\s*\(/.test(src)) offenders.push(r);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest — every entry still charges directly', () => {
    // A stale allowlist is worse than none: it grants permission nobody is using
    // and hides the next real offender behind familiarity.
    const stale: string[] = [];
    for (const r of ALLOWED_DIRECT_CHARGERS) {
      const full = path.join(SRC_ROOT, r);
      if (!fs.existsSync(full)) {
        stale.push(`${r} (file no longer exists)`);
        continue;
      }
      const src = fs.readFileSync(full, 'utf8');
      if (!/\bincrementUserTokenUsage\b/.test(src)) stale.push(`${r} (no longer charges)`);
    }

    expect(stale).toEqual([]);
  });

  it('does not charge the counter from message-persistence paths', () => {
    // The specific ENG-1134 regression: chatbotService charged on every message
    // append, double-billing spend the LLM call site had already charged.
    const src = fs.readFileSync(path.join(SRC_ROOT, 'services/chatbotService.ts'), 'utf8');

    expect(/\bincrementUserTokenUsage\s*\(/.test(src)).toBe(false);
  });
});
