import {
  stripImageDataForPersistence,
  computeCheckpointBatch,
} from '../services/agentMode/incrementalPersist';

describe('incrementalPersist.stripImageDataForPersistence', () => {
  it('strips image_url items from tool-message array content, joining remaining text', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: 'line two' },
        ],
      },
    ];
    const [out] = stripImageDataForPersistence(messages);
    expect(out.content).toBe('line one\nline two');
  });

  it('replaces a tool message that is ONLY an image with a placeholder', () => {
    const messages = [
      {
        role: 'tool',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      },
    ];
    const [out] = stripImageDataForPersistence(messages);
    expect(out.content).toBe('[screenshot captured]');
  });

  it('leaves assistant/string-content messages untouched (does not mutate input)', () => {
    const assistant = { role: 'assistant', content: 'hello', usage: { total_tokens: 5 } };
    const toolString = { role: 'tool', content: 'plain string result' };
    const input = [assistant, toolString];
    const out = stripImageDataForPersistence(input);
    expect(out[0]).toEqual(assistant);
    expect(out[1]).toEqual(toolString);
    // input array itself is not mutated in place
    expect(input[0]).toBe(assistant);
  });

  it('returns [] for empty input', () => {
    expect(stripImageDataForPersistence([])).toEqual([]);
  });
});

describe('incrementalPersist.computeCheckpointBatch', () => {
  const sys = { role: 'system', content: 'sys' };
  const skills = { role: 'assistant', content: 'Available Skills: ...' };
  const asst = (n: number) => ({ role: 'assistant', content: `answer ${n}`, usage: { total_tokens: n } });
  const tool = (n: number) => ({ role: 'tool', content: `tool ${n}` });
  const userInject = { role: 'user', content: '[SYSTEM] continue' };

  it('returns nothing new when the response tail is fully persisted (idempotent)', () => {
    const messages = [sys, skills, asst(1), tool(1)];
    const initialMessageCount = 2; // sys + skills are context
    const { toPersist, newPersistedCount } = computeCheckpointBatch(messages, initialMessageCount, 2);
    expect(toPersist).toEqual([]);
    expect(newPersistedCount).toBe(2);
  });

  it('persists only the settled response tail beyond the cursor, excluding user messages', () => {
    // response tail (after boundary) = [asst1, tool1, userInject, asst2, tool2]
    // user messages are filtered out, so response messages = [asst1, tool1, asst2, tool2]
    const messages = [sys, skills, asst(1), tool(1), userInject, asst(2), tool(2)];
    const initialMessageCount = 2;
    // already persisted 2 (asst1, tool1) → should return [asst2, tool2]
    const { toPersist, newPersistedCount } = computeCheckpointBatch(messages, initialMessageCount, 2);
    expect(toPersist.map((m: any) => m.content)).toEqual(['answer 2', 'tool 2']);
    expect(newPersistedCount).toBe(4);
  });

  it('from a zero cursor returns the whole response tail (user-injected messages excluded)', () => {
    const messages = [sys, skills, asst(1), tool(1), userInject, asst(2)];
    const { toPersist, newPersistedCount } = computeCheckpointBatch(messages, 2, 0);
    expect(toPersist.map((m: any) => m.content)).toEqual(['answer 1', 'tool 1', 'answer 2']);
    expect(newPersistedCount).toBe(3);
  });

  it('image-strips tool messages in the batch it returns', () => {
    const messages = [
      sys,
      { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ];
    const { toPersist } = computeCheckpointBatch(messages, 1, 0);
    expect(toPersist[0].content).toBe('[screenshot captured]');
  });

  it('never returns a negative/short batch when cursor already exceeds tail (defensive)', () => {
    const messages = [sys, asst(1)];
    const { toPersist, newPersistedCount } = computeCheckpointBatch(messages, 1, 5);
    expect(toPersist).toEqual([]);
    expect(newPersistedCount).toBe(5);
  });

  it('handles empty / missing messages array', () => {
    expect(computeCheckpointBatch([], 0, 0)).toEqual({ toPersist: [], newPersistedCount: 0 });
    expect(computeCheckpointBatch(undefined as any, 0, 0)).toEqual({ toPersist: [], newPersistedCount: 0 });
  });
});
