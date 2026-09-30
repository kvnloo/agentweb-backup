jest.mock('../services/evaluationPolicy', () => ({
  enforceEvaluationTool: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: jest.fn((_name: string, context: any) => context),
}));

jest.mock('../services/funding/runFunding', () => ({
  currentRunFunding: jest.fn(() => ({ source: 'test' })),
  resolveRunFunding: jest.fn().mockResolvedValue({ source: 'test' }),
  withRunFunding: jest.fn(async (_funding: any, fn: () => Promise<any>) => fn()),
}));

import { ToolRegistry } from '../mcp/client/toolRegistry';
import { McpToolRegistry } from '../mcp/server/registry';
import {
  getReliabilityEventSink,
  setReliabilityEventSinkForTests,
} from '../services/reliabilityEventSink';

function freshSink() {
  setReliabilityEventSinkForTests(null);
  const sink = getReliabilityEventSink({
    RELIABILITY_EVENT_SINK: 'memory',
  } as NodeJS.ProcessEnv);
  setReliabilityEventSinkForTests(sink);
  return sink;
}

describe('tool-boundary reliability recording', () => {
  beforeEach(() => {
    delete process.env.Z0INT_AGENTWEB_OBSERVE;
  });

  afterEach(() => {
    setReliabilityEventSinkForTests(null);
    delete process.env.Z0INT_AGENTWEB_OBSERVE;
  });

  it('records a live Emma handler result exactly once', async () => {
    const sink = freshSink();
    const registry = new ToolRegistry();
    registry.register({
      name: 'fixture_tool',
      definition: { name: 'fixture_tool', inputSchema: { type: 'object' } },
      execute: jest.fn().mockResolvedValue({ success: true }),
    });

    const result = await registry.execute('fixture_tool', {}, {
      userId: 'user-1',
      sessionId: 'session-1',
      llmModel: 'test',
      service: {},
    });

    expect(result).toEqual({ success: true });
    const events = sink.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'fixture_tool',
      outcome: 'success',
      sessionId: 'session-1',
      userId: 'user-1',
      platform: 'emma_live',
    });
  });

  it('records a thrown live handler error and rethrows it', async () => {
    const sink = freshSink();
    const registry = new ToolRegistry();
    registry.register({
      name: 'broken_tool',
      definition: { name: 'broken_tool', inputSchema: { type: 'object' } },
      execute: jest.fn().mockRejectedValue(new Error('fixture failure')),
    });

    await expect(registry.execute('broken_tool', {}, {
      userId: 'user-2',
      sessionId: 'session-2',
      llmModel: 'test',
      service: {},
    })).rejects.toThrow('fixture failure');

    const events = sink.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'broken_tool',
      outcome: 'error',
      errorSummary: 'fixture failure',
      platform: 'emma_live',
    });
  });

  it('records external MCP refusal without running the internal-only handler', async () => {
    const sink = freshSink();
    const registry = new McpToolRegistry();
    const execute = jest.fn();
    registry.register({
      name: 'internal_fixture',
      internalOnly: true,
      definition: { name: 'internal_fixture', inputSchema: { type: 'object' } },
      execute,
    });

    await expect(registry.execute('internal_fixture', {}, {
      userId: 'user-3',
      sessionId: 'session-3',
      externalMcp: true,
    })).rejects.toThrow(/not available to external clients/i);

    expect(execute).not.toHaveBeenCalled();
    const events = sink.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'internal_fixture',
      outcome: 'error',
      platform: 'external_mcp',
    });
  });
});
