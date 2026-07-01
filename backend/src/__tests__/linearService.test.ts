import { addIssueComment, createInternalLinearIssue, listOpenIssuesByLabel, _resetLinearTeamCache } from '../services/linearService';

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
            { id: 'st_done', name: 'Done', type: 'completed' },
          ],
        },
        labels: {
          nodes: [
            { id: 'lab_bug', name: 'Bug' },
            { id: 'lab_crep', name: 'Customer Reported' },
          ],
        },
      }],
    },
  },
};

function lastCreateInput(): any {
  const call = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueCreate'));
  return JSON.parse(call[1].body).variables.input;
}

describe('linearService.createInternalLinearIssue', () => {
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  it('creates an issue with the given labels and NO Featurebase label (stays private)', async () => {
    const TEAM_WITH_AUTO = { data: { teams: { nodes: [{ id: 'team_eng', states: TEAM_RESPONSE.data.teams.nodes[0].states, labels: { nodes: [...TEAM_RESPONSE.data.teams.nodes[0].labels.nodes, { id: 'lab_fb', name: 'Featurebase' }, { id: 'lab_auto', name: 'Auto' }] } }] } } };
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? TEAM_WITH_AUTO : { data: { issueCreate: { success: true, issue: { id: 'uuid-50', identifier: 'ENG-50', url: 'u' } } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    const r = await createInternalLinearIssue({ title: 'auto thing', description: 'd', labelNames: ['Auto', 'Bug'] });
    expect(r.identifier).toBe('ENG-50');
    expect(r.id).toBe('uuid-50'); // uuid returned for commenting
    const input = lastCreateInput();
    expect(input.labelIds.sort()).toEqual(['lab_auto', 'lab_bug'].sort());
    expect(input.labelIds).not.toContain('lab_fb'); // no Featurebase label -> never public
  });
});

describe('linearService.createInternalLinearIssue — target state (Triage-first)', () => {
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  const teamWith = (states: any[]) => ({
    data: { teams: { nodes: [{ id: 'team_eng', states: { nodes: states }, labels: { nodes: [{ id: 'lab_auto', name: 'Auto' }] } }] } },
  });

  const mockFetchSeq = (teamBody: any) => {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? teamBody : { data: { issueCreate: { success: true, issue: { id: 'uuid-1', identifier: 'ENG-1', url: 'u' } } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
  };

  it('sets stateId to the Triage state when the team has one (auto + reported issues land in Triage)', async () => {
    mockFetchSeq(teamWith([
      { id: 'st_triage', name: 'Triage', type: 'triage' },
      { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
      { id: 'st_done', name: 'Done', type: 'completed' },
    ]));
    await createInternalLinearIssue({ title: 't', description: 'd', labelNames: ['Auto'] });
    expect(lastCreateInput().stateId).toBe('st_triage');
  });

  it('prefers Triage regardless of state ordering (Triage listed after backlog)', async () => {
    mockFetchSeq(teamWith([
      { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
      { id: 'st_triage', name: 'Triage', type: 'triage' },
    ]));
    await createInternalLinearIssue({ title: 't', description: 'd', labelNames: ['Auto'] });
    expect(lastCreateInput().stateId).toBe('st_triage');
  });

  it('does NOT use the backlog state when a Triage state exists', async () => {
    mockFetchSeq(teamWith([
      { id: 'st_triage', name: 'Triage', type: 'triage' },
      { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
    ]));
    await createInternalLinearIssue({ title: 't', description: 'd', labelNames: ['Auto'] });
    expect(lastCreateInput().stateId).not.toBe('st_backlog');
  });

  it('falls back to the backlog state when the team has no Triage (behavior-preserving for old teams)', async () => {
    mockFetchSeq(teamWith([
      { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
      { id: 'st_done', name: 'Done', type: 'completed' },
    ]));
    await createInternalLinearIssue({ title: 't', description: 'd', labelNames: ['Auto'] });
    expect(lastCreateInput().stateId).toBe('st_backlog');
  });

  it('omits stateId entirely when the team has neither Triage nor a backlog/unstarted state', async () => {
    mockFetchSeq(teamWith([
      { id: 'st_started', name: 'In Progress', type: 'started' },
    ]));
    await createInternalLinearIssue({ title: 't', description: 'd', labelNames: ['Auto'] });
    expect(lastCreateInput().stateId).toBeUndefined();
  });
});

describe('linearService.listOpenIssuesByLabel', () => {
  afterEach(() => jest.clearAllMocks());

  it('queries open issues by a single label and maps id/identifier/title', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      data: { issues: { nodes: [{ id: 'u1', identifier: 'ENG-1', title: 'Context limit reached' }] } },
    }) } as any));
    const res = await listOpenIssuesByLabel('Auto');
    expect(res).toEqual([{ identifier: 'ENG-1', issueId: 'u1', title: 'Context limit reached' }]);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).variables.label).toBe('Auto');
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
