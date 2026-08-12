import { AgentModeService } from '../services/agentModeService';

/**
 * ENG-827 — the publish directive has to REACH THE MODEL, and reach it last.
 *
 * Two separate defects, both observed on a live preview run of the reported
 * scenario, both invisible to every unit test that asserted the directive's TEXT:
 *
 *  1. DELIVERY. The directive was appended to the system prompt the controller
 *     stores as the session's first message. `buildMarketingContext` slices that
 *     message off (`startIdx = 1`), so the model never received it. The prompt was
 *     correct, complete, and unread.
 *
 *  2. POSITION. Delivery alone is not enough. The base system prompt already carried
 *     an equivalent authorization block ~70k characters up, and an authorized run
 *     still opened with "Should I post this to X?" and only published after three
 *     required-function nudges — losing to the publishing tools' own "get explicit
 *     approval first" instruction. Appended after the conversation it is the last
 *     thing the model reads before answering.
 *
 * So these tests assert POSITION and DELIVERY, not wording. `getUnattendedExecutionDirective`'s
 * text is covered in agentModeService.scheduledSessionContext.test.ts; asserting it
 * again here would have passed throughout the period the model was receiving nothing.
 */

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const SCHEDULE_ID = '1c20ada1-0000-4000-8000-000000000001';

/** A scheduled session admitted with publishing rights, as runScheduledChat stamps it. */
const ADMITTED_SESSION = {
  sessionId: 'sess-1',
  sessionType: 'scheduled',
  pageIdentifier: `Scheduled: Kevin — Daily LinkedIn Post|scheduleId:${SCHEDULE_ID}`,
  publishAdmission: { authorized: true, tools: ['post_on_connected_account'], recordedAt: 'x' },
  messages: [],
  associatedSkills: null,
};

function mockDeps(session: any, schedule: any) {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(session),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };

  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
  mockDb.scheduleDb = { getScheduleById: jest.fn().mockResolvedValue(schedule) };
}

function makeLLMResponse(text = 'Done.') {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

async function capture(session: any, schedule: any) {
  const service = new AgentModeService();
  mockDeps(session, schedule);

  // Snapshot at CALL time. The service keeps appending to the same array after the
  // call returns (the assistant reply lands in it), so reading the spy's stored
  // reference afterwards inspects a mutated array, not what the model was sent.
  let sent: any[] = [];
  jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
    if (!sent.length) sent = (args[1] as any[]).map(m => ({ role: m.role, content: m.content }));
    return makeLLMResponse();
  });

  await service.generateMarketingResponse(
    'Draft and post today\'s update.',
    [{ role: 'user', content: 'Draft and post today\'s update.' }] as any,
    'test-user',
    service.default_model,
    'sess-1'
  );

  return sent;
}

describe('ENG-827 — the unattended publish directive is delivered, and delivered last', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AUTHORIZED: appends the publish decision as the FINAL message', async () => {
    const messages = await capture(ADMITTED_SESSION, {
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account'],
    });

    const last = messages[messages.length - 1];
    expect(last.role).toBe('system');
    expect(last.content).toContain('PRE-AUTHORIZED to publish');

    // POSITION, stated as an invariant rather than an index: the decision must come
    // after the conversation, not be buried in the opening prompt. This is the
    // assertion that fails if the block is moved back into the base system prompt.
    const decisionIdx = messages.findIndex(
      (m: any) => typeof m.content === 'string' && m.content.includes('PRE-AUTHORIZED to publish')
    );
    const lastUserIdx = messages.map((m: any) => m.role).lastIndexOf('user');
    expect(lastUserIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeGreaterThan(lastUserIdx);
  });

  // Consent is bound to the tools it was granted for, so a grant recorded with no
  // approved tool has unknown scope and authorizes nothing. The directive must say so
  // rather than emit an unscoped licence to reach for any publishing tool.
  it('WITHHELD when consent names no approved publish tool', async () => {
    const messages = await capture(
      { ...ADMITTED_SESSION, publishAdmission: { authorized: true, tools: [], recordedAt: 'x' } },
      {
        scheduleId: SCHEDULE_ID,
        requiredFunctionCalls: ['you_search_web'],
        autopublishAuthorized: true,
        autopublishAuthorizedTools: [],
      }
    );

    expect(messages[messages.length - 1].content).toContain('NOT pre-authorized to publish');
  });

  it('AUTHORIZED names the exact tools the owner approved', async () => {
    const messages = await capture(ADMITTED_SESSION, {
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account'],
    });
    const last = messages[messages.length - 1];
    expect(last.content).toContain('PRE-AUTHORIZED to publish');
    expect(last.content).toContain('covers ONLY post_on_connected_account');
  });

  it('WITHHELD: says so, on the same delivered path', async () => {
    const messages = await capture(ADMITTED_SESSION, {
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
      // An explicit revocation. Absence of the field is NOT this state — see the
      // legacy test below.
      autopublishAuthorized: false,
    });

    const last = messages[messages.length - 1];
    expect(last.role).toBe('system');
    expect(last.content).toContain('NOT pre-authorized to publish');
    expect(last.content).not.toContain('PRE-AUTHORIZED to publish');
  });

  // The polarity deferral: a schedule created before consent was recordable carries
  // no field at all, which is a question nobody was asked rather than a refusal. It
  // keeps publishing under ENG-803's shipped opt-out, scoped to the publish tools the
  // schedule already designates. Reading absence as "withheld" here would have stopped
  // every one of the ~900 legacy rows on deploy — the exact failure this ticket is about.
  it('AUTHORIZED for a legacy schedule that was never asked, scoped to its own publish tool', async () => {
    const messages = await capture(ADMITTED_SESSION, {
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
      // no consent field — this row predates the flag
    });

    const last = messages[messages.length - 1];
    expect(last.content).toContain('PRE-AUTHORIZED to publish');
    expect(last.content).toContain('covers ONLY post_on_connected_account');
  });

  it('WITHHELD: a run admitted draft-only cannot be widened by a mid-run grant', async () => {
    // The schedule now authorizes, but this run started without the stamp. The
    // directive must agree with the dispatch guard, which refuses on the same basis.
    const messages = await capture(
      { ...ADMITTED_SESSION, publishAdmission: undefined },
      {
        scheduleId: SCHEDULE_ID,
        requiredFunctionCalls: ['post_on_connected_account'],
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['post_on_connected_account'],
      }
    );

    expect(messages[messages.length - 1].content).toContain('NOT pre-authorized to publish');
  });

  it('says nothing about publishing in a non-scheduled session', async () => {
    const messages = await capture(
      { sessionId: 'sess-2', sessionType: 'agent', messages: [], associatedSkills: null },
      { scheduleId: SCHEDULE_ID }
    );

    const anyPublishBlock = messages.some(
      (m: any) => typeof m.content === 'string' && m.content.includes('pre-authorized to publish')
    );
    expect(anyPublishBlock).toBe(false);
  });
});
