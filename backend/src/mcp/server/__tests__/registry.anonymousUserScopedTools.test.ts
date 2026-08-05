/**
 * ENG-822 — an anonymous visitor must never receive `User not found`.
 *
 * Observed in `Dev-AW-LoopEvents` (Jul 28 – Aug 1): 8 failures across 2
 * anonymous sessions, every one `read_brand_guidelines` / `read_market_strategy`
 * with `args={}` and `errorMessage = "User not found"`, each session retrying
 * twice. Emma reasonably reached for an account-scoped tool, the handler did a
 * user lookup that structurally cannot succeed for an `anon_…` id, and the
 * visitor saw a database-sounding error about their own existence.
 *
 * These are a first-impression surface — usually a prospect trying the product.
 *
 * The gate lives at `McpToolRegistry.execute()` because that is the single point
 * every Emma tool call passes through, so one check covers every user-scoped
 * tool rather than a per-handler list that rots silently.
 */

import { McpToolRegistry } from '../registry';

const ANON = 'anon_7f416dbf-0000-0000-0000-000000000000';
const REAL = '1743956381327';

describe('ENG-822 — user-scoped tools refuse anonymous sessions', () => {
  let registry: McpToolRegistry;
  let handler: jest.Mock;

  beforeEach(() => {
    registry = new McpToolRegistry();
    handler = jest.fn().mockResolvedValue({ success: true, guidelines: 'real data' });
    registry.register({
      name: 'read_brand_guidelines',
      definition: { name: 'read_brand_guidelines' },
      requiresUserAccount: true,
      execute: handler,
    });
    registry.register({
      name: 'search_web',
      definition: { name: 'search_web' },
      execute: jest.fn().mockResolvedValue({ success: true, results: [] }),
    });
  });

  it('does not run the handler at all for an anonymous session', async () => {
    // The handler is where the failing lookup lives. Not reaching it is the
    // fix; catching its error afterwards would still burn the round trip.
    await registry.execute('read_brand_guidelines', {}, { userId: ANON });

    expect(handler).not.toHaveBeenCalled();
  });

  it('returns an actionable sign-in message, never "User not found"', async () => {
    const result: any = await registry.execute('read_brand_guidelines', {}, { userId: ANON });

    expect(result.deferred).toBe(true);
    expect(result.success).toBeUndefined(); // NOT success:false — that becomes agent_tool_failed
    expect(JSON.stringify(result)).not.toMatch(/user not found/i);
    expect(result.message).toMatch(/sign in/i);
  });

  it('tells the model not to retry, because both sessions retried twice', async () => {
    // Each observed session hit this twice, so the visitor waited through two
    // dead calls. The refusal has to read as terminal, not transient.
    const result: any = await registry.execute('read_brand_guidelines', {}, { userId: ANON });

    expect(result.retryable).toBe(false);
  });

  it('refuses when there is no userId at all, not just an anon_ prefix', async () => {
    // Fails closed: an absent id cannot identify an account either.
    const result: any = await registry.execute('read_brand_guidelines', {}, {});

    expect(result.deferred).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves signed-in behaviour completely unchanged', async () => {
    const result: any = await registry.execute('read_brand_guidelines', {}, { userId: REAL });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, guidelines: 'real data' });
  });

  it('does not touch tools that work fine without an account', async () => {
    // Public tools are the whole point of an anonymous session — gating them
    // would trade one broken first impression for a worse one.
    const result: any = await registry.execute('search_web', { q: 'x' }, { userId: ANON });

    expect(result.success).toBe(true);
  });

  it('names the tool in the refusal so the model can explain it', async () => {
    const result: any = await registry.execute('read_brand_guidelines', {}, { userId: ANON });

    expect(result.message).toContain('read_brand_guidelines');
  });
});

/**
 * The flags themselves. Identified mechanically rather than by guesswork: every
 * `agentModeService` method that returns `message: 'User not found'` was traced
 * back to the tool that calls it. Under-flagging leaves the bug; over-flagging
 * would break working anonymous flows, which is why this list is derived rather
 * than assumed.
 */
describe('ENG-822 — the account-scoped tools are actually flagged', () => {
  const EXPECTED = [
    'read_brand_guidelines',
    'update_brand_guidelines',
    'read_market_strategy',
    'update_market_strategy',
    'regenerate_market_strategy',
  ];

  it.each(EXPECTED)('%s is marked requiresUserAccount', (name) => {
    const { emmaToolRegistry } = require('../../../emma/registry');
    require('../../../emma/tools');
    expect(emmaToolRegistry.getTool(name)?.requiresUserAccount).toBe(true);
  });

  it('does not flag a public tool', () => {
    // The two observed anonymous sessions were prospects. Gating general tools
    // would trade one broken first impression for a worse one.
    const { emmaToolRegistry } = require('../../../emma/registry');
    require('../../../emma/tools');
    expect(emmaToolRegistry.getTool('search_web')?.requiresUserAccount).toBeFalsy();
  });
});
