/**
 * ENG-589 acceptance tests: the agent-mode failure-cluster analysis files major clusters into
 * Linear through the ENG-240 intake rail. The REAL rule set + REAL fileAutoIssue run against an
 * in-memory fake of linearService (AC5: Linear port and cluster store are mocked; no live account).
 */

type FakeIssue = { id: string; identifier: string; title: string; description: string; state: 'open' | 'closed'; labels: string[] };
const store: { issues: FakeIssue[]; comments: { issueId: string; body: string }[]; n: number } = { issues: [], comments: [], n: 1000 };

jest.mock('../services/linearService', () => ({
  listOpenIssuesByLabel: jest.fn(async (label: string) =>
    store.issues
      .filter((i) => i.state === 'open' && i.labels.includes(label))
      .map((i) => ({ identifier: i.identifier, issueId: i.id, title: i.title, description: i.description }))),
  findMostRecentClosedIssueByLabel: jest.fn(async (label: string, isMatch: (i: any) => boolean) =>
    store.issues
      .filter((i) => i.state === 'closed' && i.labels.includes(label))
      .map((i) => ({ identifier: i.identifier, issueId: i.id, title: i.title, description: i.description }))
      .reverse()
      .find(isMatch) ?? null),
  findMostRecentArchivedIssueByLabel: jest.fn(async () => null),
  createInternalLinearIssue: jest.fn(async (p: any) => {
    const n = ++store.n;
    const issue: FakeIssue = { id: `uuid-${n}`, identifier: `ENG-${n}`, title: p.title, description: p.description, state: 'open', labels: p.labelNames };
    store.issues.push(issue);
    return { id: issue.id, identifier: issue.identifier, url: `https://linear.app/x/${issue.identifier}` };
  }),
  addIssueComment: jest.fn(async (issueId: string, body: string) => { store.comments.push({ issueId, body }); }),
  getIssueCommentsDetailed: jest.fn(async (issueId: string) => store.comments.filter((c) => c.issueId === issueId)),
  escalateIssue: jest.fn(async () => undefined),
  markIssueDuplicateOf: jest.fn(async () => undefined),
  reopenIssue: jest.fn(async (issueId: string) => {
    const i = store.issues.find((x) => x.id === issueId);
    if (i) i.state = 'open';
  }),
}));

import { AgentFailureRuleSet } from '../loops/instances/agent-mode/failureRuleSet';
import { ClusterIntakeTool } from '../loops/instances/agent-mode/clusterIntakeTool';
import { EVT_TOOL_FAILED, EVT_TOOL_INVOKED } from '../loops/instances/agent-mode/eventTypes';
import type { NormalizedEvent } from '../loops/core/types';
import { asSubjectId } from '../loops/core/types';

const WINDOW = { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-08T00:00:00Z') };
let seq = 0;
function evt(eventType: string, extra: Record<string, string> = {}): NormalizedEvent {
  seq++;
  return {
    subjectId: asSubjectId(`run-${seq}`),
    eventType,
    ts: new Date('2026-06-04T00:00:00Z'),
    dimensions: { toolName: 'save_memory', sessionId: `sess-${seq}`, ...extra },
  };
}
function windowEvents(invocations: number, failures: number): NormalizedEvent[] {
  return [
    ...Array.from({ length: invocations }, () => evt(EVT_TOOL_INVOKED)),
    ...Array.from({ length: failures }, () => evt(EVT_TOOL_FAILED, { errorClass: 'TimeoutError', failureType: 'bug' })),
  ];
}

async function runTick(invocations: number, failures: number, isProduction = true) {
  const proposals = await new AgentFailureRuleSet().evaluate(windowEvents(invocations, failures), WINDOW);
  const tool = new ClusterIntakeTool({ isProduction: () => isProduction });
  return Promise.all(proposals.map((p) => tool.apply(p)));
}

beforeEach(() => {
  store.issues = [];
  store.comments = [];
});

describe('ENG-589 failure-cluster → Linear intake', () => {
  it('AC1: an over-threshold cluster with no existing issue files exactly one Auto issue with stats + traces', async () => {
    const mutations = await runTick(10, 5);
    expect(mutations).toHaveLength(1);
    expect(store.issues).toHaveLength(1);
    const [issue] = store.issues;
    expect(issue.labels).toEqual(expect.arrayContaining(['Auto', 'Needs PM']));
    expect(issue.labels).not.toContain('autofix');
    expect(issue.description).toContain('## Cluster stats');
    expect(issue.description).toContain('"failures": 5');
    expect(issue.description).toMatch(/## Sample traces\n- run run-\d+ \(session sess-\d+\)\n- run .*\n- run .*\n\n/);
    expect(issue.description).toContain('Acceptance criteria (stub');
    expect(issue.description).toMatch(/Alert Class: agent-mode:save_memory:bug\s*$/m);
    expect(mutations[0].artifact).toMatchObject({ fixSpec: expect.any(Object), intake: { deduped: false } });
  });

  it('AC2: the same cluster firing again while open adds an occurrence comment, not a duplicate', async () => {
    await runTick(10, 5);
    const again = await runTick(12, 6);
    expect(store.issues).toHaveLength(1);
    expect(again[0].artifact).toMatchObject({ intake: { deduped: true, pageId: store.issues[0].identifier } });
    expect(store.comments.filter((c) => c.issueId === store.issues[0].id)).toHaveLength(1);
  });

  it('AC3: the cluster recurring after its issue closed reopens that issue; no new issue', async () => {
    await runTick(10, 5);
    store.issues[0].state = 'closed';
    const recur = await runTick(10, 5);
    expect(store.issues).toHaveLength(1);
    expect(store.issues[0].state).toBe('open');
    expect(recur[0].artifact).toMatchObject({ intake: { deduped: true, reopened: true, pageId: store.issues[0].identifier } });
    expect(store.comments.some((c) => c.issueId === store.issues[0].id && c.body.startsWith('Reopened'))).toBe(true);
  });

  it('ENG-1099: outside production a closed canonical is NOT reopened or commented on', async () => {
    await runTick(10, 5);
    store.issues[0].state = 'closed';
    const commentsBefore = store.comments.length;
    const recur = await runTick(10, 5, false);
    expect(store.issues[0].state).toBe('closed');
    expect(store.comments).toHaveLength(commentsBefore);
    expect(recur[0].artifact).toMatchObject({ intake: { suppressed: true } });
  });

  it('AC3: overlapping runs on one closed canonical reopen and comment exactly once', async () => {
    await runTick(10, 5);
    store.issues[0].state = 'closed';
    const proposals = await new AgentFailureRuleSet().evaluate(windowEvents(10, 5), WINDOW);
    const tool = new ClusterIntakeTool({ isProduction: () => true });
    const [a, b] = await Promise.all([tool.apply(proposals[0]), tool.apply(proposals[0])]);
    expect(store.issues).toHaveLength(1);
    expect(store.comments.filter((c) => c.body.startsWith('Reopened'))).toHaveLength(1);
    expect([a, b].filter((m: any) => m.artifact.intake.reopened === true)).toHaveLength(1);
  });

  it('AC3: a closed issue of a DIFFERENT class is never reopened', async () => {
    store.issues.push({
      id: 'uuid-x', identifier: 'ENG-1', title: 'other', state: 'closed', labels: ['Auto'],
      description: '- Alert Class: agent-mode:save_memory:bug-extra',
    });
    await runTick(10, 5);
    expect(store.issues.find((i) => i.id === 'uuid-x')!.state).toBe('closed');
    expect(store.issues).toHaveLength(2);
  });

  it('AC4: a below-threshold cluster files nothing', async () => {
    const mutations = await runTick(100, 2);
    expect(mutations).toHaveLength(0);
    expect(store.issues).toHaveLength(0);
  });

  it('records a filing failure on the mutation instead of throwing', async () => {
    const proposals = await new AgentFailureRuleSet().evaluate(windowEvents(10, 5), WINDOW);
    const tool = new ClusterIntakeTool({ fileIssue: async () => { throw new Error('linear down'); } });
    const m = await tool.apply(proposals[0]);
    expect(m.error).toMatch(/intake failed: linear down/);
    expect(m.artifact).toMatchObject({ fixSpec: expect.any(Object) });
  });
});
