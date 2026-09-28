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

// Shared across both mocks below so the drift guard observes the forwarded
// hook regardless of which module actually owns a given tool's handler body.
const mockCalls: any[] = [];

jest.mock('../services/agentModeService', () => {
  const handler: ProxyHandler<any> = {
    get: (_t, prop) => {
      if (prop === '__calls') return mockCalls;
      return (...args: any[]) => {
        mockCalls.push({ method: String(prop), args });
        return Promise.resolve({ success: true });
      };
    },
  };
  return { agentModeService: new Proxy({}, handler), AgentModeService: jest.fn() };
});

// ENG-2103 (F2): publish_blog_article's handler body now lives in
// emma/impl/blog.ts and emma/tools.ts calls it directly instead of through
// agentModeService — mock it the same call-recording way (a plain object, not
// a Proxy, so `import * as blogImpl` in emma/tools.ts doesn't get flattened
// to an empty object by TS's esModuleInterop wildcard-import helper) so this
// registry-wide drift guard keeps observing the forwarded hook after the
// extraction.
jest.mock('../emma/impl/blog', () => ({
  createBlogArticle: jest.fn((...args: any[]) => {
    mockCalls.push({ method: 'createBlogArticle', args });
    return Promise.resolve({ success: true });
  }),
  publishBlogArticle: jest.fn((...args: any[]) => {
    mockCalls.push({ method: 'publishBlogArticle', args });
    return Promise.resolve({ success: true });
  }),
  repairBlogArticle: jest.fn((...args: any[]) => {
    mockCalls.push({ method: 'repairBlogArticle', args });
    return Promise.resolve({ success: true });
  }),
}));

// ENG-2103 (F2): post_on_connected_account's handler body now lives in
// emma/impl/linkedin.ts and emma/tools.ts calls it directly instead of
// through agentModeService — mock it the same call-recording way as
// emma/impl/blog above (a plain object, not a Proxy, so `import * as
// linkedinImpl` in emma/tools.ts doesn't get flattened to an empty object by
// TS's esModuleInterop wildcard-import helper) so this registry-wide drift
// guard keeps observing the forwarded hook after the extraction.
// linkedin_manage_post is the cluster's other publish-capable tool, but it
// still calls `agentModeService.linkedinManagePost` directly (kept on the
// class, unmoved — see emma/impl/linkedin.ts's module header), so the
// Proxy mock above already observes it; nothing else from this module needs
// mocking here.
jest.mock('../emma/impl/linkedin', () => ({
  postOnConnectedAccount: jest.fn((...args: any[]) => {
    mockCalls.push({ method: 'postOnConnectedAccount', args });
    return Promise.resolve({ success: true });
  }),
}));

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
