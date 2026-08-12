import { isPublishCapableTool } from '../utils/schedulePublishAuthorization';

/**
 * ENG-827 — every publish-capable tool in the EMMA registry must forward the
 * last-moment consent re-check.
 *
 * This registry, not the MCP one, is what a live Emma session dispatches through
 * (`mcp/client/toolRegistry.ts` attaches `assertPublishStillAuthorized` to the context
 * immediately before calling `execute`). A handler that unpacks `context.userId` and
 * drops the rest therefore loses the hook on the path that actually runs, while the
 * MCP-side registration keeps it and looks correct in review.
 *
 * That is precisely how `publish_blog_article` shipped unguarded here: its MCP twin in
 * `apiTools.ts` passed the callback and this one did not. Both registries have to be
 * checked, so this is a DRIFT GUARD over the whole registry rather than a test of one
 * tool — the next publishing tool added is the one nobody remembers to wire.
 *
 * The assertion is deliberately loose about HOW the hook is honoured, because there are
 * three legitimate mechanisms and the guard must not force one:
 *   - pass the whole `context` on, and let the callee read the hook off it;
 *   - pass the function explicitly (publish_blog_article, whose callee takes it);
 *   - INVOKE it in process, which is what a handler that then crosses the REST
 *     self-call boundary does — a closure cannot survive that hop, so the run's session
 *     id goes over instead and the route rebuilds the hook on the far side.
 * Any of the three satisfies this. Doing none of them does not.
 */

jest.mock('../services/agentModeService', () => {
  const calls: any[] = [];
  const handler: ProxyHandler<any> = {
    get: (_t, prop) => {
      if (prop === '__calls') return calls;
      return (...args: any[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve({ success: true });
      };
    },
  };
  return { agentModeService: new Proxy({}, handler), AgentModeService: jest.fn() };
});

const SENTINEL = jest.fn(async () => null);

/** Does the hook — or the context carrying it — appear anywhere in these arguments? */
const forwardsTheHook = (args: any[]): boolean =>
  args.some(
    (a) => a === SENTINEL || (a && typeof a === 'object' && a.assertPublishStillAuthorized === SENTINEL)
  );

describe('ENG-827 — the Emma registry forwards publish revalidation', () => {
  let registry: any;
  let service: any;

  beforeAll(() => {
    require('../emma/tools');
    registry = require('../emma/registry').emmaToolRegistry;
    service = require('../services/agentModeService').agentModeService;
  });

  it('registers at least one publish-capable tool (guards against a vacuous sweep)', () => {
    const publishing = registry.getAllTools().filter((t: any) => isPublishCapableTool(t.name));
    expect(publishing.length).toBeGreaterThan(0);
  });

  it('forwards the re-check from EVERY publish-capable handler', async () => {
    const publishing = registry.getAllTools().filter((t: any) => isPublishCapableTool(t.name));
    const dropped: string[] = [];

    for (const tool of publishing) {
      service.__calls.length = 0;
      SENTINEL.mockClear();
      const context = {
        userId: 'user-1',
        sessionId: 'sess-1',
        assertPublishStillAuthorized: SENTINEL,
      };

      try {
        await tool.execute(
          { account_id: 'acc-1', content: 'hi', action: 'reply', title: 't', description: 'd' },
          context
        );
      } catch {
        // A handler that rejects on incomplete args still had its chance to forward.
      }

      const honoured = SENTINEL.mock.calls.length > 0 || service.__calls.some((c: any) => forwardsTheHook(c.args));
      if (!honoured) dropped.push(tool.name);
    }

    expect(dropped).toEqual([]);
  });
});
