import { createLinearIssue, listOpenCanonicals, addIssueComment, _resetLinearTeamCache } from '../services/linearService';

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'lin_api_test' })),
}));

const TEAM_RESPONSE = {
  data: {
    teams: {
      nodes: [{
        id: 'team_eng',
        states: {
          nodes: [
            { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
            { id: 'st_todo', name: 'Todo', type: 'unstarted' },
            { id: 'st_done', name: 'Done', type: 'completed' },
          ],
        },
        labels: {
          nodes: [
            { id: 'lab_fb', name: 'Featurebase' },
            { id: 'lab_bug', name: 'Bug' },
            { id: 'lab_feat', name: 'Feature' },
            { id: 'lab_creq', name: 'Customer Request' },
            { id: 'lab_crep', name: 'Customer Reported' },
          ],
        },
      }],
    },
  },
};

function lastCreateInput(): any {
  const call = (global.fetch as jest.Mock).mock.calls.find(c => {
    const body = c[1]?.body || '';
    return body.includes('issueCreate');
  });
  return JSON.parse(call[1].body).variables.input;
}

/** Mock: first GraphQL call = team query, second = issueCreate. */
function mockLinear(createResult: any = { data: { issueCreate: { success: true, issue: { identifier: 'ENG-99', url: 'https://linear.app/x/issue/ENG-99' } } } }) {
  let n = 0;
  (global.fetch as any) = jest.fn(() => {
    n += 1;
    const body = n === 1 ? TEAM_RESPONSE : createResult;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
  });
}

describe('linearService.createLinearIssue', () => {
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  it('creates a feature_request issue with Featurebase + Feature + Customer Request labels, in Backlog', async () => {
    mockLinear();
    const r = await createLinearIssue({ type: 'feature_request', title: 'dark mode', description: 'please', userEmail: 'u@e.com' });
    expect(r).toEqual({ identifier: 'ENG-99', url: 'https://linear.app/x/issue/ENG-99' });
    const input = lastCreateInput();
    expect(input.teamId).toBe('team_eng');
    expect(input.stateId).toBe('st_backlog');
    expect(input.labelIds.sort()).toEqual(['lab_creq', 'lab_fb', 'lab_feat'].sort());
    expect(input.description).toContain('Filed by u@e.com via Emma');
  });

  it('creates a bug issue with Featurebase + Bug + Customer Reported labels', async () => {
    mockLinear();
    await createLinearIssue({ type: 'bug', title: 'crash', description: 'on save', userEmail: 'u@e.com' });
    const input = lastCreateInput();
    expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_crep', 'lab_fb'].sort());
  });

  it('always includes the Featurebase label (drives the FB import/sync)', async () => {
    mockLinear();
    await createLinearIssue({ type: 'feature_request', title: 't', description: 'd', userEmail: 'u@e.com' });
    expect(lastCreateInput().labelIds).toContain('lab_fb');
  });

  it('includes the source URL in the description when provided', async () => {
    mockLinear();
    await createLinearIssue({ type: 'bug', title: 't', description: 'd', userEmail: 'u@e.com', sourceUrl: 'https://fb/p/x' });
    expect(lastCreateInput().description).toContain('https://fb/p/x');
  });

  it('throws when issueCreate does not return an issue', async () => {
    mockLinear({ data: { issueCreate: { success: false, issue: null } } });
    await expect(
      createLinearIssue({ type: 'bug', title: 't', description: 'd', userEmail: 'u@e.com' }),
    ).rejects.toThrow(/did not return an issue/);
  });

  it('uses the raw API key in Authorization (no Bearer prefix)', async () => {
    mockLinear();
    await createLinearIssue({ type: 'bug', title: 't', description: 'd', userEmail: 'u@e.com' });
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('lin_api_test');
  });
});

describe('linearService.listOpenCanonicals', () => {
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  it('queries open issues by type + Featurebase label and maps the FB attachment url', async () => {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? TEAM_RESPONSE : {
        data: { issues: { nodes: [
          { id: 'uuid-1', identifier: 'ENG-1', title: 'Add dark mode', description: 'theme',
            attachments: { nodes: [{ title: 'Featurebase Submission', url: 'https://agentweb.featurebase.app/p/dark' }] } },
          { id: 'uuid-2', identifier: 'ENG-2', title: 'No FB link', description: 'x', attachments: { nodes: [] } },
        ] } },
      };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    const res = await listOpenCanonicals('feature_request', 30);
    expect(res).toEqual([
      { identifier: 'ENG-1', issueId: 'uuid-1', title: 'Add dark mode', description: 'theme', featurebasePostUrl: 'https://agentweb.featurebase.app/p/dark' },
      { identifier: 'ENG-2', issueId: 'uuid-2', title: 'No FB link', description: 'x', featurebasePostUrl: undefined },
    ]);
    // The issues query variables carry the Feature type label (type-scoped).
    const issuesCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(JSON.parse(issuesCall[1].body).variables.typeLabel).toBe('Feature');
  });

  it('passes the Bug type label when type is bug', async () => {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? TEAM_RESPONSE : { data: { issues: { nodes: [] } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    await listOpenCanonicals('bug');
    const issuesCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(JSON.parse(issuesCall[1].body).variables.typeLabel).toBe('Bug');
  });
});

describe('linearService.addIssueComment', () => {
  afterEach(() => jest.clearAllMocks());

  it('calls commentCreate with the issueId + body', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { commentCreate: { success: true } } }) } as any));
    await addIssueComment('uuid-1', 'Also reported by u@e.com');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.query).toContain('commentCreate');
    expect(body.variables.input).toEqual({ issueId: 'uuid-1', body: 'Also reported by u@e.com' });
  });

  it('throws when commentCreate fails', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { commentCreate: { success: false } } }) } as any));
    await expect(addIssueComment('uuid-1', 'x')).rejects.toThrow(/commentCreate failed/);
  });
});
