/**
 * ENG-3088: a failure cluster that is still over threshold only because old failures have not
 * left the 7-day window must not post "Recurred" again. Only a failure newer than the last
 * filing/recurrence post on the canonical is a recurrence. REAL rule set + REAL fileAutoIssue
 * against an in-memory Linear fake that, unlike the ENG-589 suite's, carries timestamps.
 */

type FakeIssue = { id: string; identifier: string; title: string; description: string; state: 'open' | 'closed'; labels: string[]; createdAt: string };
const store: { issues: FakeIssue[]; comments: { issueId: string; body: string; createdAt: string }[]; n: number; now: string } = {
  issues: [], comments: [], n: 2000, now: '',
};
const ref = (i: FakeIssue) => ({ identifier: i.identifier, issueId: i.id, title: i.title, description: i.description, createdAt: i.createdAt });

jest.mock('../services/linearService', () => ({
  listOpenIssuesByLabel: jest.fn(async (label: string) =>
    store.issues.filter((i) => i.state === 'open' && i.labels.includes(label)).map(ref)),
  findMostRecentClosedIssueByLabel: jest.fn(async (label: string, isMatch: (i: any) => boolean) =>
    store.issues.filter((i) => i.state === 'closed' && i.labels.includes(label)).map(ref).reverse().find(isMatch) ?? null),
  findMostRecentArchivedIssueByLabel: jest.fn(async () => null),
  createInternalLinearIssue: jest.fn(async (p: any) => {
    const n = ++store.n;
    const issue: FakeIssue = { id: `uuid-${n}`, identifier: `ENG-${n}`, title: p.title, description: p.description, state: 'open', labels: p.labelNames, createdAt: store.now };
    store.issues.push(issue);
    return { id: issue.id, identifier: issue.identifier, url: `https://linear.app/x/${issue.identifier}` };
  }),
  addIssueComment: jest.fn(async (issueId: string, body: string) => { store.comments.push({ issueId, body, createdAt: store.now }); }),
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

const WINDOW = { start: new Date('2026-11-05T00:00:00Z'), end: new Date('2026-11-20T00:00:00Z') };
let seq = 0;
function evt(eventType: string, ts: string, extra: Record<string, string> = {}): NormalizedEvent {
  seq++;
  return {
    subjectId: asSubjectId(`run-${seq}`),
    eventType,
    ts: new Date(ts),
    dimensions: { toolName: 'get_ads_thresholds', sessionId: `sess-${seq}`, ...extra },
  };
}
/** One invocation + one failure per timestamp, plus `okCalls` successful invocations. */
function events(failureTimes: string[], okCalls = 6): NormalizedEvent[] {
  return [
    ...failureTimes.flatMap((ts) => [
      evt(EVT_TOOL_INVOKED, ts),
      evt(EVT_TOOL_FAILED, ts, { errorClass: 'Error', failureType: 'bug' }),
    ]),
    ...Array.from({ length: okCalls }, () => evt(EVT_TOOL_INVOKED, '2026-11-09T12:00:00Z')),
  ];
}
async function runTick(now: string, failureTimes: string[], ports: ConstructorParameters<typeof ClusterIntakeTool>[0] = {}) {
  store.now = now;
  const proposals = await new AgentFailureRuleSet().evaluate(events(failureTimes), WINDOW);
  const tool = new ClusterIntakeTool({ isProduction: () => true, ...ports });
  return Promise.all(proposals.map((p) => tool.apply(p)));
}

// The real ENG-2938 shape: three failures on 11-11 morning, daily 17:30 UTC analysis.
const OLD = ['2026-11-11T10:04:16Z', '2026-11-11T10:08:38Z', '2026-11-11T10:33:00Z'];

beforeEach(() => {
  store.issues = [];
  store.comments = [];
});

describe('ENG-3088 recurrence posts only for new failures', () => {
  it('AC2: the same failures on day 2 as on day 1 post no "Recurred" comment', async () => {
    await runTick('2026-11-11T17:30:00Z', OLD);
    expect(store.issues).toHaveLength(1);
    const day2 = await runTick('2026-11-12T17:30:00Z', OLD);
    const day3 = await runTick('2026-11-13T17:30:00Z', OLD);
    expect(store.issues).toHaveLength(1);
    expect(store.comments).toHaveLength(0);
    for (const m of [day2[0], day3[0]]) {
      expect(m.error).toBeUndefined();
      expect(m.artifact).toMatchObject({
        fixSpec: expect.any(Object),
        intake: { deduped: true, noNewFailures: true, pageId: store.issues[0].identifier },
      });
    }
  });

  it('AC3: a failure newer than the filing still posts, and says how many are new', async () => {
    await runTick('2026-11-11T17:30:00Z', OLD);
    const day2 = await runTick('2026-11-12T17:30:00Z', [...OLD, '2026-11-12T09:00:00Z', '2026-11-12T09:05:00Z']);
    expect(store.issues).toHaveLength(1);
    expect(store.comments).toHaveLength(1);
    expect(store.comments[0].body).toMatch(/^Recurred on /);
    expect(store.comments[0].body).toContain('New Since Last Comment: 2 of 5 failures');
    // The class line stays last, so the ENG-240 class matcher is unaffected.
    expect(store.comments[0].body).toMatch(/Alert Class: agent-mode:get_ads_thresholds:bug\s*$/);
    expect(day2[0].artifact).toMatchObject({ intake: { deduped: true } });
    expect((day2[0].artifact as any).intake.noNewFailures).toBeUndefined();
  });

  it('AC3: "new" is counted from the newest Recurred comment, not from the filing', async () => {
    await runTick('2026-11-11T17:30:00Z', OLD);
    await runTick('2026-11-12T17:30:00Z', [...OLD, '2026-11-12T09:00:00Z']);
    expect(store.comments).toHaveLength(1);
    // Day 3: nothing after the day-2 comment -> silent, although one failure postdates the filing.
    await runTick('2026-11-13T17:30:00Z', [...OLD, '2026-11-12T09:00:00Z']);
    expect(store.comments).toHaveLength(1);
    // Day 4: one more.
    await runTick('2026-11-14T17:30:00Z', [...OLD, '2026-11-12T09:00:00Z', '2026-11-14T08:00:00Z']);
    expect(store.comments).toHaveLength(2);
    expect(store.comments[1].body).toContain('New Since Last Comment: 1 of 5 failures');
  });

  it('AC4: the first filing of a new cluster is unchanged (no "new since" line)', async () => {
    const first = await runTick('2026-11-11T17:30:00Z', OLD);
    expect(store.issues).toHaveLength(1);
    expect(store.issues[0].description).not.toContain('New Since Last Comment');
    expect(store.issues[0].description).toMatch(/Alert Class: agent-mode:get_ads_thresholds:bug\s*$/m);
    expect(first[0].artifact).toMatchObject({ intake: { deduped: false } });
  });

  it('a closed canonical is not reopened by failures that all predate its filing', async () => {
    await runTick('2026-11-11T17:30:00Z', OLD);
    store.issues[0].state = 'closed';
    const next = await runTick('2026-11-12T17:30:00Z', OLD);
    expect(store.issues[0].state).toBe('closed');
    expect(store.comments).toHaveLength(0);
    expect(next[0].artifact).toMatchObject({ intake: { noNewFailures: true } });
  });

  it('a closed canonical IS reopened by a failure newer than its last post', async () => {
    await runTick('2026-11-11T17:30:00Z', OLD);
    store.issues[0].state = 'closed';
    await runTick('2026-11-13T17:30:00Z', [...OLD, '2026-11-13T02:00:00Z']);
    expect(store.issues).toHaveLength(1);
    expect(store.issues[0].state).toBe('open');
    expect(store.comments).toHaveLength(1);
    expect(store.comments[0].body).toMatch(/^Reopened /);
    expect(store.comments[0].body).toContain('New Since Last Comment: 1 of 4 failures');
  });

  it('fails open: if the comments cannot be read, it posts as before', async () => {
    await runTick('2026-11-11T17:30:00Z', OLD);
    await runTick('2026-11-12T17:30:00Z', OLD, { listComments: async () => { throw new Error('linear down'); } });
    expect(store.comments).toHaveLength(1);
    expect(store.comments[0].body).not.toContain('New Since Last Comment');
  });

  it('fails open: a canonical with no usable timestamp posts as before', async () => {
    await runTick('2026-11-11T17:30:00Z', OLD);
    store.issues[0].createdAt = '';
    await runTick('2026-11-12T17:30:00Z', OLD);
    expect(store.comments).toHaveLength(1);
  });

  it('AC5: failure times are never serialised into the stored proposal or fix spec', async () => {
    const [proposal] = await new AgentFailureRuleSet().evaluate(events(OLD), WINDOW);
    expect((proposal.payload as any).failureTimes).toEqual(OLD.map((t) => new Date(t).toISOString()));
    expect(JSON.stringify(proposal)).not.toContain('failureTimes');
    const [m] = await runTick('2026-11-11T17:30:00Z', OLD);
    expect(JSON.stringify(m)).not.toContain('failureTimes');
  });
});
