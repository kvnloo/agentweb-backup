import {
  classifyOpenRouterQuotaExhaustion,
  parseOpenRouterResetAt,
  resolveQuotaDeferral,
} from '../utils/openRouterKeyLimit';

describe('ENG-2758 classifyOpenRouterQuotaExhaustion', () => {
  const now = new Date('2026-10-29T17:00:00.000Z');
  const natural = new Date('2026-10-30T09:00:00.000Z');

  it('403 key-limit with reset timestamp -> key_limit + resetAt', () => {
    const err = Object.assign(
      new Error('403 Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/settings/keys - resets 2026-11-01T00:00:00.000Z'),
      { status: 403 }
    );
    const q = classifyOpenRouterQuotaExhaustion(err);
    expect(q).toEqual({ kind: 'key_limit', resetAt: '2026-11-01T00:00:00.000Z' });
    expect(resolveQuotaDeferral(q!, now, natural)).toBe('2026-11-01T00:00:00.000Z');
  });

  it('reads originalMessage when the wrapper message is generic', () => {
    const err = Object.assign(new Error('LLM call failed'), {
      originalMessage: 'Key limit exceeded (monthly limit) resets 2026-11-01T00:00:00Z',
      statusCode: 403,
    });
    expect(classifyOpenRouterQuotaExhaustion(err)?.kind).toBe('key_limit');
  });

  it('402 credits form (ENG-2156) -> credits', () => {
    const err = Object.assign(
      new Error('402 This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 1200.'),
      { status: 402 }
    );
    const q = classifyOpenRouterQuotaExhaustion(err);
    expect(q).toEqual({ kind: 'credits' });
    // no reset -> next natural occurrence, never a short retry
    expect(resolveQuotaDeferral(q!, now, natural)).toBe(natural.toISOString());
  });

  it('unrelated 403 is not quota exhaustion', () => {
    const err = Object.assign(new Error('403 Forbidden: model not allowed for this key'), { status: 403 });
    expect(classifyOpenRouterQuotaExhaustion(err)).toBeNull();
    expect(classifyOpenRouterQuotaExhaustion(new Error('429 rate limited'))).toBeNull();
    expect(classifyOpenRouterQuotaExhaustion(undefined)).toBeNull();
  });

  it('key-limit with missing reset timestamp -> natural next occurrence', () => {
    const err = Object.assign(new Error('Key limit exceeded (monthly limit)'), { status: 403 });
    const q = classifyOpenRouterQuotaExhaustion(err);
    expect(q).toEqual({ kind: 'key_limit' });
    expect(resolveQuotaDeferral(q!, now, natural)).toBe(natural.toISOString());
  });

  it('a reset already in the past falls back to natural next', () => {
    expect(resolveQuotaDeferral({ kind: 'key_limit', resetAt: '2026-10-01T00:00:00.000Z' }, now, natural))
      .toBe(natural.toISOString());
    expect(parseOpenRouterResetAt('resets not-a-date')).toBeUndefined();
  });
});
