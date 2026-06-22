/**
 * Unit tests for handleLoopApprovalReaction.
 *
 * Covers:
 * - Gate checks: wrong reaction, wrong user, non-DM channel, missing fields
 * - Idempotency: second ✅ on same ts is a no-op
 * - Bot-authorship check: non-bot messages are ignored
 * - Footer check: messages without the dispatch footer are ignored
 * - pageIds path: dispatches existing Notion pages found in message
 * - tasks path: creates + dispatches new Notion tasks parsed from message
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

const mockIsDispatched = jest.fn().mockReturnValue(false);
const mockMarkDispatched = jest.fn();

jest.mock('../services/loopDispatchTracker', () => ({
  isDispatched: (...args: unknown[]) => mockIsDispatched(...args),
  markDispatched: (...args: unknown[]) => mockMarkDispatched(...args),
}));

// --- notionService mock ---------------------------------------------------------

jest.mock('../services/notionService', () => ({
  getNotionCredentials: jest.fn().mockResolvedValue({ apiToken: 'ntn_fake' }),
  getSprintTasksDatabaseId: jest.fn().mockResolvedValue('db-fake-id'),
}));

// --- devEnvService mock (dynamic import) ----------------------------------------

const mockLaunchEnvironment = jest.fn().mockResolvedValue(undefined);
const mockGetNotionPage = jest.fn().mockResolvedValue({ title: 'Test Page' });
const mockGetNotionPageContent = jest.fn().mockResolvedValue({ text: 'page body' });

jest.mock('../services/devEnvService', () => ({
  launchEnvironment: (...args: unknown[]) => mockLaunchEnvironment(...args),
  getNotionPage: (...args: unknown[]) => mockGetNotionPage(...args),
  getNotionPageContent: (...args: unknown[]) => mockGetNotionPageContent(...args),
}));

// --- global fetch mock (for Notion API calls) -----------------------------------

global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({
    object: 'page',
    id: 'notion-page-id-abc123',
    url: 'https://notion.so/notion-page-id-abc123',
  }),
}) as jest.Mock;

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
  mockIsDispatched.mockReturnValue(false);
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
  it('skips dispatch when ts is already marked dispatched', async () => {
    mockIsDispatched.mockReturnValue(true);
    await handleLoopApprovalReaction(makeEvent());
    expect(mockHistoryFn).not.toHaveBeenCalled();
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

describe('handleLoopApprovalReaction — pageIds path', () => {
  // 32 lowercase hex chars required by extractNotionPageIds regex
  const PAGE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const NOTION_URL = `https://www.notion.so/my-workspace/Page-Title-${PAGE_ID}`;

  beforeEach(() => {
    mockBotMessage(
      `*Weekly Loop Digest*\nRun ID: run-xyz\n<${NOTION_URL}|Page Title>\n\n${FOOTER}`,
    );
  });

  it('calls markDispatched with the extracted page IDs', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockMarkDispatched).toHaveBeenCalledWith(MSG_TS, [PAGE_ID]);
  });

  it('calls markDispatched BEFORE postThread (race-condition guard)', async () => {
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

  it('calls launchEnvironment for each page ID', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockLaunchEnvironment).toHaveBeenCalledWith(
      PAGE_ID,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('posts a summary thread message after dispatch', async () => {
    await handleLoopApprovalReaction(makeEvent());
    // Two postMessage calls: "Dispatching..." and the summary
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    const summaryCall = mockPostMessage.mock.calls[1][0];
    expect(summaryCall.text).toMatch(/✅ Launched/);
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

  it('creates a Notion page for each parsed task', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('calls launchEnvironment for each created task', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockLaunchEnvironment).toHaveBeenCalledTimes(1);
    expect(mockLaunchEnvironment).toHaveBeenCalledWith(
      'notion-page-id-abc123',
      expect.stringContaining('comp-a'),
      expect.any(String),
      expect.any(String),
    );
  });

  it('posts a summary thread after dispatch', async () => {
    await handleLoopApprovalReaction(makeEvent());
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    const summary = mockPostMessage.mock.calls[1][0].text as string;
    expect(summary).toMatch(/✅ Launched/);
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
