/**
 * Tests for GET /api/admin/agent-runs (AgentRun inspector route).
 *
 * Behavioral contract (pagination fix):
 *   - Paginates the LoopEvents query past the first Dynamo page, so runs older
 *     than the newest page of events are still found when a filter is applied.
 *   - `limit` means max RUNS returned (newest first), not max events scanned.
 *     A single chatty run emitting hundreds of events must not swamp the
 *     response window.
 *   - Pagination stops at a hard scan cap and reports `truncated: true` so a
 *     no-match filter cannot scan the table forever.
 *   - A runId filter is pushed down to Dynamo as a FilterExpression on
 *     subjectId instead of being applied only after fetch.
 *
 * Auth is enforced by middleware mounted in app.ts, not in the route file, so
 * the unit test exercises the route in isolation.
 */

import express from 'express';
import request from 'supertest';

const mockQuery = jest.fn();
const mockGet = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params: unknown) => ({ promise: () => mockQuery(params) }),
      get: (params: unknown) => ({ promise: () => mockGet(params) }),
    })),
  },
}));

import agentRunsRoutes from '../routes/agentRuns';
import { AGENT_MODE_LOOP_ID } from '../loops/instances/agent-mode/eventTypes';

interface MockPage {
  Items: unknown[];
  LastEvaluatedKey?: Record<string, unknown>;
  ScannedCount?: number;
}

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/agent-runs', agentRunsRoutes);
  return app;
};

function evt(
  runId: string,
  eventType: string,
  ts: string,
  seq: number,
  dimensions?: Record<string, unknown>,
) {
  return {
    loopId: AGENT_MODE_LOOP_ID,
    tsSession: `${ts}#${runId}#${eventType}#${seq}`,
    ts,
    subjectId: runId,
    eventType,
    dimensions,
  };
}

/** A complete run timeline: started -> decision -> tool -> completed. */
function runEvents(runId: string, sessionId: string, startIso: string) {
  const base = new Date(startIso).getTime();
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();
  return [
    evt(runId, 'agent_run_started', at(0), 1, { sessionId, userId: `user-${sessionId}` }),
    evt(runId, 'agent_decision', at(10), 2, { iteration: 1, toolNames: 'search_leads' }),
    evt(runId, 'agent_tool_invoked', at(20), 3, { iteration: 1, toolName: 'search_leads' }),
    evt(runId, 'agent_tool_succeeded', at(30), 4, { iteration: 1, toolName: 'search_leads' }),
    evt(runId, 'agent_run_completed', at(40), 5, { sessionId, toolCalls: 1, failedToolCalls: 0 }),
  ];
}

/** Queue Dynamo pages for the LoopEvents query; chat tables return empty. */
function mockLoopEventPages(pages: MockPage[]) {
  let i = 0;
  mockQuery.mockImplementation((params: { TableName: string }) => {
    if (params.TableName.includes('ChatMessages')) return Promise.resolve({ Items: [] });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return Promise.resolve(page);
  });
}

const loopEventCalls = () =>
  mockQuery.mock.calls.filter(([params]) => !params.TableName.includes('ChatMessages'));

describe('GET /api/admin/agent-runs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ Item: undefined });
  });

  it('groups a single page of events into run summaries, newest first', async () => {
    mockLoopEventPages([
      {
        Items: [
          ...runEvents('run-new', 'session-new', '2026-06-11T12:00:00.000Z'),
          ...runEvents('run-old', 'session-old', '2026-06-11T10:00:00.000Z'),
        ],
        ScannedCount: 10,
      },
    ]);

    const res = await request(buildApp()).get('/api/admin/agent-runs');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.runs[0].runId).toBe('run-new');
    expect(res.body.runs[0].sessionId).toBe('session-new');
    expect(res.body.runs[1].runId).toBe('run-old');
  });

  it('paginates past the first page to find a session filtered out of the newest events', async () => {
    mockLoopEventPages([
      {
        Items: runEvents('run-noisy', 'session-noisy', '2026-06-11T12:00:00.000Z'),
        ScannedCount: 5,
        LastEvaluatedKey: { loopId: AGENT_MODE_LOOP_ID, tsSession: 'page-1-end' },
      },
      {
        Items: runEvents('run-target', 'session-target', '2026-06-11T09:00:00.000Z'),
        ScannedCount: 5,
      },
    ]);

    const res = await request(buildApp()).get('/api/admin/agent-runs?sessionId=session-target');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.runs[0].runId).toBe('run-target');
    expect(res.body.runs[0].sessionId).toBe('session-target');
    expect(loopEventCalls().length).toBeGreaterThanOrEqual(2);
  });

  it('treats limit as max runs returned, not max events scanned', async () => {
    mockLoopEventPages([
      {
        Items: [
          ...runEvents('run-3', 'session-3', '2026-06-11T12:00:00.000Z'),
          ...runEvents('run-2', 'session-2', '2026-06-11T11:00:00.000Z'),
          ...runEvents('run-1', 'session-1', '2026-06-11T10:00:00.000Z'),
        ],
        ScannedCount: 15,
      },
    ]);

    const res = await request(buildApp()).get('/api/admin/agent-runs?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.runs.map((r: { runId: string }) => r.runId)).toEqual(['run-3', 'run-2']);
  });

  it('stops paginating at the scan cap and reports truncated for a no-match filter', async () => {
    // Every page claims 1000 scanned events and always has another page.
    mockLoopEventPages([
      {
        Items: runEvents('run-any', 'session-any', '2026-06-11T12:00:00.000Z'),
        ScannedCount: 1000,
        LastEvaluatedKey: { loopId: AGENT_MODE_LOOP_ID, tsSession: 'more' },
      },
    ]);

    const res = await request(buildApp()).get('/api/admin/agent-runs?sessionId=no-such-session');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.truncated).toBe(true);
    // 20,000 cap / 1,000 per page = 20 queries, not unbounded.
    expect(loopEventCalls().length).toBe(20);
  });

  it('pushes a runId filter down to Dynamo as a subjectId FilterExpression', async () => {
    mockLoopEventPages([
      {
        Items: runEvents('run-x', 'session-x', '2026-06-11T12:00:00.000Z'),
        ScannedCount: 5,
      },
    ]);

    const res = await request(buildApp()).get('/api/admin/agent-runs?runId=run-x');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const [params] = loopEventCalls()[0];
    expect(params.FilterExpression).toContain('subjectId');
    expect(params.ExpressionAttributeValues[':runId']).toBe('run-x');
  });
});
