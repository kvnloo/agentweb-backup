import {
  approvalDeckAllAnswered,
  approvalDeckIsAwaiting,
  filterSessions,
  renderAgentRunsScreen,
  renderApprovalDeck,
  renderEmmaDock,
  renderEmmaMain,
  runningToolForStart,
  nativeToolId,
  renderSessionPicker,
  renderWorkPlanChecklist,
  TspNode,
} from '../tern/renderEmma';
import { TspSurfaceReconciler } from '../tern/reconcile';
import { encodeTspJson } from '../tern/protocol';

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
    expect(nodes.find(node => node.id === 'tool.s1.find_leads.0')).toMatchObject({
      k: 'tool',
      p: { name: 'find_leads', status: 'done', took: 42 },
    });
  });

  it('renders live tools as running native tool cards', () => {
    const main = renderEmmaMain(
      { sessionId: 's1', messages: [] },
      [runningToolForStart({ sessionId: 's1' }, [], 'search_web', 900)],
      1000,
    );
    const tool = flatten(main).find(node => node.id === 'tool.s1.search_web.0');
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

    const tool = flatten(main).find(node => node.id === 'tool.s1.coding_agent.0');
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
  it('retains each keyed tool card through repeated same-name starts, success/failure, and rehydration', () => {
    const history = {
      sessionId: 's1',
      messages: [{
        role: 'assistant',
        metadata: { toolCalls: [{ id: 'old-uuid', name: 'search_web', result: { success: true } }] },
      }],
    };
    const inProgress = {
      ...history,
      messages: [...history.messages, { role: 'user', content: 'Search twice' }],
    };
    const first = runningToolForStart(inProgress, [], 'search_web', 100);
    const second = runningToolForStart(inProgress, [first], 'search_web', 110);
    expect(first.id).toBe(nativeToolId('s1', 'search_web', 1));
    expect(second.id).toBe(nativeToolId('s1', 'search_web', 2));
    expect(first.id).not.toBe(second.id);

    const runningFrame = renderEmmaMain(inProgress, [first, second], 200);
    const settledSession = {
      sessionId: 's1',
      messages: [
        ...inProgress.messages,
        {
          role: 'assistant',
          content: 'Search completed with one failure',
          metadata: {
            toolCalls: [
              { id: 'server-uuid-a', name: 'search_web', result: { success: true } },
              { id: 'server-uuid-b', name: 'search_web', error: { message: 'Rate limited' } },
            ],
          },
        },
      ],
    };
    const settledFrame = renderEmmaMain(settledSession);
    expect(flatten(settledFrame).find(node => node.id === first.id)?.p?.status).toBe('done');
    expect(flatten(settledFrame).find(node => node.id === second.id)?.p?.status).toBe('error');

    const reconciler = new TspSurfaceReconciler('emma');
    reconciler.commit([runningFrame]);
    const ops = reconciler.diff([settledFrame]);
    for (const id of [first.id, second.id]) {
      expect(ops.some(op => (op[0] === 'del' || op[0] === 'add') && op[1] === id)).toBe(false);
      expect(ops.some(op => op[0] === 'set' && op[1] === id)).toBe(true);
    }
    reconciler.commit([settledFrame]);
    const hydrated = renderEmmaMain(JSON.parse(JSON.stringify(settledSession)));
    expect(reconciler.diff([hydrated])).toEqual([]);
  });

  it('projects nested HTTP auth and private URLs out of all Emma native frames', () => {
    const authorization = 'SYNTH_BEARER_834629731';
    const accessToken = 'SYNTH_ACCESS_TOKEN_2039471';
    const signedToken = 'SYNTH_SIGNED_TOKEN_173902';
    const userPassword = 'SYNTH_USERINFO_PASSWORD_17349';
    const signedUrl = 'https://preview.example/app?X-Amz-Signature=' + signedToken;
    const userinfoUrl = 'https://test:' + userPassword + '@preview.example/app';
    const safeUrl = 'https://preview.example/app?page=2';

    const session = {
      sessionId: 'secure',
      title: 'Normal conversation',
      messages: [{
        role: 'assistant',
        content: 'The request failed; retry is possible.',
        metadata: {
          toolCalls: [
            {
              id: 'failed',
              name: 'search_web',
              error: {
                message: 'Request failed after two retries',
                config: {
                  headers: {
                    Authorization: 'Bearer ' + authorization,
                    'x-access-token': accessToken,
                    method: 'GET',
                  },
                  url: userinfoUrl,
                  metadata: [{ accessToken, signedUrl, note: 'Rate limited' }],
                },
                response: { status: 429, data: { reason: 'Slow down' } },
              },
            },
            {
              id: 'failed-result',
              name: 'fetch_resource',
              result: {
                success: false,
                error: 'Request returned HTTP 403',
                request: {
                  headers: { authorization: 'Bearer ' + authorization, accessToken },
                  previewUrl: signedUrl,
                  safeStatus: 'Forbidden',
                },
              },
            },
            {
              id: 'userinfo-preview',
              name: 'get_landing_page_preview_url',
              result: { success: true, url: userinfoUrl },
            },
            {
              id: 'unsafe-preview',
              name: 'coding_agent',
              result: {
                success: true,
                previewUrl: signedUrl,
                acceptance: { summary: 'Preview was generated' },
              },
            },
            {
              id: 'safe-preview',
              name: 'coding_agent',
              result: { success: true, previewUrl: safeUrl, branch: 'main' },
            },
          ],
        },
      }],
      workPlan: {
        title: 'Review the site',
        steps: [{ stepCount: 1, title: 'Inspect', status: 'pending' as const, notes: signedUrl }],
      },
    };
    const main = renderEmmaMain(session);
    const failed = flatten(main).find(node => node.id === 'tool.secure.search_web.0');
    expect(failed?.p?.status).toBe('error');
    expect(failed?.c?.find(node => node.k === 'code')?.p?.text)
      .toContain('Request failed after two retries');
    expect(failed?.c?.find(node => node.k === 'code')?.p?.text)
      .toContain('Slow down');
    expect(flatten(main).some(node => node.p?.href === safeUrl)).toBe(true);
    expect(flatten(main).some(node => node.p?.href === signedUrl)).toBe(false);
    expect(flatten(main).some(node => node.p?.href === userinfoUrl)).toBe(false);
    const failedResult = flatten(main).find(node => node.id === 'tool.secure.fetch_resource.0');
    expect(failedResult?.p?.status).toBe('error');
    expect(failedResult?.c?.find(node => node.k === 'code')?.p?.text).toContain('Forbidden');

    const deck = {
      deckId: 'deck-privacy',
      createdAt: '2026-10-06T00:00:00Z',
      status: 'awaiting' as const,
      items: [{
        itemId: 'q1',
        kind: 'meta_objective',
        question: 'Review this: ' + signedUrl,
        options: [{ id: 'yes', label: 'Yes', consequence: 'Authorization: Bearer ' + authorization }],
      }],
    };
    const layer = renderApprovalDeck(deck, {
      itemIndex: 0,
      answers: [],
      selectedVerdict: 'yes',
      freeText: '',
      freeTextCursor: 0,
    });
    const picker = renderSessionPicker({
      sessions: [{
        ...session,
        sessionType: 'scheduled',
        previewText: 'Safe resume, private link ' + userinfoUrl,
      }],
      query: '',
      selected: 0,
      cursor: 0,
    }, 'secure');
    const dock = renderEmmaDock({
      session,
      text: '',
      cursor: 0,
      running: false,
      error: 'Bearer ' + authorization,
    });
    const runs = renderAgentRunsScreen([{
      runId: 'run-1',
      status: 'failed' as const,
      toolCalls: 1,
      failedToolCalls: 1,
      flags: [{ code: 'retry', severity: 'warning' as const, message: 'Try again', evidence: signedUrl }],
      decisions: [{ ts: '', toolNames: ['search_web'], decisionExplanation: 'Authorization: Bearer ' + authorization }],
      outcomes: [{ ts: '', eventType: 'failed', errorMessage: 'access_token=' + accessToken }],
      chat: { customerPortalUrl: userinfoUrl },
    }], 0);
    const frames: TspNode[][] = [
      [main, dock, layer],
      [picker],
      [runs],
    ];
    const serialized = frames.map((roots, index) => {
      const reconciler = new TspSurfaceReconciler('emma-privacy-' + index);
      return encodeTspJson('f', {
        sf: 'emma-privacy-' + index,
        s: 1,
        ops: reconciler.diff(roots),
      });
    }).join('');
    for (const secret of [authorization, accessToken, signedToken, userPassword]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('Request failed after two retries');
    expect(serialized).toContain('Try again');
    expect(serialized).toContain(safeUrl);
    expect(serialized).not.toContain(userinfoUrl);
    expect(serialized).not.toContain(signedUrl);
  });

});
