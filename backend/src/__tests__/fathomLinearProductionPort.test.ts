/**
 * Contract tests for the production Fathom LinearPort adapter (ENG-536).
 *
 * The adapter owns only the Linear GraphQL boundary. Canonical reconciliation and
 * idempotency decisions stay in fathomLinearRouter.ts. The injected GraphQL fake
 * keeps every test PURE/MOCKABLE and prevents live Linear access.
 */

import path from 'path';
import {
  ALL_TEAMS,
  fathomKeyMarker,
  LinearPort,
  routeMeetingToLinear,
} from '../services/fathomLinearRouter';

type Graphql = (query: string, variables?: Record<string, unknown>) => Promise<any>;
type PortFactory = (dependencies: { graphql: Graphql }) => LinearPort;

/**
 * Resolve at test runtime so the red phase reports one failed behavior per test,
 * instead of stopping TypeScript compilation at the first missing module.
 */
function loadPortFactory(): PortFactory {
  const modulePath = path.join(__dirname, '..', 'services', 'fathomLinearProductionPort');
  const adapter = require(modulePath) as { createFathomLinearPort?: PortFactory };
  expect(typeof adapter.createFathomLinearPort).toBe('function');
  return adapter.createFathomLinearPort as PortFactory;
}

const issueNode = (overrides: Record<string, unknown> = {}) => ({
  id: 'issue-eng-42',
  identifier: 'ENG-42',
  title: 'Acme SSO support',
  description: 'Canonical Acme authentication work',
  url: 'https://linear.app/emmabyaw/issue/ENG-42',
  team: { key: 'ENG' },
  assignee: { name: 'Harsha' },
  ...overrides,
});

describe('fathomLinearProductionPort', () => {
  it('searches active and recently closed issues across ENG/GROW/CS/OPS', async () => {
    const graphql = jest.fn<ReturnType<Graphql>, Parameters<Graphql>>().mockResolvedValue({
      issues: {
        nodes: [
          issueNode(),
          issueNode({
            id: 'issue-cs-9',
            identifier: 'CS-9',
            title: 'Acme rollout follow-up',
            team: { key: 'CS' },
          }),
        ],
      },
    });
    const port = loadPortFactory()({ graphql });

    const results = await port.searchIssues({
      teams: ALL_TEAMS,
      query: 'Acme SSO rollout',
      limit: 30,
    });

    expect(results.map(issue => issue.identifier)).toEqual(['ENG-42', 'CS-9']);
    expect(results.map(issue => issue.team)).toEqual(['ENG', 'CS']);
    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, variables] = graphql.mock.calls[0];
    expect(query).toMatch(/issues/i);
    expect(query).toMatch(/completedAt|state/i);
    expect(variables).toMatchObject({ teamKeys: ALL_TEAMS, limit: 30 });
    expect(variables?.recentlyClosedSince).toEqual(expect.any(String));
  });

  it('finds an existing issue by the exact embedded Fathom key across every team', async () => {
    const key = 'fathom:rec-123:item-7';
    const graphql = jest.fn<ReturnType<Graphql>, Parameters<Graphql>>().mockResolvedValue({
      issues: {
        nodes: [issueNode({ description: `Meeting output\n\n${fathomKeyMarker(key)}` })],
      },
    });
    const port = loadPortFactory()({ graphql });

    const result = await port.findByFathomKey(key);

    expect(result?.identifier).toBe('ENG-42');
    const [, variables] = graphql.mock.calls[0];
    expect(variables).toMatchObject({ teamKeys: ALL_TEAMS, marker: fathomKeyMarker(key) });
  });

  it('finds an enrichment marker embedded in a canonical issue comment', async () => {
    const key = 'fathom:rec-123:item-8';
    const graphql = jest.fn<ReturnType<Graphql>, Parameters<Graphql>>().mockResolvedValue({
      issues: { nodes: [] },
      comments: {
        nodes: [{
          body: `Meeting update\n\n${fathomKeyMarker(key)}`,
          issue: issueNode({
            id: 'issue-grow-8',
            identifier: 'GROW-8',
            team: { key: 'GROW' },
          }),
        }],
      },
    });
    const port = loadPortFactory()({ graphql });

    const result = await port.findByFathomKey(key);

    expect(result).toMatchObject({ id: 'issue-grow-8', identifier: 'GROW-8', team: 'GROW' });
  });

  it('creates on the selected team, comments, and relates through the mocked GraphQL boundary', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const graphql: Graphql = async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes('FathomLinearTeam')) {
        return { teams: { nodes: [{ id: 'team-grow', key: 'GROW' }] } };
      }
      if (query.includes('FathomLinearIssueCreate')) {
        return {
          issueCreate: {
            success: true,
            issue: issueNode({
              id: 'issue-grow-77',
              identifier: 'GROW-77',
              title: 'Acme onboarding follow-up',
              team: { key: 'GROW' },
            }),
          },
        };
      }
      if (query.includes('FathomLinearCommentCreate')) return { commentCreate: { success: true } };
      if (query.includes('FathomLinearRelationCreate')) return { issueRelationCreate: { success: true } };
      throw new Error(`Unexpected GraphQL operation: ${query}`);
    };
    const port = loadPortFactory()({ graphql });

    const created = await port.createIssue({
      team: 'GROW',
      title: 'Acme onboarding follow-up',
      description: 'Grounded in the Fathom call',
    });
    await port.addComment({ issueId: created.id, body: 'Meeting update' });
    await port.relateIssues({ issueId: created.id, relatedIssueId: 'issue-eng-42' });

    expect(created).toMatchObject({ identifier: 'GROW-77', team: 'GROW' });
    expect(calls.some(call => call.query.includes('FathomLinearIssueCreate'))).toBe(true);
    expect(calls.some(call => call.query.includes('FathomLinearCommentCreate'))).toBe(true);
    expect(calls.some(call => call.query.includes('FathomLinearRelationCreate'))).toBe(true);
    expect(calls.find(call => call.query.includes('FathomLinearIssueCreate'))?.variables)
      .toMatchObject({ input: { teamId: 'team-grow' } });
  });

  it('lets the existing router make a webhook retry a no-op instead of a duplicate create', async () => {
    let persisted: ReturnType<typeof issueNode> | null = null;
    let createCount = 0;
    const graphql: Graphql = async (query, variables) => {
      if (query.includes('FathomLinearFindByKey')) {
        return { issues: { nodes: persisted ? [persisted] : [] } };
      }
      if (query.includes('FathomLinearSearch')) return { issues: { nodes: [] } };
      if (query.includes('FathomLinearTeam')) {
        return { teams: { nodes: [{ id: 'team-eng', key: 'ENG' }] } };
      }
      if (query.includes('FathomLinearIssueCreate')) {
        createCount += 1;
        const input = (variables?.input || {}) as { title?: string; description?: string };
        persisted = issueNode({ title: input.title, description: input.description });
        return { issueCreate: { success: true, issue: persisted } };
      }
      throw new Error(`Unexpected GraphQL operation: ${query}`);
    };
    const port = loadPortFactory()({ graphql });
    const meeting = {
      recordingId: 'rec-123',
      title: 'Acme weekly sync',
      url: 'https://fathom.video/calls/rec-123',
      date: '2026-08-02T18:00:00Z',
      participants: ['owner@acme.test'],
    };
    const items = [{
      id: 'item-7',
      action: 'Add Acme SSO support',
      team: 'ENG' as const,
      actionable: true,
    }];

    const first = await routeMeetingToLinear(meeting, items, port);
    const retry = await routeMeetingToLinear(meeting, items, port);

    expect(createCount).toBe(1);
    expect(first.created).toHaveLength(1);
    expect(retry.duplicatesAvoided).toHaveLength(1);
  });

  it('keeps the inherited router marker contract stable (passing control)', () => {
    expect(fathomKeyMarker('fathom:rec-123:item-7'))
      .toBe('[[fathom-key:fathom:rec-123:item-7]]');
  });
});
