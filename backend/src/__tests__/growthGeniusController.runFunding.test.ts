/**
 * ENG-1816 F1 — growthGeniusController.sendMessage is a real live chat product
 * (POST /api/growth-genius/sessions/:sessionId/messages), architecturally
 * identical to the already-fixed Emma sidebar assistant, whose 3 callLLM sites
 * (title generation, initial turn, tool-follow-up turn) never entered any
 * RunFunding scope before this fix.
 *
 * Found by a round-4 PR review, fixed by wrapping generateSessionTitle and
 * generateResponse in withRunFunding(await resolveRunFunding(...), ...) at the
 * controller — but that fix was only ever verified by manual code trace (round
 * 5), never by anything that actually executes it. This test does.
 */

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/growthGeniusService', () => ({
  growthGeniusService: {
    generateSessionTitle: jest.fn(),
    generateResponse: jest.fn(),
  },
}));

jest.mock('../services/funding/runFunding', () => {
  const actual = jest.requireActual('../services/funding/runFunding');
  return { ...actual, resolveRunFunding: jest.fn() };
});

import { growthGeniusController } from '../controllers/growthGeniusController';
import { chatbotDb } from '../services/chatbotService';
import { growthGeniusService } from '../services/growthGeniusService';
import { currentRunFunding, resolveRunFunding, type RunFunding } from '../services/funding/runFunding';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockGrowthGeniusService = growthGeniusService as jest.Mocked<typeof growthGeniusService>;
const mockResolveRunFunding = resolveRunFunding as jest.MockedFunction<typeof resolveRunFunding>;

const USER = 'user-growth-1816';

function makeFunding(): RunFunding {
  return {
    route: 'agentweb',
    fallback: 'agentweb',
    ownerUserId: USER,
    billingUserId: USER,
    resolvedAt: new Date().toISOString(),
  };
}

function fakeReqRes(content = 'How do I grow revenue?') {
  const req: any = {
    user: { userId: USER },
    params: { sessionId: 'session-1' },
    body: { content },
  };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

describe('ENG-1816 F1 — growthGeniusController.sendMessage RunFunding wiring', () => {
  let seenDuringTitle: (RunFunding | undefined)[];
  let seenDuringResponse: (RunFunding | undefined)[];

  beforeEach(() => {
    jest.clearAllMocks();
    seenDuringTitle = [];
    seenDuringResponse = [];

    mockChatbotDb.getChatSession.mockResolvedValue({
      userId: USER,
      portalType: 'genius',
      messages: [], // empty -> isFirstMessage=true, exercises BOTH callLLM sites
      selectedStartupId: undefined,
    } as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);

    mockGrowthGeniusService.generateSessionTitle.mockImplementation(async () => {
      seenDuringTitle.push(currentRunFunding());
      return 'A Title';
    });
    mockGrowthGeniusService.generateResponse.mockImplementation(async () => {
      seenDuringResponse.push(currentRunFunding());
      return { content: 'answer', knowledgeBaseQueries: [], sources: [] } as any;
    });

    mockResolveRunFunding.mockResolvedValue(makeFunding());
  });

  it('resolves RunFunding once and wraps both the title and response calls in it', async () => {
    const { req, res } = fakeReqRes();

    await growthGeniusController.sendMessage(req, res);

    expect(mockResolveRunFunding).toHaveBeenCalledTimes(1);
    expect(mockResolveRunFunding).toHaveBeenCalledWith({ userId: USER });

    expect(seenDuringTitle).toHaveLength(1);
    expect(seenDuringTitle[0]?.ownerUserId).toBe(USER);
    expect(seenDuringResponse).toHaveLength(1);
    expect(seenDuringResponse[0]?.ownerUserId).toBe(USER);

    // Both calls share the exact same resolved funding, not two separate resolves.
    expect(seenDuringResponse[0]).toBe(seenDuringTitle[0]);

    // No leakage past the request.
    expect(currentRunFunding()).toBeUndefined();
  });

  it('still wraps generateResponse in RunFunding when it is not the first message', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      userId: USER,
      portalType: 'genius',
      messages: [{ role: 'user', content: 'prior message', metadata: { timestamp: new Date().toISOString() } }],
      selectedStartupId: undefined,
    } as any);
    const { req, res } = fakeReqRes();

    await growthGeniusController.sendMessage(req, res);

    expect(mockGrowthGeniusService.generateSessionTitle).not.toHaveBeenCalled();
    expect(seenDuringResponse).toHaveLength(1);
    expect(seenDuringResponse[0]?.ownerUserId).toBe(USER);
  });
});
