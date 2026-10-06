import {
  approvalDeckAllAnswered,
  approvalDeckIsAwaiting,
  filterSessions,
  renderAgentRunsScreen,
  renderApprovalDeck,
  renderEmmaDock,
  renderEmmaMain,
  renderSessionPicker,
  renderWorkPlanChecklist,
  TspNode,
} from '../tern/renderEmma';

function flatten(node: TspNode): TspNode[] {
  const out = [node];
  for (const child of node.c ?? []) out.push(...flatten(child));
  return out;
}

describe('Tern Emma renderer', () => {
  it('renders user/assistant transcript, persisted tools, and skips system rows', () => {
    const main = renderEmmaMain({
      sessionId: 's1',
      messages: [
        { role: 'system', content: 'hidden' },
        { role: 'user', content: 'Find leads' },
        {
          role: 'assistant',
          content: 'Done',
          metadata: {
            toolCalls: [{
              id: 't1',
              name: 'find_leads',
              result: { success: true },
              duration: 42,
            }],
          },
        },
      ],
    });

    const nodes = flatten(main);
    expect(nodes.find(node => node.id === 'msg.0')).toBeUndefined();
    expect(nodes.find(node => node.id === 'msg.1.body')?.p?.text).toBe('Find leads');
    expect(nodes.find(node => node.id === 'msg.2.body')?.p?.text).toBe('Done');
    expect(nodes.find(node => node.id === 'msg.2.tool.t1')).toMatchObject({
      k: 'tool',
      p: { name: 'find_leads', status: 'done', took: 42 },
    });
  });

  it('renders live tools as running native tool cards', () => {
    const main = renderEmmaMain(
      { sessionId: 's1', messages: [] },
      [{ id: '1', name: 'search_web', startedAt: 900 }],
      1000,
    );
    const tool = flatten(main).find(node => node.id === 'running.1');
    expect(tool).toMatchObject({
      k: 'tool',
      p: { name: 'search_web', status: 'running', age: 100 },
    });
  });

  it('filters session picker rows across title, prompt, model and type', () => {
    const sessions = [
      {
        sessionId: 's-old',
        title: 'Weekly report',
        llmModel: 'gemini-test',
        sessionType: 'scheduled',
        updatedAt: '2026-10-01T00:00:00Z',
        messages: [{ role: 'user', content: 'Summarize paid ads' }],
      },
      {
        sessionId: 's-new',
        title: 'Lead search',
        llmModel: 'gpt-test',
        sessionType: 'regular',
        updatedAt: '2026-10-05T00:00:00Z',
        messages: [{ role: 'user', content: 'Find dental leads' }],
      },
    ];

    expect(filterSessions(sessions, '').map(s => s.sessionId)).toEqual(['s-new', 's-old']);
    expect(filterSessions(sessions, 'dental').map(s => s.sessionId)).toEqual(['s-new']);
    expect(filterSessions(sessions, 'scheduled gemini').map(s => s.sessionId)).toEqual(['s-old']);
  });

  it('renders a native picker with current/scheduled badges and preview', () => {
    const layer = renderSessionPicker({
      sessions: [
        {
          sessionId: 's1',
          title: 'Current chat',
          llmModel: 'gpt-test',
          sessionType: 'regular',
          updatedAt: '2026-10-05T00:00:00Z',
          messages: [{ role: 'user', content: 'hello' }],
        },
        {
          sessionId: 's2',
          title: 'Scheduled report',
          llmModel: 'gemini-test',
          sessionType: 'scheduled',
          updatedAt: '2026-10-04T00:00:00Z',
          messages: [{ role: 'user', content: 'run report' }],
        },
      ],
      query: '',
      cursor: 0,
      selected: 1,
    }, 's1');

    const picker = flatten(layer).find(node => node.id === 'session-picker');
    expect(picker?.k).toBe('picker');
    const items = picker?.p?.items as any[];
    expect(items.find(item => item.id === 's1').badges).toContainEqual(expect.objectContaining({ text: 'current' }));
    expect(items.find(item => item.id === 's2').badges).toContainEqual(expect.objectContaining({ text: 'scheduled' }));
    expect(flatten(layer).find(node => node.id === 'session-preview.title')?.p?.text).toBe('Scheduled report');
  });


  it('renders a deck-of-one question with recommendation and delegation', () => {
    const deck = {
      deckId: 'deck-q1',
      status: 'awaiting' as const,
      createdAt: '2026-10-06T00:00:00Z',
      items: [{
        itemId: 'objective',
        kind: 'meta_objective',
        question: 'Which campaign objective should we use?',
        allowEmmaDecide: true,
        immutable: true,
        options: [
          {
            id: 'leads',
            label: 'Leads',
            consequence: 'Optimize for lead submissions.',
            recommended: true,
            why: 'Matches the stated conversion goal.',
          },
          {
            id: 'traffic',
            label: 'Traffic',
            consequence: 'Optimize for landing-page visits.',
          },
        ],
      }],
    };

    expect(approvalDeckIsAwaiting(deck)).toBe(true);
    const layer = renderApprovalDeck(deck, {
      itemIndex: 0,
      selectedVerdict: 'leads',
      answers: [],
      freeText: '',
      freeTextCursor: 0,
    });
    const picker = flatten(layer).find(node => node.id === 'approval-picker');
    expect(picker?.p).toMatchObject({
      title: 'Review 1 of 1',
      selected: 'leads',
      message: 'This choice may be irreversible.',
    });
    const items = picker?.p?.items as any[];
    expect(items.find(item => item.id === 'leads').badges)
      .toContainEqual(expect.objectContaining({ text: 'recommended' }));
    const actions = picker?.p?.actions as any[];
    expect(actions).toContainEqual(expect.objectContaining({ id: 'delegate' }));
  });

  it('renders Meta write approvals as fixed approve/reject choices', () => {
    const deck = {
      deckId: 'deck-write',
      status: 'awaiting' as const,
      createdAt: '2026-10-06T00:00:00Z',
      items: [{
        itemId: 'write-1',
        kind: 'meta_write',
        question: 'Create the reviewed ad set?',
        metaWriteManifestDigest: 'digest-1',
      }],
    };
    const state = {
      itemIndex: 0,
      selectedVerdict: 'approve',
      answers: [],
      freeText: '',
      freeTextCursor: 0,
    };
    const picker = flatten(renderApprovalDeck(deck, state))
      .find(node => node.id === 'approval-picker');
    expect((picker?.p?.items as any[]).map(item => item.id)).toEqual(['approve', 'reject', 'comment']);
    expect((picker?.p?.actions as any[]).some(action => action.id === 'delegate')).toBe(false);
  });

  it('requires one answer per deck item before submission is enabled', () => {
    const deck = {
      deckId: 'deck-2',
      status: 'awaiting' as const,
      createdAt: '2026-10-06T00:00:00Z',
      items: [
        {
          itemId: 'q1',
          kind: 'plan_choice',
          question: 'One?',
          options: [
            { id: 'a', label: 'A', recommended: true },
            { id: 'b', label: 'B' },
          ],
        },
        {
          itemId: 'q2',
          kind: 'plan_choice',
          question: 'Two?',
          options: [
            { id: 'c', label: 'C', recommended: true },
            { id: 'd', label: 'D' },
          ],
        },
      ],
    };

    expect(approvalDeckAllAnswered(deck, {
      itemIndex: 0,
      answers: [{ itemId: 'q1', verdict: 'a' }],
      freeText: '',
      freeTextCursor: 0,
    })).toBe(false);
    expect(approvalDeckAllAnswered(deck, {
      itemIndex: 1,
      answers: [
        { itemId: 'q1', verdict: 'a' },
        { itemId: 'q2', verdict: 'c' },
      ],
      freeText: '',
      freeTextCursor: 0,
    })).toBe(true);
  });

  it('renders coding-agent acceptance and preview URL inside the tool card', () => {
    const main = renderEmmaMain({
      sessionId: 's1',
      messages: [{
        role: 'assistant',
        content: 'Updated the page.',
        metadata: {
          toolCalls: [{
            id: 'coding-1',
            name: 'coding_agent',
            result: {
              success: true,
              previewUrl: 'https://preview.example',
              branch: 'draft/agentweb-preview',
              acceptanceStatus: 'passed',
              acceptance: {
                summary: 'Acceptance passed (2/2 checks).',
                checks: [
                  { id: 'a', label: 'Page loads', status: 'passed' },
                  { id: 'b', label: 'No console errors', status: 'passed' },
                ],
              },
            },
          }],
        },
      }],
    });

    const tool = flatten(main).find(node => node.id === 'msg.0.tool.coding-1');
    expect(tool?.c?.some(node => node.k === 'checklist')).toBe(true);
    const open = tool?.c?.find(node => node.p?.href === 'https://preview.example');
    expect(open?.p).toMatchObject({
      href: 'https://preview.example',
      actions: { click: 'open' },
    });
  });

  it('renders AgentRun traces as a full-screen picker with flags and tables', () => {
    const screen = renderAgentRunsScreen([{
      runId: 'run-1',
      sessionId: 's1',
      llmModel: 'gpt-test',
      status: 'completed',
      toolCalls: 3,
      failedToolCalls: 1,
      durationMs: 2500,
      outcomeVerdict: 'degraded',
      flags: [{
        code: 'failed_tool_calls',
        severity: 'critical',
        message: 'One call failed.',
      }],
      decisions: [{
        ts: '2026-10-06T00:00:00Z',
        iteration: 1,
        toolNames: ['coding_agent'],
        decisionExplanation: 'Edit the landing page.',
      }],
      outcomes: [{
        ts: '2026-10-06T00:00:01Z',
        eventType: 'agent_mode.tool_failed',
        toolName: 'coding_agent',
        durationMs: 1200,
        errorMessage: 'Acceptance failed.',
      }],
      chat: {
        title: 'Landing page edit',
        customerPortalUrl: 'https://app.example/agent-mode/s1',
      },
    }], 0);

    expect(screen).toMatchObject({
      id: 'main',
      k: 'col',
    });
    const runPicker = flatten(screen).find(node => node.id === 'run-picker');
    expect(runPicker).toMatchObject({
      k: 'picker',
      p: { size: 'screen', selected: 'run-1' },
    });
    expect(flatten(screen).some(node => node.id === 'run-preview.flags')).toBe(true);
    expect(flatten(screen).some(node => node.id === 'run-preview.decisions' && node.k === 'table')).toBe(true);
    expect(flatten(screen).some(node => node.id === 'run-preview.outcomes' && node.k === 'table')).toBe(true);
  });

  it('renders universal comment and reject-correction free text', () => {
    const deck = {
      deckId: 'deck-comment',
      status: 'awaiting' as const,
      createdAt: '2026-10-06T00:00:00Z',
      items: [{
        itemId: 'write-1',
        kind: 'meta_write',
        question: 'Apply this change?',
        allowFreeText: true,
        metaWriteManifestDigest: 'digest-1',
      }],
    };

    const comment = renderApprovalDeck(deck, {
      itemIndex: 0,
      selectedVerdict: 'comment',
      answers: [],
      freeText: '',
      freeTextCursor: 0,
    });
    const commentPicker = flatten(comment).find(node => node.id === 'approval-picker');
    expect(commentPicker?.p?.focus).toBe('preview');
    expect(flatten(comment).find(node => node.id === 'approval-note')).toMatchObject({
      k: 'input',
      p: { sendable: true },
    });
    expect((commentPicker?.p?.actions as any[])
      .find(action => action.id === 'choose')?.disabled).toBe('Add a comment first');

    const reject = renderApprovalDeck(deck, {
      itemIndex: 0,
      selectedVerdict: 'reject',
      answers: [],
      freeText: 'Use a lower budget.',
      freeTextCursor: 19,
    });
    expect(flatten(reject).find(node => node.id === 'approval-note')).toMatchObject({
      k: 'input',
      p: { text: 'Use a lower budget.', sendable: true },
    });
  });

  it('maps AgentWeb work-plan steps into a native checklist HUD', () => {
    const checklist = renderWorkPlanChecklist({
      sessionId: 's1',
      workPlan: {
        title: 'Launch campaign',
        steps: [
          { stepCount: 1, title: 'Research', status: 'completed' },
          { stepCount: 2, title: 'Build', status: 'pending', notes: 'Creating assets' },
          { stepCount: 3, title: 'Publish', status: 'pending' },
        ],
      },
    });

    expect(checklist).toMatchObject({
      k: 'checklist',
      p: {
        mode: 'hud',
        note: '1/3 · Launch campaign',
      },
    });
    const phases = checklist?.p?.phases as any[];
    expect(phases[0].items).toEqual([
      expect.objectContaining({ id: 'step-1', status: 'done' }),
      expect.objectContaining({ id: 'step-2', status: 'active', note: 'Creating assets' }),
      expect.objectContaining({ id: 'step-3', status: 'pending' }),
    ]);
  });

  it('makes the composer unsendable while Emma is running', () => {
    const dock = renderEmmaDock({
      text: 'hello',
      cursor: 5,
      running: true,
      session: { sessionId: 's1', llmModel: 'test-model' },
    });
    const editor = flatten(dock).find(node => node.id === 'composer');
    expect(editor?.p).toMatchObject({
      text: 'hello',
      cursor: 5,
      sendable: false,
    });
  });
});
