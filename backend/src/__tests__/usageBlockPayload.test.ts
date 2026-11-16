/**
 * ENG-1344 AC6 — the block explanation must actually REACH the client.
 *
 * Found while auditing the PR: `usageBlock` was added to the customer projection
 * and to the three interactive 429s with nothing asserting either. A field the
 * portal now renders, that no test proves is sent, is one refactor away from
 * silently vanishing — and the symptom would be a blocked customer seeing the
 * undated fallback again, which is the exact bug this row exists to fix.
 */

import fs from 'fs';
import path from 'path';
import { toCustomerTokenUsage } from '../services/tokenUsageService';
import { buildUsageBlockCopy } from '../utils/usageBlockCopy';

const baseStatus = {
  allowed: false,
  warning: false,
  used: 0,
  allowance: null,
  bonus: 0,
  effectiveAllowance: null,
  percentUsed: 0,
  month: '2026-09',
  costUsed: 42.5,
  costAllowance: 40,
  costPercentUsed: 106,
  costEnforced: true,
} as any;

describe('customer usage projection carries the block explanation', () => {
  it('ships usageBlock on /subscription/usage', () => {
    const projected = toCustomerTokenUsage(baseStatus);
    expect(projected.usageBlock).toEqual(buildUsageBlockCopy({ month: '2026-09' }));
    expect(projected.usageBlock.resetSentence).toBe(
      'Your included usage resets on October 1, 2026.'
    );
  });

  it('still redacts the dollars ENG-1212 removed — the new field reintroduces none', () => {
    const projected = toCustomerTokenUsage(baseStatus);
    expect(projected).not.toHaveProperty('costUsed');
    expect(projected).not.toHaveProperty('costAllowance');
    // The whole serialized payload, not just the top level: usageBlock is nested.
    expect(JSON.stringify(projected)).not.toMatch(/42\.5|"costAllowance"|\$/);
  });

  it('degrades without throwing when the status carries no month', () => {
    // Defensive: every runtime path sets `month` (checkTokenUsage lazily resets it,
    // and the anonymous branch sets getCurrentMonth()), but a projection that
    // throws would turn a usage read into a 500.
    const projected = toCustomerTokenUsage({ ...baseStatus, month: undefined });
    expect(projected.usageBlock.resetSentence).toBeNull();
    expect(projected.usageBlock.message).toContain('AI usage is paused');
  });
});

/**
 * Source-level, following this repo's existing `usageRunwayE2EFixture.contract.test.ts`
 * precedent. The interactive 429s sit deep inside `sendMessage` behind session
 * claims, idempotency and model-policy resolution; standing all that up would test
 * the mocks more than the payload. This asserts the narrow thing that matters —
 * every `usage_paused` refusal emits the structured block beside the flat string —
 * and is honest about being a source assertion rather than an executed one.
 */
describe('every usage_paused 429 emits the structured block', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../controllers/agentModeController.ts'),
    'utf8'
  );

  it('pairs every flat message with usageBlock', () => {
    const flat = source.match(/error: usageBlockCopy\.message,/g) || [];
    const structured = source.match(/usageBlock: usageBlockCopy,/g) || [];
    // Both interactive refusals (/generate and /verified-generate, with or without a
    // resolved policy decision) are built by the single shared buildUsagePausedBody,
    // which has two bodies: the plain one and the decision-carrying one.
    expect(flat).toHaveLength(2);
    expect(structured).toHaveLength(2);
  });

  it('composes the copy once, so the refusals cannot disagree', () => {
    expect(source).toContain('const usageBlockCopy = buildUsageBlockCopy({ month: usageStatus.month, paygBlock: usageStatus.paygBlock });');
    expect(source.match(/const usageBlockCopy = /g) || []).toHaveLength(1);
  });

  it('leaves the shared-session refusal without a date', () => {
    // The owner's billing cycle must not leak to anyone holding the share link.
    expect(source).toContain(
      "error: 'AI usage is paused for this shared session. Please contact the owner of this link.'"
    );
  });
});
