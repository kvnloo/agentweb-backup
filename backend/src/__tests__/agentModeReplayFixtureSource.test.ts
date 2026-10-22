import { REPLAY_FIXTURES, checkAllReplayFixtures } from '../loops/eval/agentModeReplayFixtures';
import type AWS from 'aws-sdk';
import { chatMessagesFetcher, extractReplayTurns, loadReplayFixtures, type ReplayMessage } from '../loops/eval/agentModeReplayFixtureSource';
import { newGoldenCase } from '../loops/eval/goldenSet';
import { createGoldenSetStore, type GoldenSetStore } from '../loops/eval/goldenSetStore';

const NOW = new Date('2026-09-25T00:00:00.000Z');

function storeWith(links: Record<string, { sessionId: string; messageIndex: number }>): GoldenSetStore {
  return storeWithLinks(Object.entries(links));
}

function storeWithLinks(links: Array<[string, { sessionId: string; messageIndex: number }]>): GoldenSetStore {
  const cases = links.map(([fixtureId, l]) =>
    newGoldenCase({ surface: 'agent', taskType: 'replay_fixture', sourceId: l.sessionId, seedSource: `replay_fixture:${fixtureId}`, now: NOW, replay: { fixtureId, messageIndex: l.messageIndex } }),
  );
  return {
    tableName: 'T',
    isProvisioned: () => true,
    listCases: jest.fn(async () => cases),
    getCase: jest.fn(),
    createCase: jest.fn(),
    saveLabels: jest.fn(),
    saveDraft: jest.fn(),
    setExclusion: jest.fn(),
  };
}

// Synthetic stand-in for a real session: the long reply is what ENG-1309 reported.
const MESSAGES: ReplayMessage[] = [
  { messageIndex: 14, role: 'assistant', content: 'earlier' },
  { messageIndex: 15, role: 'user', content: 'Is it X?' },
  { messageIndex: 16, role: 'tool', content: '{"ok":true}' },
  { messageIndex: 17, role: 'assistant', content: 'Yes. ' + 'x'.repeat(900) },
  { messageIndex: 18, role: 'user', content: 'next question' },
  { messageIndex: 19, role: 'assistant', content: 'later' },
];

describe('replay fixture content source (ENG-2135)', () => {
  it('extracts the user turn and the assistant turns answering it, stopping at the next user turn', () => {
    expect(extractReplayTurns(MESSAGES, 15)).toEqual([
      { role: 'user', content: 'Is it X?' },
      { role: 'assistant', content: 'Yes. ' + 'x'.repeat(900) },
    ]);
    expect(extractReplayTurns(MESSAGES, 17)).toBeNull();
    expect(extractReplayTurns(MESSAGES, 99)).toBeNull();
    expect(extractReplayTurns([{ messageIndex: 1, role: 'user', content: 'q' }], 1)).toBeNull();
  });

  it('keeps every synthetic fixture unchanged when the store is not provisioned', async () => {
    const fetchMessages = jest.fn();
    const out = await loadReplayFixtures({ store: createGoldenSetStore({ tableName: null }), fetchMessages });
    expect(out.fixtures).toEqual(REPLAY_FIXTURES);
    expect(out.notes).toEqual([expect.stringMatching(/not provisioned/)]);
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('swaps in real turns for a linked fixture only, leaving its threshold and the checker unchanged', async () => {
    const fetchMessages = jest.fn(async () => MESSAGES);
    const out = await loadReplayFixtures({ store: storeWith({ 'yesno-terse-1': { sessionId: 'sess-1', messageIndex: 15 } }), fetchMessages });
    expect(fetchMessages).toHaveBeenCalledWith('sess-1', 15);

    const real = out.fixtures.find((f) => f.id === 'yesno-terse-1');
    const original = REPLAY_FIXTURES.find((f) => f.id === 'yesno-terse-1');
    expect(real).toMatchObject({ isPlaceholder: false, assertion: original?.assertion, pending: false, thresholdSource: original?.thresholdSource });
    expect(real?.turns[0]).toEqual({ role: 'user', content: 'Is it X?' });
    expect(out.fixtures.filter((f) => f.isPlaceholder)).toHaveLength(REPLAY_FIXTURES.length - 1);

    // The real (over-threshold) reply is caught by the same checker that passes the placeholder.
    const results = checkAllReplayFixtures(out.fixtures);
    expect(results.find((r) => r.id === 'yesno-terse-1')).toMatchObject({ pass: false });
    expect(checkAllReplayFixtures(REPLAY_FIXTURES).every((r) => r.pass)).toBe(true);
  });

  it('falls back to the placeholder with a note when the linked turn is unusable or unreadable', async () => {
    const out = await loadReplayFixtures({
      store: storeWith({ 'yesno-terse-1': { sessionId: 's1', messageIndex: 17 }, 'yesno-terse-2': { sessionId: 's2', messageIndex: 15 } }),
      fetchMessages: async (sessionId) => {
        if (sessionId === 's2') throw new Error('AccessDenied');
        return MESSAGES;
      },
    });
    expect(out.fixtures).toEqual(REPLAY_FIXTURES);
    expect(out.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/yesno-terse-1: linked message is not a user turn/),
        expect.stringMatching(/yesno-terse-2: could not read the linked session \(AccessDenied\)/),
        expect.stringMatching(/length-limit-ignored-1: no golden case links this fixture/),
      ]),
    );
  });

  it('keeps the placeholder when two cases link the same fixture instead of silently picking one', async () => {
    const fetchMessages = jest.fn(async () => MESSAGES);
    const out = await loadReplayFixtures({
      store: storeWithLinks([
        ['yesno-terse-1', { sessionId: 's1', messageIndex: 15 }],
        ['yesno-terse-1', { sessionId: 's2', messageIndex: 15 }],
      ]),
      fetchMessages,
    });
    expect(out.fixtures).toEqual(REPLAY_FIXTURES);
    expect(out.notes).toEqual(expect.arrayContaining([expect.stringMatching(/yesno-terse-1: linked by 2 golden cases/)]));
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('reads text parts of structured content and rejects a turn whose content has no text', () => {
    const structured: ReplayMessage[] = [
      { messageIndex: 1, role: 'user', content: [{ type: 'text', text: 'Is it ' }, { type: 'image_url', image_url: {} }, { type: 'text', text: 'on?' }] },
      { messageIndex: 2, role: 'assistant', content: [{ type: 'text', text: 'Yes.' }] },
    ];
    expect(extractReplayTurns(structured, 1)).toEqual([
      { role: 'user', content: 'Is it on?' },
      { role: 'assistant', content: 'Yes.' },
    ]);
    const imageOnlyPrompt: ReplayMessage[] = [
      { messageIndex: 1, role: 'user', content: [{ type: 'image_url', image_url: {} }] },
      { messageIndex: 2, role: 'assistant', content: 'Yes.' },
    ];
    expect(extractReplayTurns(imageOnlyPrompt, 1)).toBeNull();
    const unreadableReply: ReplayMessage[] = [
      { messageIndex: 1, role: 'user', content: 'Is it on?' },
      { messageIndex: 2, role: 'assistant', content: { unexpected: true } },
      { messageIndex: 3, role: 'assistant', content: 'Yes.' },
    ];
    expect(extractReplayTurns(unreadableReply, 1)).toBeNull();
  });

  it('passes structured content from AW-ChatMessages through to extraction instead of blanking it', async () => {
    const query = jest.fn(() => ({
      promise: async () => ({
        Items: [
          { messageIndex: 1, message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
          { messageIndex: 2, message: { role: 'assistant', content: 'a' } },
        ],
      }),
    }));
    const fetch = chatMessagesFetcher({ query } as unknown as AWS.DynamoDB.DocumentClient);
    const messages = await fetch('s1', 1);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'q' }]);
    expect(extractReplayTurns(messages, 1)).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  });
});
