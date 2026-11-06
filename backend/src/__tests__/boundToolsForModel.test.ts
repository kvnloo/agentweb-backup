import { boundToolsForModel } from '../utils/boundToolsForModel';

const tool = (name: string) => ({ type: 'function', function: { name } });
const names = (tools: Array<{ function: { name: string } }>) => tools.map((t) => t.function.name);

describe('boundToolsForModel (ENG-2824)', () => {
  const tools = Array.from({ length: 10 }, (_, i) => tool(`t${i}`));

  it('returns the list unchanged when it fits', () => {
    expect(boundToolsForModel(tools, 10, ['t9'])).toBe(tools);
  });

  it('keeps the first N when there are no priority tools (previous behaviour)', () => {
    expect(names(boundToolsForModel(tools, 3, undefined))).toEqual(['t0', 't1', 't2']);
    expect(names(boundToolsForModel(tools, 3, []))).toEqual(['t0', 't1', 't2']);
  });

  it('keeps a required tool that sits past the limit (the Phoenix slack_send_message case)', () => {
    const list = [...tools, tool('slack_send_message')];
    const bounded = names(boundToolsForModel(list, 5, ['slack_send_message', 'not_offered']));
    expect(bounded).toHaveLength(5);
    expect(bounded).toContain('slack_send_message');
    expect(bounded).toEqual(['t0', 't1', 't2', 't3', 'slack_send_message']);
  });

  it('never exceeds the limit even when priority tools alone exceed it', () => {
    const bounded = names(boundToolsForModel(tools, 2, ['t5', 't6', 't7']));
    expect(bounded).toEqual(['t5', 't6']);
  });

  it('handles a zero limit', () => {
    expect(boundToolsForModel(tools, 0, ['t1'])).toEqual([]);
  });
});
