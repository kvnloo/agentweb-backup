/**
 * ENG-442 — `list_crm_sequences` + `manage_crm_sequence` agent tools.
 *
 * Emma could already scope a CRM audience (`get_leads_by_crm_criteria`) but had
 * no tool to list, build, inspect or pause the drip sequences that actually
 * mail those leads. These tests pin the behavioural contract, and in particular
 * the send-safety gate: activation can never happen from an unattended run.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getUnassociatedToolNames: jest.fn().mockReturnValue([]) },
}));

const mockGetChatSession = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: (...args: any[]) => mockGetChatSession(...args) },
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

const USER_ID = 'tenant-1';
/** An Emma chat session a human is actually watching. */
const interactiveCtx = { userId: USER_ID, agentUserId: USER_ID, sessionId: 'sess-interactive' };
/** A cron-driven scheduled Emma run — nobody is there to approve anything. */
const scheduledCtx = { userId: USER_ID, agentUserId: USER_ID, sessionId: 'sess-scheduled' };
/** No resolvable chat session (e.g. external MCP transport id). */
const unknownCtx = { userId: USER_ID, agentUserId: USER_ID };

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

const SEQ_ACTIVE = {
  sequenceId: 'seq-active',
  name: 'Trial nurture',
  status: 'active',
  campaignType: 'nurture',
  enrollmentTrigger: { type: 'list_membership', listId: 'list-1' },
  steps: [{ stepId: 'a' }, { stepId: 'b' }],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};
const SEQ_DRAFT = {
  sequenceId: 'seq-draft',
  name: 'Winback',
  status: 'draft',
  campaignType: 'reengagement',
  enrollmentTrigger: { type: 'manual' },
  steps: [{ stepId: 'a' }],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  // mockReset (not mockClear) so an unconsumed mockResolvedValueOnce from a
  // previous test cannot leak into the next one.
  mockMcpFetch.mockReset();
  mockGetChatSession.mockReset();
  mockGetChatSession.mockImplementation(async (sessionId: string) => {
    if (sessionId === 'sess-interactive') return { sessionId, sessionType: 'regular' };
    if (sessionId === 'sess-scheduled') return { sessionId, sessionType: 'scheduled' };
    return null;
  });
});

// ─── AC1: list ──────────────────────────────────────────────────────────────

describe('list_crm_sequences (AC1)', () => {
  it('is registered in mcpToolRegistry', () => {
    const handler = mcpToolRegistry.getTool('list_crm_sequences');
    expect(handler).toBeDefined();
    expect(handler?.definition.name).toBe('list_crm_sequences');
    expect(handler?.definition.inputSchema.required).toEqual([]);
  });

  it('returns name, status, target segment and step count for each sequence', async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [SEQ_ACTIVE, SEQ_DRAFT] });

    const parsed = parse(await mcpToolRegistry.execute('list_crm_sequences', {}, interactiveCtx));

    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/api/crm/sequences' }),
    );
    expect(parsed.total).toBe(2);
    expect(parsed.sequences[0]).toMatchObject({
      sequence_id: 'seq-active',
      name: 'Trial nurture',
      status: 'active',
      step_count: 2,
      is_sending: true,
    });
    expect(parsed.sequences[0].target).toContain('list-1');
    expect(parsed.sequences[1]).toMatchObject({ status: 'draft', is_sending: false });
  });

  it('returns a clean empty result for an account with zero sequences', async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [] });

    const parsed = parse(await mcpToolRegistry.execute('list_crm_sequences', {}, interactiveCtx));

    expect(parsed.total).toBe(0);
    expect(parsed.sequences).toEqual([]);
    expect(parsed.error).toBeUndefined();
    expect(typeof parsed.summary).toBe('string');
  });

  it('filters by status when asked', async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [SEQ_ACTIVE, SEQ_DRAFT] });

    const parsed = parse(
      await mcpToolRegistry.execute('list_crm_sequences', { status: 'active' }, interactiveCtx),
    );

    expect(parsed.total).toBe(1);
    expect(parsed.sequences[0].sequence_id).toBe('seq-active');
  });

  it('is read-only — safe to call from an unattended run', async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [] });
    const parsed = parse(await mcpToolRegistry.execute('list_crm_sequences', {}, scheduledCtx));
    expect(parsed.total).toBe(0);
  });
});

// ─── AC2: create ────────────────────────────────────────────────────────────

describe('manage_crm_sequence create (AC2)', () => {
  it('is registered with the four supported actions', () => {
    const handler = mcpToolRegistry.getTool('manage_crm_sequence');
    expect(handler).toBeDefined();
    expect(handler?.definition.inputSchema.properties.action.enum.sort()).toEqual(
      ['create', 'get', 'pause', 'resume'].sort(),
    );
    expect(handler?.definition.inputSchema.required).toEqual(['action']);
  });

  it('creates a multi-step sequence targeting a list + lifecycle with copy and cadence', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: { ...SEQ_DRAFT, sequenceId: 'seq-new' } });

    await mcpToolRegistry.execute(
      'manage_crm_sequence',
      {
        action: 'create',
        name: 'Trial nurture',
        description: 'Warm up trialing leads',
        campaign_type: 'nurture',
        target: { lead_list_id: 'list-1', lifecycle: 'trialing' },
        steps: [
          { subject: 'Welcome', body_html: '<p>Hi {{firstName}}</p>' },
          { name: 'Nudge', subject: 'Still there?', body_html: '<p>Ping</p>', delay_days: 4 },
        ],
      },
      interactiveCtx,
    );

    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/crm/sequences',
        body: expect.objectContaining({
          name: 'Trial nurture',
          description: 'Warm up trialing leads',
          campaignType: 'nurture',
          enrollmentTrigger: { type: 'list_membership', listId: 'list-1' },
          enrollmentCondition: { field: 'lifecycle', operator: 'eq', value: 'trialing' },
          steps: [
            { stepNumber: 1, name: 'Step 1', delayDays: 0, channel: 'email', subject: 'Welcome', bodyHtml: '<p>Hi {{firstName}}</p>' },
            { stepNumber: 2, name: 'Nudge', delayDays: 4, channel: 'email', subject: 'Still there?', bodyHtml: '<p>Ping</p>' },
          ],
        }),
      }),
    );
  });

  it('supports heat-score targeting', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: SEQ_DRAFT });

    await mcpToolRegistry.execute(
      'manage_crm_sequence',
      {
        action: 'create',
        name: 'Hot leads',
        target: { lead_list_id: 'list-1', min_heat_score: 70 },
        steps: [{ subject: 'a', body_html: 'b' }],
      },
      interactiveCtx,
    );

    expect((mockMcpFetch.mock.calls[0][0] as any).body.enrollmentCondition).toEqual({
      field: 'heatScore',
      operator: 'gte',
      value: 70,
    });
  });

  it('returns a validation error (no API call) when steps are missing', async () => {
    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'create', name: 'Broken' },
        interactiveCtx,
      ),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/step/i);
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('returns a validation error (no API call) when name is missing', async () => {
    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'create', steps: [{ subject: 'a', body_html: 'b' }] },
        interactiveCtx,
      ),
    );
    expect(parsed.success).toBe(false);
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });
});

// ─── AC3: show / pause ──────────────────────────────────────────────────────

describe('manage_crm_sequence get + pause (AC3)', () => {
  it('shows a sequence status summary', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: SEQ_ACTIVE });

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'get', sequence_id: 'seq-active' },
        interactiveCtx,
      ),
    );

    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/api/crm/sequences/seq-active' }),
    );
    expect(parsed.sequence).toMatchObject({ status: 'active', step_count: 2, is_sending: true });
  });

  it('pauses a sequence via a status update', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: { ...SEQ_ACTIVE, status: 'paused' } });

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'pause', sequence_id: 'seq-active' },
        interactiveCtx,
      ),
    );

    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PUT',
        path: '/api/crm/sequences/seq-active',
        body: { status: 'paused' },
      }),
    );
    expect(parsed.sequence.status).toBe('paused');
  });

  it('allows pause from an unattended run — stopping sends is always safe', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: { ...SEQ_ACTIVE, status: 'paused' } });

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'pause', sequence_id: 'seq-active' },
        scheduledCtx,
      ),
    );

    expect(parsed.sequence.status).toBe('paused');
    expect(mockMcpFetch).toHaveBeenCalledTimes(1);
  });

  it('requires sequence_id for get and pause', async () => {
    for (const action of ['get', 'pause', 'resume']) {
      const parsed = parse(await mcpToolRegistry.execute('manage_crm_sequence', { action }, interactiveCtx));
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/sequence_id/i);
    }
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });
});

// ─── AC4: human approval gate before any send ───────────────────────────────

describe('send-safety gate (AC4)', () => {
  it('NEVER activates a sequence from a scheduled/unattended run, even with confirm=true', async () => {
    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'resume', sequence_id: 'seq-draft', confirm: true },
        scheduledCtx,
      ),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.approval).toMatchObject({ approved: false, reason: 'unattended_run' });
    // The load-bearing assertion: no write of any kind reached the API.
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('NEVER activates a sequence when the run context cannot be proven attended', async () => {
    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'resume', sequence_id: 'seq-draft', confirm: true },
        unknownCtx,
      ),
    );

    expect(parsed.approval).toMatchObject({ approved: false, reason: 'unattended_run' });
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('fails closed to blocked when the session lookup errors', async () => {
    mockGetChatSession.mockRejectedValue(new Error('dynamo down'));

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'resume', sequence_id: 'seq-draft', confirm: true },
        interactiveCtx,
      ),
    );

    expect(parsed.approval).toMatchObject({ approved: false, reason: 'unattended_run' });
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('in an interactive run, previews instead of activating when confirm is absent', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: SEQ_DRAFT });

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'resume', sequence_id: 'seq-draft' },
        interactiveCtx,
      ),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.approval).toMatchObject({ approved: false, reason: 'confirmation_required' });
    expect(parsed.preview).toMatchObject({ name: 'Winback', step_count: 1 });
    // Only the read-back happened — no status write.
    expect(mockMcpFetch).toHaveBeenCalledTimes(1);
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
  });

  it('activates only after explicit human confirmation in an attended run', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: { ...SEQ_DRAFT, status: 'active' } });

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'resume', sequence_id: 'seq-draft', confirm: true },
        interactiveCtx,
      ),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.approval).toEqual({ approved: true });
    // Approved path writes directly — no redundant read-back.
    expect(mockMcpFetch).toHaveBeenCalledTimes(1);
    expect(mockMcpFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'PUT',
        path: '/api/crm/sequences/seq-draft',
        body: { status: 'active' },
      }),
    );
    expect(parsed.sequence.status).toBe('active');
  });

  it('creates sequences as draft — a created sequence can never send on its own', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: SEQ_DRAFT });

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        {
          action: 'create',
          name: 'Winback',
          // A model trying to bypass the gate by asking for an active sequence.
          status: 'active',
          target: { lead_list_id: 'list-1' },
          steps: [{ subject: 'a', body_html: 'b' }],
        },
        interactiveCtx,
      ),
    );

    const body = (mockMcpFetch.mock.calls[0][0] as any).body;
    expect(body.status).toBe('draft');
    expect(parsed.sequence.status).toBe('draft');
    expect(parsed.next_step).toMatch(/approv/i);
  });

  it('allows drafting a sequence from an unattended run (draft cannot send)', async () => {
    mockMcpFetch.mockResolvedValue({ sequence: SEQ_DRAFT });

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        {
          action: 'create',
          name: 'Winback',
          target: { lead_list_id: 'list-1' },
          steps: [{ subject: 'a', body_html: 'b' }],
        },
        scheduledCtx,
      ),
    );

    expect((mockMcpFetch.mock.calls[0][0] as any).body.status).toBe('draft');
    expect(parsed.sequence.status).toBe('draft');
  });

  it('surfaces API failures instead of silently reporting success', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (500): boom'));

    const parsed = parse(
      await mcpToolRegistry.execute(
        'manage_crm_sequence',
        { action: 'pause', sequence_id: 'seq-active' },
        interactiveCtx,
      ),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/boom/);
  });
});
