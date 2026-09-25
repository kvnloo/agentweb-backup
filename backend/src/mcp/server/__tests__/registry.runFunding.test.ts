/**
 * ENG-1816 F1 — McpToolRegistry.execute() is the shared dispatch point for BOTH
 * Emma's own in-process tool calls (already inside the worker's withRunFunding
 * scope) and genuinely external entries (an internal MCP_ACCESS_TOKEN caller
 * hitting POST /mcp directly, which never enters any scope on its own). It must
 * resolve+wrap funding for the second case, and must NOT re-resolve for the
 * first — unconditionally re-resolving would silently overwrite an outer,
 * already-correct funding decision for the duration of every nested tool call
 * inside an agent-mode turn.
 *
 * Found untested by three independent PR review rounds (2, 4, 5), each of which
 * verified this guard by reading the code, never by executing it.
 */

import { McpToolRegistry } from '../registry';
import { withRunFunding, currentRunFunding, resolveRunFunding, type RunFunding } from '../../../services/funding/runFunding';

jest.mock('../../../services/funding/runFunding', () => {
  const actual = jest.requireActual('../../../services/funding/runFunding');
  return { ...actual, resolveRunFunding: jest.fn() };
});

const mockResolveRunFunding = resolveRunFunding as jest.MockedFunction<typeof resolveRunFunding>;

const USER = 'user-1816';

function makeFunding(ownerUserId: string): RunFunding {
  return {
    route: 'agentweb',
    fallback: 'agentweb',
    ownerUserId,
    billingUserId: ownerUserId,
    resolvedAt: new Date().toISOString(),
  };
}

describe('ENG-1816 F1 — McpToolRegistry.execute() RunFunding guard', () => {
  let registry: McpToolRegistry;
  let seenFundingDuringExecute: (RunFunding | undefined)[];

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new McpToolRegistry();
    seenFundingDuringExecute = [];
    registry.register({
      name: 'noop_tool',
      definition: { name: 'noop_tool' },
      execute: jest.fn(async () => {
        seenFundingDuringExecute.push(currentRunFunding());
        return { success: true };
      }),
    });
  });

  it('resolves and enters a RunFunding scope when no ambient funding is active', async () => {
    mockResolveRunFunding.mockResolvedValue(makeFunding(USER));

    await registry.execute('noop_tool', {}, { userId: USER });

    expect(mockResolveRunFunding).toHaveBeenCalledWith({ userId: USER });
    expect(seenFundingDuringExecute).toHaveLength(1);
    expect(seenFundingDuringExecute[0]?.ownerUserId).toBe(USER);
    // The scope must not leak past execute() — the caller's ambient state is unaffected.
    expect(currentRunFunding()).toBeUndefined();
  });

  it('does NOT re-resolve when an outer scope has already set RunFunding (nested Emma tool call)', async () => {
    const outerFunding = makeFunding('outer-owner');

    await withRunFunding(outerFunding, () => registry.execute('noop_tool', {}, { userId: USER }));

    expect(mockResolveRunFunding).not.toHaveBeenCalled();
    expect(seenFundingDuringExecute).toHaveLength(1);
    // The handler must see the OUTER funding unchanged, not USER's — a fresh
    // resolve here would silently overwrite the real, already-correct decision
    // for the remainder of the outer run.
    expect(seenFundingDuringExecute[0]).toBe(outerFunding);
  });

  it('does not resolve funding when the caller supplies no userId', async () => {
    await registry.execute('noop_tool', {}, {});

    expect(mockResolveRunFunding).not.toHaveBeenCalled();
    expect(seenFundingDuringExecute).toHaveLength(1);
    expect(seenFundingDuringExecute[0]).toBeUndefined();
  });

  it('does not resolve funding when context itself is omitted', async () => {
    await registry.execute('noop_tool', {});

    expect(mockResolveRunFunding).not.toHaveBeenCalled();
    expect(seenFundingDuringExecute[0]).toBeUndefined();
  });
});
