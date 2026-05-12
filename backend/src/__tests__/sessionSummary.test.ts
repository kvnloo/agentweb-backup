const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  })),
}));

const mockCallLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: mockCallLLM,
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSummary: jest.fn().mockResolvedValue(undefined),
  },
}));

import { summarizeSession, summarizeSessionIfNeeded } from '../services/sessionSummaryService';
import { chatbotDb } from '../services/chatbotService';

const mockUpdateSessionSummary = chatbotDb.updateSessionSummary as jest.Mock;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function makeLLMResponse(summary: string) {
  return {
    choices: [{ message: { content: JSON.stringify({ summary }) } }],
  };
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-1',
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
    messages: [],
    messageCount: 0,
    ...overrides,
  };
}

describe('summarizeSession', () => {
  beforeEach(() => jest.clearAllMocks());

  // --- FAIL CASES ---

  test('returns default summary when LLM returns empty JSON', async () => {
    mockCallLLM.mockResolvedValue({ choices: [{ message: { content: '{}' } }] });

    const result = await summarizeSession(
      [{ role: 'user', content: 'Write a blog post' }, { role: 'assistant', content: 'Here it is.' }],
      2
    );

    expect(result.summary).toBe('Session completed.');
    expect(result.evaluatedMessageIndex).toBe(2);
  });

  test('limits to last 50 messages when conversation is long', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse('Completed a task.'));

    const messages = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));

    await summarizeSession(messages, 80);

    const callArg = mockCallLLM.mock.calls[0][1];
    // user content is joined from last 50 messages
    const userContent = callArg.find((m: any) => m.role === 'user').content;
    expect(userContent).toContain('message 30'); // first of last 50
    expect(userContent).not.toContain('message 29'); // excluded
  });

  test('throws when LLM call times out', async () => {
    mockCallLLM.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))
    );

    await expect(
      summarizeSession([{ role: 'user', content: 'Hello' }], 1)
    ).rejects.toThrow();
  });

  // --- SUCCESS CASES ---

  test('calls LLM with correct model and returns parsed summary', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse('Created 3 LinkedIn posts and published them.'));

    const result = await summarizeSession(
      [
        { role: 'user', content: 'Create LinkedIn posts for my campaign' },
        { role: 'assistant', content: 'I created 3 posts for you.' },
      ],
      2
    );

    expect(mockCallLLM).toHaveBeenCalledWith(
      'gemini-3.1-flash-lite',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ]),
      expect.objectContaining({
        temperature: 0,
        max_completion_tokens: 200,
        response_format: { type: 'json_object' },
      })
    );
    expect(result.summary).toBe('Created 3 LinkedIn posts and published them.');
    expect(result.evaluatedMessageIndex).toBe(2);
  });

  test('serializes non-string message content to JSON before sending to LLM', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse('Task done.'));

    await summarizeSession(
      [{ role: 'user', content: [{ type: 'text', text: 'Do something' }] as any }],
      1
    );

    const userMsg = mockCallLLM.mock.calls[0][1].find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain('Do something');
  });
});

describe('summarizeSessionIfNeeded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateSessionSummary.mockResolvedValue(undefined);
  });

  // --- FAIL CASES ---

  test('returns null when summary is up-to-date (evaluatedMessageIndex >= messageCount)', async () => {
    const session = makeSession({
      messageCount: 4,
      sessionSummary: {
        summary: 'Existing summary.',
        evaluatedAt: daysAgo(1),
        evaluatedMessageIndex: 4,
      },
      messages: [
        { role: 'user', content: 'Do something' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    const result = await summarizeSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateSessionSummary).not.toHaveBeenCalled();
  });

  test('returns null when session has no user messages', async () => {
    const session = makeSession({
      messageCount: 1,
      messages: [{ role: 'assistant', content: 'Hello, how can I help?' }],
    });

    const result = await summarizeSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  test('returns null when session has no messages at all', async () => {
    const session = makeSession({ messageCount: 0, messages: [] });

    const result = await summarizeSessionIfNeeded(session);

    expect(result).toBeNull();
  });

  // --- SUCCESS CASES ---

  test('generates and persists summary when session has no prior summary', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse('Drafted a market research report.'));

    const session = makeSession({
      sessionId: 'sess-abc',
      messageCount: 6,
      messages: [
        { role: 'user', content: 'Research SaaS pricing' },
        { role: 'assistant', content: 'Here is the research...' },
      ],
    });

    const result = await summarizeSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe('Drafted a market research report.');
    expect(result!.evaluatedMessageIndex).toBe(6);
    expect(mockUpdateSessionSummary).toHaveBeenCalledWith('sess-abc', expect.objectContaining({
      summary: 'Drafted a market research report.',
      evaluatedMessageIndex: 6,
      evaluatedAt: expect.any(String),
    }));
  });

  test('regenerates summary when messageCount exceeds evaluatedMessageIndex', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse('Published 5 social posts.'));

    const session = makeSession({
      sessionId: 'sess-xyz',
      messageCount: 10,  // new messages since last eval
      sessionSummary: {
        summary: 'Old summary.',
        evaluatedAt: daysAgo(2),
        evaluatedMessageIndex: 4,  // stale
      },
      messages: [
        { role: 'user', content: 'Post on LinkedIn' },
        { role: 'assistant', content: 'Posted successfully.' },
      ],
    });

    const result = await summarizeSessionIfNeeded(session);

    expect(result!.summary).toBe('Published 5 social posts.');
    expect(result!.evaluatedMessageIndex).toBe(10);
    expect(mockUpdateSessionSummary).toHaveBeenCalledWith('sess-xyz', expect.objectContaining({
      summary: 'Published 5 social posts.',
      evaluatedMessageIndex: 10,
    }));
  });

  test('uses messageCount from messages array when messageCount field is absent', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse('Completed outreach.'));

    const session = makeSession({
      messageCount: undefined,
      messages: [
        { role: 'user', content: 'Do outreach' },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'Thanks' },
      ],
    });
    delete (session as any).messageCount;

    const result = await summarizeSessionIfNeeded(session);

    expect(result!.evaluatedMessageIndex).toBe(3); // derived from messages.length
  });
});
