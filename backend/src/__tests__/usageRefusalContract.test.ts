/**
 * ENG-1344 AC6 / ENG-1212 AC4 — every quota refusal comes from one producer and
 * leaks no dollars.
 *
 * Found while investigating why AC6 was "enabled but not demonstrated": the MCP
 * surface DOES have a consumer (`middleware/emmaTokenBudget.ts`, ENG-973), and it
 * carried two live defects that the portal-side work never touched.
 *
 *  1. `tokenUsage: usageStatus` sent the RAW status. `costUsed` and
 *     `costAllowance` — internal USD — reached every over-quota MCP caller and
 *     every socket client. ENG-1212 AC4 closed this on `/usage` and `chatbot.ts`
 *     and missed both of these surfaces.
 *  2. "Monthly token limit reached. Please contact support or upgrade your plan."
 *     names a unit that has not gated anyone since ENG-1116 flipped enforcement
 *     to cost, and offers no reset date — the dead end ENG-1035 was raised about.
 *
 * These assert the CONTRACT (one producer, no dollars) rather than the literal
 * strings, so rewording the copy in `usageBlockCopy` cannot break them while
 * forking a surface off the shared producer does.
 */

import { buildUsageBlockCopy } from '../utils/usageBlockCopy';
import { toCustomerTokenUsage } from '../services/tokenUsageService';
import fs from 'fs';
import path from 'path';

const RAW_STATUS = {
  allowed: false, warning: false, used: 1_050_000, allowance: 1_000_000, bonus: 0,
  effectiveAllowance: 1_000_000, percentUsed: 105, month: '2026-09',
  costUsed: 42.5, costAllowance: 40, costPercentUsed: 106, costEnforced: true,
} as any;

const SURFACES = [
  'src/middleware/emmaTokenBudget.ts',
  'src/services/chatSocketHandler.ts',
  'src/controllers/chatbot.ts',
];

describe('every quota refusal shares one producer (ENG-1344 AC6)', () => {
  it.each(SURFACES)('%s composes its refusal from buildUsageBlockCopy', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    expect(src).toContain('buildUsageBlockCopy');
    // The literal it replaced must not creep back in beside it.
    expect(src).not.toContain('Monthly token limit reached. Please contact support');
  });

  it('no surface hands a client the raw status', () => {
    for (const rel of SURFACES) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
      // Comments are stripped first: the fix's own explanation quotes the bad
      // pattern verbatim, and a guard that trips on prose describing the defect
      // is a guard that has to be worded around rather than one that holds.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toMatch(/tokenUsage:\s*usageStatus\b/);
      expect(code).toContain('toCustomerTokenUsage(usageStatus)');
    }
  });
});

describe('the projected payload carries no internal dollars (ENG-1212 AC4)', () => {
  it('drops costUsed and costAllowance', () => {
    const projected = toCustomerTokenUsage(RAW_STATUS);
    expect(projected).not.toHaveProperty('costUsed');
    expect(projected).not.toHaveProperty('costAllowance');
    expect(JSON.stringify(projected)).not.toMatch(/42\.5|"costAllowance"/);
  });

  it('keeps the percentage, which is what a client renders', () => {
    expect(toCustomerTokenUsage(RAW_STATUS).costPercentUsed).toBe(106);
  });

  it('the block copy itself names no unit and no dollars', () => {
    const copy = buildUsageBlockCopy({ month: RAW_STATUS.month });
    expect(JSON.stringify(copy)).not.toMatch(/\$|token|dollar/i);
    expect(copy.resetSentence).toBe('Your included usage resets on October 1, 2026.');
  });
});
