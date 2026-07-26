/**
 * Unit tests for handleLoopApprovalReaction.
 *
 * Covers:
 * - Gate checks: wrong reaction, wrong user, non-DM channel, missing fields
 * - Idempotency: second ✅ on same ts is a no-op
 * - Bot-authorship check: non-bot messages are ignored
 * - Footer check: messages without the dispatch footer are ignored
 * - legacy Notion links are not dispatched
 * - tasks path: files approved work through canonical fail-closed Linear intake
 * - markDispatched called BEFORE postThread (race-condition guard)
 */

import type { ReactionAddedEvent } from '../services/loopSlackApprovalDispatcher';

// --- Slack mock -----------------------------------------------------------------

const mockPostMessage = jest.fn().mockResolvedValue({});
const mockHistoryFn = jest.fn();
const mockAuthTest = jest.fn().mockResolvedValue({ user_id: 'UBOT123' });

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    conversations: { history: mockHistoryFn },
    chat: { postMessage: mockPostMessage },
    auth: { test: mockAuthTest },
  })),
}));

// --- loopDispatchTracker mock ---------------------------------------------------

const mockGetDispatched = jest.fn();
const mockMarkDispatched = jest.fn();
let dispatchEntry: { dispatchedAt: Date; pageIds: string[] } | null = null;

jest.mock('../services/loopDispatchTracker', () => ({
  getDispatched: (...args: unknown[]) => mockGetDispatched(...args),
  markDispatched: (...args: unknown[]) => mockMarkDispatched(...args),
}));

// --- canonical Linear intake mock ----------------------------------------------

const mockFileAutoIssue = jest.fn().mockResolvedValue({
  pageId: 'ENG-600',
  url: 'https://linear.app/emmabyaw/issue/ENG-600',
  deduped: false,
  tracker: 'Linear',
});

jest.mock('../services/intakeService', () => ({
  fileAutoIssue: (...args: unknown[]) => mockFileAutoIssue(...args),
}));

// -------------------------------------------------------------------------------

import {
  handleLoopApprovalReaction,
  _resetLoopApprovalForTesting,
} from '../services/loopSlackApprovalDispatcher';

const APPROVED_USER = 'U08TM4QFQ1L';
const DM_CHANNEL = 'D12345ABC';
const MSG_TS = '1700000000.123456';
const FOOTER = 'React ✅ to dispatch all to cloud-dev';

function makeEvent(overrides: Partial<ReactionAddedEvent> = {}): ReactionAddedEvent {
  return {
    type: 'reaction_added',
    reaction: 'white_check_mark',
    user: APPROVED_USER,
    item: { type: 'message', channel: DM_CHANNEL, ts: MSG_TS },
    ...overrides,
  };
}

function mockBotMessage(text: string, bot_id = 'BBOT123'): void {
  mockHistoryFn.mockResolvedValueOnce({
    messages: [{ text, bot_id }],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetLoopApprovalForTesting();
  dispatchEntry = null;
  mockGetDispatched.mockImplementation(async () => dispatchEntry);
  mockMarkDispatched.mockImplementation(async (_ts: string, pageIds: string[]) => {
    dispatchEntry = { dispatchedAt: new Date(), pageIds: [...pageIds] };
  });
  mockAuthTest.mockResolvedValue({ user_id: 'UBOT123' });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — gate checks', () => {
  it('ignores non-checkmark reactions', async () => {
    await handleLoopApprovalReaction(makeEvent({ reaction: 'thumbsup' }));
    expect(mockHistoryFn).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('ignores reactions from non-approved users', async () => {
    await handleLoopApprovalReaction(makeEvent({ user: 'USTRANGER1' }));
    expect(mockHistoryFn).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('ignores reactions on non-DM channels', async () => {
    await handleLoopApprovalReaction(
      makeEvent({ item: { type: 'message', channel: 'C12345ABC', ts: MSG_TS } }),
    );
    expect(mockHistoryFn).not.toHaveBeenCalled();
  });

  it('ignores events with missing item fields', async () => {
    await handleLoopApprovalReaction(makeEvent({ item: undefined }));
    expect(mockHistoryFn).not.toHaveBeenCalled();
  });

  it('ignores events where item type is not message', async () => {
    await handleLoopApprovalReaction(
      makeEvent({ item: { type: 'file', channel: DM_CHANNEL, ts: MSG_TS } }),
    );
    expect(mockHistoryFn).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — idempotency', () => {
  it('skips tasks whose IDs are already marked dispatched', async () => {
    mockBotMessage(`*Daily digest*\nRun ID: run-001\n1. Fix the thing\n\n${FOOTER}`);
    dispatchEntry = {
      dispatchedAt: new Date(),
      pageIds: ['daily-digest-run-001-1'],
    };
    await handleLoopApprovalReaction(makeEvent());
    expect(mockHistoryFn).toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — bot-authorship gate', () => {
  it('ignores messages not authored by the bot', async () => {
    // history returns a human-authored message (no bot_id, user ≠ emmaBotUserId)
    mockHistoryFn.mockResolvedValueOnce({
      messages: [{ text: `Some text\n${FOOTER}`, user: 'UHUMAN1' }],
    });
    await handleLoopApprovalReaction(makeEvent());
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
  });

  it('proceeds when message has a bot_id (no user field check needed)', async () => {
    mockBotMessage(`*Daily digest*\nRun ID: run-001\n1. Fix the thing\n\n${FOOTER}`);
    await handleLoopApprovalReaction(makeEvent());
    // Should attempt dispatch (postMessage called at least once)
    expect(mockPostMessage).toHaveBeenCalled();
  });

  it('ignores messages fetched when history returns empty', async () => {
    mockHistoryFn.mockResolvedValueOnce({ messages: [] });
    await handleLoopApprovalReaction(makeEvent());
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — footer gate', () => {
  it('ignores bot messages that do not contain the dispatch footer', async () => {
    mockBotMessage('*Daily digest*\nRun ID: run-001\n1. Fix something');
    await handleLoopApprovalReaction(makeEvent());
    expect(mockMarkDispatched).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — legacy Notion path removed', () => {
  // 32 lowercase hex chars required by extractNotionPageIds regex
  const PAGE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const NOTION_URL = `https://www.notion.so/my-workspace/Page-Title-${PAGE_ID}`;

  beforeEach(() => {
    mockBotMessage(
      `*Weekly Loop Digest*\nRun ID: run-xyz\n<${NOTION_URL}|Page Title>\n\n${FOOTER}`,
    );
  });

  it('does not launch or mark legacy Notion pages as dispatched', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage.mock.calls[0][0].text).toMatch(/could not parse/i);
  });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — tasks path (no Notion URLs)', () => {
  const taskText = [
    '*AI Readiness Funnel — daily run*',
    'Run ID: `run-tasks-001`',
    '',
    '1. `comp-a` — Remove unused import',
    '   Evidence: import foo unused | Confidence: 0.9 | Needs approval: yes',
    '',
    FOOTER,
  ].join('\n');

  beforeEach(() => {
    mockBotMessage(taskText);
  });

  it('calls markDispatched with task IDs before posting', async () => {
    const callOrder: string[] = [];
    mockMarkDispatched.mockImplementation(() => callOrder.push('markDispatched'));
    mockPostMessage.mockImplementation(() => {
      callOrder.push('postMessage');
      return Promise.resolve({});
    });

    await handleLoopApprovalReaction(makeEvent());

    expect(callOrder[0]).toBe('markDispatched');
    expect(callOrder[1]).toBe('postMessage');
  });

  it('files each parsed task through canonical Linear intake', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockFileAutoIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        executionRoute: 'human-triage',
        source: expect.stringContaining('Slack approval'),
        notionContext: expect.objectContaining({
          'Alert Class': expect.stringContaining('slack-approved-loop:'),
        }),
      }),
    );
  });

  it('does not invoke the retired cloud-dev environment launcher', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockFileAutoIssue).toHaveBeenCalledTimes(1);
    expect(mockFileAutoIssue.mock.calls[0][0].title).toContain('comp-a');
  });

  it('posts a summary thread after dispatch', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    const summary = mockPostMessage.mock.calls[1][0].text as string;
    expect(summary).toMatch(/✅ Queued/);
  });

  it('removes failed task claims so a later reaction retries them', async () => {
    mockFileAutoIssue
      .mockRejectedValueOnce(new Error('Linear unavailable'))
      .mockResolvedValueOnce({
        pageId: 'ENG-601',
        url: 'https://linear.app/emmabyaw/issue/ENG-601',
        deduped: false,
        tracker: 'Linear',
      });

    await handleLoopApprovalReaction(makeEvent());
    expect(dispatchEntry?.pageIds).toEqual([]);

    mockBotMessage(taskText);
    await handleLoopApprovalReaction(makeEvent());

    expect(mockFileAutoIssue).toHaveBeenCalledTimes(2);
    expect(dispatchEntry?.pageIds).toEqual(['comp-a']);
  });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — explicit legacy Autofix admission', () => {
  it('routes only an explicitly admitted code change to Autofix', async () => {
    mockBotMessage([
      '*Reliability Loop — daily run*',
      'Run ID: `run-safe-code-001`',
      '',
      '1. Typed tool schema no longer matches the handler',
      '   Kind: `code_change`',
      '   Autofix eligible: yes',
      '',
      FOOTER,
    ].join('\n'));

    await handleLoopApprovalReaction(makeEvent());

    expect(mockFileAutoIssue).toHaveBeenCalledWith(
      expect.objectContaining({ executionRoute: 'autofix' }),
    );
  });
});

// -------------------------------------------------------------------------------

describe('handleLoopApprovalReaction — no dispatchable tasks', () => {
  it('posts a warning when footer present but no parseable items', async () => {
    mockBotMessage(`*Empty Digest*\nRun ID: run-empty\n\n${FOOTER}`);
    await handleLoopApprovalReaction(makeEvent());
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const msg = mockPostMessage.mock.calls[0][0].text as string;
    expect(msg).toMatch(/could not parse/i);
    expect(mockMarkDispatched).not.toHaveBeenCalled();
  });
});
