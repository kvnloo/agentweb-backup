import {
  filterSessions,
  renderEmmaDock,
  renderEmmaMain,
  renderSessionPicker,
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
