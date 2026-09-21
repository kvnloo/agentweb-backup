/**
 * ENG-822 — the guard has to be on the path a real request takes.
 *
 * The first version of this fix put the check only in `McpToolRegistry`
 * (mcp/server/registry.ts), where Emma's tools are *declared*. A live Emma
 * session does not dispatch through that registry: `registerTools()` copies each
 * handler into `ToolRegistry` (this file's subject) as `{name, definition,
 * execute}`, which silently dropped the flag. Every unit test passed and the
 * production behaviour was unchanged — a fix that looks done and does nothing.
 *
 * These tests exist so that cannot recur: they exercise the copy shape and the
 * live registry, not the declaration.
 */

import { ToolRegistry, ToolContext } from '../toolRegistry';

const ANON = 'anon_7f416dbf-0000-0000-0000-000000000000';
const REAL = '1743956381327';

const ctx = (userId: string): ToolContext => ({
  userId,
  sessionId: 'session-1',
  llmModel: 'claude-opus-5',
  service: {},
});

describe('ENG-822 — the live Emma dispatch path enforces the anonymous refusal', () => {
  let registry: ToolRegistry;
  let handler: jest.Mock;

  beforeEach(() => {
    registry = new ToolRegistry();
    handler = jest.fn().mockResolvedValue({ success: false, message: 'User not found' });
    // Registered exactly the way agentModeService.registerTools() does it.
    registry.register({
      name: 'read_brand_guidelines',
      definition: { type: 'function', function: { name: 'read_brand_guidelines' } },
      execute: handler,
      requiresUserAccount: true,
    });
  });

  it('refuses before the handler runs, so `User not found` is unreachable', async () => {
    const result: any = await registry.execute('read_brand_guidelines', {}, ctx(ANON));

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/user not found/i);
    expect(result.message).toMatch(/sign in/i);
    expect(result.retryable).toBe(false);
    // Deferred, not failed: `success:false` is converted to an Error by
    // utils/toolResultError and would file this as agent_tool_failed.
    expect(result.deferred).toBe(true);
    expect(result.success).toBeUndefined();
  });

  it('still runs the handler for a signed-in session', async () => {
    handler.mockResolvedValue({ success: true, guidelines: 'real' });

    const result: any = await registry.execute('read_brand_guidelines', {}, ctx(REAL));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, guidelines: 'real' });
  });

  it('leaves unflagged tools alone', async () => {
    const publicHandler = jest.fn().mockResolvedValue({ success: true });
    registry.register({
      name: 'search_web',
      definition: { type: 'function', function: { name: 'search_web' } },
      execute: publicHandler,
    });

    await registry.execute('search_web', {}, ctx(ANON));

    expect(publicHandler).toHaveBeenCalledTimes(1);
  });

  it('the flag survives the REAL registerTools() copy into the live registry', async () => {
    // The assertion that would have caught the original miss, and the one my
    // first attempt got wrong: hand-building the copied object only proves the
    // registry works on a shape I chose. This drives agentModeService's actual
    // copy, so if `requiresUserAccount` is ever dropped there again, this fails.
    const { agentModeService } = require('../../../services/agentModeService');
    await (agentModeService as any).registerTools();
    const live = (agentModeService as any).toolRegistry;

    for (const name of [
      'read_brand_guidelines',
      'update_brand_guidelines',
      'read_market_strategy',
      'update_market_strategy',
      'regenerate_market_strategy',
    ]) {
      expect(live.getTool(name)?.requiresUserAccount).toBe(true);
    }
  }, 60_000);

  it('an anonymous call through the REAL live registry is refused', async () => {
    const { agentModeService } = require('../../../services/agentModeService');
    await (agentModeService as any).registerTools();
    const live = (agentModeService as any).toolRegistry;

    const result: any = await live.execute('read_brand_guidelines', {}, ctx(ANON));

    expect(JSON.stringify(result)).not.toMatch(/user not found/i);
    expect(result.message).toMatch(/sign in/i);
  }, 60_000);
});

/**
 * AC4 — "zero `agent_tool_failed` events". The refusal has to stay out of the
 * failure ratio, not merely avoid the words "User not found".
 *
 * `utils/toolResultError.ts` turns ANY result with `success: false` into an
 * Error, which the dispatcher then records via `recorder.toolFailed`. So a
 * refusal shaped as `{success:false}` would read correctly to the user and still
 * file a failure, inflate `failedRunRate`, and feed the failure-cluster policy
 * that auto-files ENG issues. This pins the shape that avoids that.
 */
describe('ENG-822 — the refusal is accounted as deferred, never as a failure', () => {
  it('is not classified as a tool error', () => {
    const { toolResultError } = require('../../../utils/toolResultError');
    const { buildAnonymousToolRefusal } = require('../../anonymousToolAccess');

    expect(toolResultError(buildAnonymousToolRefusal('read_brand_guidelines'))).toBeNull();
  });

  it('would have been classified as an error if shaped as success:false', () => {
    // The control that proves the assertion above is meaningful rather than
    // vacuous — this is exactly the shape the first version of the fix used.
    const { toolResultError } = require('../../../utils/toolResultError');

    expect(toolResultError({ success: false, message: 'Sign in to use …' })).toBeInstanceOf(Error);
  });

  it('carries a named reason so deferrals stay distinguishable in telemetry', () => {
    const { buildAnonymousToolRefusal, ANONYMOUS_REFUSAL_REASON } = require('../../anonymousToolAccess');
    const refusal: any = buildAnonymousToolRefusal('read_market_strategy');

    expect(refusal.deferred).toBe(true);
    expect(refusal.reason).toBe(ANONYMOUS_REFUSAL_REASON);
    // Must not collide with the media-budget deferral, which has its own reason.
    expect(refusal.reason).not.toBe('media_generation_time_budget');
  });
});
