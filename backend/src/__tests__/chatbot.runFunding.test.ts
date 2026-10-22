/**
 * ENG-1816 F1 — controllers/chatbot.ts's sendMessage and sendMessageStream are
 * 2 of the sidebar assistant's 3 real entry points (the third is
 * chatSocketHandler.ts, covered separately). Without wrapping their
 * generateChatResponse call in withRunFunding, chatbotService's
 * embeddings-attribution fix reads currentRunFunding() as undefined — a silent
 * no-op — on every real HTTP sidebar turn.
 *
 * Found unwrapped by a round-1 PR review; the fix has since been re-traced by
 * code review 3 more times (rounds 2, 4, 5) but never actually executed by
 * anything until this test.
 */

import { Response } from 'express';
import { sendMessage, sendMessageStream } from '../controllers/chatbot';
import { chatbotDb, generateChatResponse } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';
import { currentRunFunding, resolveRunFunding, type RunFunding } from '../services/funding/runFunding';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn() },
  generateChatResponse: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-03',
  }),
}));

jest.mock('../services/funding/runFunding', () => {
  const actual = jest.requireActual('../services/funding/runFunding');
  return { ...actual, resolveRunFunding: jest.fn() };
});

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockGenerateChatResponse = generateChatResponse as jest.Mock;
const mockResolveRunFunding = resolveRunFunding as jest.MockedFunction<typeof resolveRunFunding>;

const USER = 'user-1816';

function makeFunding(): RunFunding {
  return {
    route: 'agentweb',
    fallback: 'agentweb',
    ownerUserId: USER,
    billingUserId: USER,
    resolvedAt: new Date().toISOString(),
  };
}

const SESSION_OWNER = {
  sessionId: 'sess-1',
  userId: USER,
  messages: [],
  portalType: 'customer',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function makeRes(): jest.Mocked<Response> {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
  return res;
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    user: { userId: USER },
    params: { sessionId: 'sess-1' },
    query: {},
    body: { message: 'Hello Emma' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

describe('ENG-1816 F1 — sendMessage resolves and enters a RunFunding scope', () => {
  let seen: (RunFunding | undefined)[];

  beforeEach(() => {
    jest.clearAllMocks();
    seen = [];
    mockChatbotDb.getChatSession.mockResolvedValue(SESSION_OWNER as any);
    mockResolveRunFunding.mockResolvedValue(makeFunding());
    mockGenerateChatResponse.mockImplementation(async () => {
      seen.push(currentRunFunding());
      return 'a real response';
    });
  });

  it('resolves RunFunding for a real authenticated caller and runs generateChatResponse inside it', async () => {
    const req = makeReq();
    const res = makeRes();

    await sendMessage(req, res);

    expect(mockResolveRunFunding).toHaveBeenCalledWith({ userId: USER });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ownerUserId).toBe(USER);
    expect(currentRunFunding()).toBeUndefined(); // no leakage past the request
  });

  it('does not resolve RunFunding for an anonymous caller — matches pre-fix behavior exactly', async () => {
    const req = makeReq({ user: undefined as any });
    mockChatbotDb.getChatSession.mockResolvedValue({ ...SESSION_OWNER, userId: undefined } as any);
    const res = makeRes();

    await sendMessage(req, res);

    expect(mockResolveRunFunding).not.toHaveBeenCalled();
    expect(seen).toEqual([undefined]);
  });
});

describe('ENG-1816 F1 — sendMessageStream resolves and enters a RunFunding scope', () => {
  let seen: (RunFunding | undefined)[];

  beforeEach(() => {
    jest.clearAllMocks();
    seen = [];
    mockChatbotDb.getChatSession
      .mockResolvedValueOnce(SESSION_OWNER as any)
      .mockResolvedValueOnce(SESSION_OWNER as any);
    mockResolveRunFunding.mockResolvedValue(makeFunding());
    mockGenerateChatResponse.mockImplementation(async () => {
      seen.push(currentRunFunding());
      return 'a real response';
    });
  });

  it('resolves RunFunding and streams the response from inside that scope', async () => {
    const req = makeReq();
    const res = makeRes();

    await sendMessageStream(req, res);

    expect(mockResolveRunFunding).toHaveBeenCalledWith({ userId: USER });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ownerUserId).toBe(USER);
    expect(currentRunFunding()).toBeUndefined();
  });
});

describe('ENG-669 PR-C: the sidebar chatbot refuses the AgentWeb Model visibly', () => {
  it.each([['sendMessage', sendMessage], ['sendMessageStream', sendMessageStream]] as const)('%s: 422 before any session read or LLM call', async (_name, handler) => {
    mockChatbotDb.getChatSession.mockResolvedValue(SESSION_OWNER as any);
    const res = makeRes();
    await handler(makeReq({ body: { message: 'Hello Emma', model: 'agentweb-model' } } as any), res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_unavailable', requestedModel: 'agentweb-model', reason: 'not_selectable' }));
    expect(mockGenerateChatResponse).not.toHaveBeenCalled();
  });
});
