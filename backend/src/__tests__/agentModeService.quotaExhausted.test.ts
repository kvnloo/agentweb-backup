/**
 * ENG-2763: the service-side classification that agentModeService.generateMarketingResponse
 * applies in its catch — a mocked OpenRouter 403 "Key limit exceeded" maps to the
 * quota-exhausted class (QUOTA_EXHAUSTED_USER_MESSAGE), not the generic unknown error.
 */
import { classifyOpenRouterQuotaExhaustion } from '../utils/openRouterKeyLimit';
import { QUOTA_EXHAUSTED_USER_MESSAGE, isQuotaExhaustedError } from '../utils/agentModeErrors';
import * as fs from 'fs';
import * as path from 'path';

describe('ENG-2763 Agent Mode quota-exhausted classification', () => {
  const openRouter403: any = Object.assign(
    new Error('403 Key limit exceeded (monthly limit). $800.23 of $800.00 used; resets 2026-11-01T00:00:00.000Z.'),
    { status: 403 },
  );

  it('classifies the mocked 403 as key_limit with reset', () => {
    expect(classifyOpenRouterQuotaExhaustion(openRouter403)).toEqual({ kind: 'key_limit', resetAt: '2026-11-01T00:00:00.000Z' });
  });

  it('classifies the 402 credits shape as credits even though its text looks like a context/400 error', () => {
    const credits402: any = Object.assign(
      new Error('402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1234.'),
      { status: 402 },
    );
    expect(classifyOpenRouterQuotaExhaustion(credits402)).toEqual({ kind: 'credits' });
  });

  it('user message is specific and does not invite retry spam', () => {
    expect(QUOTA_EXHAUSTED_USER_MESSAGE).toMatch(/at capacity/i);
    expect(QUOTA_EXHAUSTED_USER_MESSAGE).not.toMatch(/try again/i);
    expect(isQuotaExhaustedError(new Error(QUOTA_EXHAUSTED_USER_MESSAGE))).toBe(true);
    expect(isQuotaExhaustedError(new Error('I apologize, but I encountered an error processing your request. Please try again.'))).toBe(false);
  });

  it('generateMarketingResponse catch routes the class before the generic fallback', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/agentModeService.ts'), 'utf8');
    const quotaIdx = src.indexOf('userMessage = QUOTA_EXHAUSTED_USER_MESSAGE;');
    const genericIdx = src.indexOf("userMessage = 'I apologize, but I encountered an error processing your request. Please try again.';");
    expect(quotaIdx).toBeGreaterThan(0);
    expect(quotaIdx).toBeLessThan(genericIdx);
    // The quota check must precede the context-limit/400 branch, whose patterns the
    // credits 402 text can match (Opslane P1 on #3842).
    const contextIdx = src.indexOf("} else if (isContextLimit || httpStatus === 400) {");
    expect(contextIdx).toBeGreaterThan(0);
    expect(quotaIdx).toBeLessThan(contextIdx);
  });

  it('forced-synthesis transient fallback excludes quota errors so they reach the classifier', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/agentModeService.ts'), 'utf8');
    expect(src).toContain('!classifyOpenRouterQuotaExhaustion(callError) && isTransientLLMError(callError)');
  });
});
