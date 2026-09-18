import { validateOpeningAction } from '../utils/openingActionValidation';

describe('validateOpeningAction (ENG-1107)', () => {
  it('accepts a bounded prefetch with read tools from the skill tool set', () => {
    expect(validateOpeningAction(
      { type: 'prefetch', calls: [{ tool: 'search_posts', args: { q: 'x' } }], maxCalls: 3, timeoutMs: 15000, maxChars: 4000 },
      ['search_posts'],
    )).toBeUndefined();
  });
  it.each([
    ['missing calls', { type: 'prefetch', calls: [] }, ['search_posts']],
    ['too many calls', { type: 'prefetch', calls: [{ tool: 'a' }, { tool: 'a' }, { tool: 'a' }, { tool: 'a' }, { tool: 'a' }, { tool: 'a' }] }, ['a']],
    ['tool outside the skill set', { type: 'prefetch', calls: [{ tool: 'admin_wipe' }] }, ['search_posts']],
    ['unknown type', { type: 'generate', calls: [{ tool: 'search_posts' }] }, ['search_posts']],
    ['non-object', 'prefetch', ['search_posts']],
  ])('rejects an unsafe persisted openingAction (%s) before any execution', (_label, openingAction, toolNames) => {
    expect(validateOpeningAction(openingAction as any, toolNames)).toMatch(/.+/);
  });
  it.each([
    ['sub-millisecond timeout', 0.5],
    ['NaN timeout', NaN],
    ['zero timeout', 0],
    ['infinite timeout', Infinity],
  ])('rejects a non-enforceable timeoutMs (%s)', (_label, timeoutMs) => {
    expect(validateOpeningAction(
      { type: 'prefetch', calls: [{ tool: 'search_posts' }], timeoutMs } as any,
      ['search_posts'],
    )).toMatch(/.+/);
  });
  it('accepts undefined (no openingAction costs nothing)', () => {
    expect(validateOpeningAction(undefined, ['search_posts'])).toBeUndefined();
  });
});
