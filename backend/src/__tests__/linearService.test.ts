import { addIssueComment, createInternalLinearIssue, listOpenIssuesByLabel, raiseIssueTriage, _resetLinearTeamCache } from '../services/linearService';

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

describe('linearService.createInternalLinearIssue — triage fields + loud label resolution (ENG-187)', () => {
  const TEAM_TRIAGE = {
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
              { id: 'lab_bug', name: 'Bug' },
              { id: 'lab_crep', name: 'Customer Reported' },
              { id: 'lab_ret', name: 'Retention' },
              { id: 'lab_st_paid', name: 'Status: Paid / Retention Handoff' },
            ],
          },
        }],
      },
    },
  };
  const CREATE_OK = { data: { issueCreate: { success: true, issue: { id: 'uuid-60', identifier: 'ENG-60', url: 'u' } } } };

  function mockFetchSequence(...bodies: any[]) {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      const body = bodies[Math.min(n, bodies.length - 1)];
      n += 1;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
  }

  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

  it('sets priority, named state (Todo), and assignee on the created issue', async () => {
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({
      title: 'bug', description: 'd',
      labelNames: ['Bug', 'Customer Reported', 'Status: Paid / Retention Handoff', 'Retention'],
      priority: 1, stateName: 'Todo', assigneeId: 'user-harshit',
    });
    const input = lastCreateInput();
    expect(input.priority).toBe(1);
    expect(input.stateId).toBe('st_todo');
    expect(input.assigneeId).toBe('user-harshit');
    expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_crep', 'lab_ret', 'lab_st_paid'].sort());
  });

  it('keeps the backlog state when no stateName is given (existing callers unchanged)', async () => {
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({ title: 'auto', description: 'd', labelNames: ['Bug'] });
    const input = lastCreateInput();
    expect(input.stateId).toBe('st_backlog');
    expect(input.priority).toBeUndefined();
    expect(input.assigneeId).toBeUndefined();
  });

  // ENG-187 contract #7 — label resolution is LOUD, never a silent drop
  it('logs an error NAMING each label that fails to resolve (no silent drops)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({ title: 'bug', description: 'd', labelNames: ['Bug', 'Status: Nonexistent Stage'] });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Status: Nonexistent Stage'));
    expect(lastCreateInput().labelIds).toEqual(['lab_bug']); // still creates with what resolved
  });

  it('logs an error when the requested state name is unknown and falls back to backlog', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({ title: 'bug', description: 'd', labelNames: ['Bug'], stateName: 'NoSuchState' });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('NoSuchState'));
    expect(lastCreateInput().stateId).toBe('st_backlog');
  });

  describe('raiseIssueTriage — union labels, raise-only priority (ENG-187 contract #6)', () => {
    const issueResponse = (priority: number, labelIds: string[]) => ({
      data: { issue: { priority, labels: { nodes: labelIds.map((id) => ({ id })) } } },
    });
    const UPDATE_OK = { data: { issueUpdate: { success: true } } };

    const lastUpdateInput = () => {
      const call = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueUpdate'));
      return call ? JSON.parse(call[1].body).variables.input : null;
    };

    it('unions new stage labels into the existing set and raises Medium(3) -> Urgent(1)', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(3, ['lab_bug', 'lab_crep']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: ['Status: Paid / Retention Handoff', 'Retention'], priority: 1 });
      const input = lastUpdateInput();
      expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_crep', 'lab_ret', 'lab_st_paid'].sort());
      expect(input.priority).toBe(1);
    });

    it('NEVER lowers priority: Urgent(1) canonical + Medium(3) reporter -> priority untouched', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(1, ['lab_bug', 'lab_crep', 'lab_ret', 'lab_st_paid']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: ['Retention'], priority: 3 });
      // Labels already present + priority would be a downgrade -> nothing to do, no mutation sent.
      const updateCall = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueUpdate'));
      expect(updateCall).toBeUndefined();
    });

    it('treats priority 0 (None) as the floor: any real priority raises it', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(0, ['lab_bug']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: [], priority: 3 });
      expect(lastUpdateInput().priority).toBe(3);
    });

    it('unions labels even when priority stays (labels-only update omits priority)', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(1, ['lab_bug']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: ['Retention'], priority: 2 });
      const input = lastUpdateInput();
      expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_ret'].sort());
      expect(input.priority).toBeUndefined();
    });
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
