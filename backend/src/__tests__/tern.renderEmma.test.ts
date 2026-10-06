import {
  renderEmmaDock,
  renderEmmaMain,
  TspNode,
} from '../tern/renderEmma';

function flatten(node: TspNode): TspNode[] {
  return [node, ...(node.c ?? []).flatMap(flatten)];
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
