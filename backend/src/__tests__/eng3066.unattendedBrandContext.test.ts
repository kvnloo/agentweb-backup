import { AgentModeService } from '../services/agentModeService';
import { BRAND_MESSAGING_CONTEXT_MAX_CHARS, unattendedBrandContextMessage } from '../services/brandMessagingContext';

/**
 * ENG-3066 — an unattended scheduled run has the compact brand block in context before the model
 * writes anything, without a read_brand_guidelines tool call. Harness mirrors
 * agentModeService.publishDirectiveDelivery.test.ts: capture what the FIRST model call is sent.
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
const SESSION = {
  sessionId: 'sess-1',
  sessionType: 'scheduled',
  pageIdentifier: `Scheduled: Weekly outreach|scheduleId:${SCHEDULE_ID}`,
  publishAdmission: { authorized: false, tools: [], recordedAt: 'x' },
  messages: [],
  associatedSkills: null,
};
const SCHEDULE = { scheduleId: SCHEDULE_ID, requiredFunctionCalls: [], autopublishAuthorized: false, autopublishAuthorizedTools: [] };
const BRAND = {
  brandData: {
    brandName: 'Northwind Solar',
    tagline: 'Rooftop solar for warehouses',
    valueProposition: 'Cuts warehouse power bills with no upfront cost.',
    keyMessages: ['Installed in 30 days'],
    toneOfVoice: 'Plain and direct',
    primaryColor: '#ff6600',
  },
};
const MARKER = 'SENDER BRAND CONTEXT';

async function firstCall(opts: { user?: any; org?: any; getUserById?: jest.Mock; isUnattendedRun?: boolean | undefined } = {}) {
  const service = new AgentModeService();
  const chatbot = require('../services/chatbotService');
  chatbot.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(SESSION),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };
  require('../services/settingsService').settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
  const db = require('../services/db');
  db.userDb = { getUserById: opts.getUserById ?? jest.fn().mockResolvedValue(opts.user ?? { userId: 'test-user', isAdmin: false }) };
  db.orgDb = { getOrgById: jest.fn().mockResolvedValue(opts.org ?? null) };
  db.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
  db.scheduleDb = { getScheduleById: jest.fn().mockResolvedValue(SCHEDULE) };

  let sent: any[] = [];
  const readSpy = jest.spyOn(service, 'readBrandGuidelines');
  jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
    if (!sent.length) sent = (args[1] as any[]).map((m) => ({ role: m.role, content: m.content }));
    return {
      choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  });

  await service.generateMarketingResponse(
    'Write this week\'s outreach emails.',
    [{ role: 'user', content: 'Write this week\'s outreach emails.' }] as any,
    'test-user',
    service.default_model,
    'sess-1',
    false, undefined, undefined, false, undefined, undefined, undefined, false, false,
    undefined, undefined, undefined, false,
    'isUnattendedRun' in opts ? opts.isUnattendedRun : true,
  );
  const brand = sent.filter((m) => typeof m.content === 'string' && m.content.includes(MARKER));
  return { sent, brand, readSpy };
}

describe('ENG-3066 — unattended scheduled runs get the compact brand block', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('puts the block in the first model call with no tool call made, before the final directive', async () => {
    const { sent, brand } = await firstCall({ user: { userId: 'test-user', isAdmin: false, brandGuidelines: BRAND } });

    expect(brand).toHaveLength(1);
    expect(brand[0].role).toBe('system');
    expect(brand[0].content).toContain('Brand: Northwind Solar');
    expect(brand[0].content).toContain('Value proposition: Cuts warehouse power bills with no upfront cost.');
    // Messaging fields only: the compact formatter drops colors.
    expect(brand[0].content).not.toContain('#ff6600');
    // This is the first model call of the run: the model has produced nothing yet, so no tool
    // (read_brand_guidelines included) has been called and no tool result is in context.
    expect(sent.some((m) => m.role === 'tool' || m.role === 'assistant')).toBe(false);

    const brandIdx = sent.indexOf(brand[0]);
    expect(brandIdx).toBeGreaterThan(sent.map((m) => m.role).lastIndexOf('user'));
    // ENG-827: the publish decision stays the last thing the model reads.
    expect(brandIdx).toBe(sent.length - 2);
    expect(sent[sent.length - 1].content).toContain('NOT pre-authorized to publish');
  });

  it('adds nothing and does not fail when the account has no brand guidelines', async () => {
    const { sent, brand } = await firstCall();
    expect(sent.length).toBeGreaterThan(0);
    expect(brand).toHaveLength(0);
  });

  it('adds nothing when the guidelines hold no messaging fields', async () => {
    const { brand } = await firstCall({ user: { userId: 'test-user', isAdmin: false, brandGuidelines: { brandData: { primaryColor: '#ff6600' } } } });
    expect(brand).toHaveLength(0);
  });

  it('uses the org brand guidelines for an org member', async () => {
    const { brand } = await firstCall({
      user: { userId: 'test-user', isAdmin: false, orgId: 'org-1', brandGuidelines: { brandData: { brandName: 'Personal Leftover' } } },
      org: { orgId: 'org-1', brandGuidelines: BRAND },
    });
    expect(brand).toHaveLength(1);
    expect(brand[0].content).toContain('Brand: Northwind Solar');
    expect(brand[0].content).not.toContain('Personal Leftover');
  });

  it('leaves an attended reopen of a scheduled session without the block and without the read', async () => {
    const { sent, brand, readSpy } = await firstCall({
      user: { userId: 'test-user', isAdmin: false, brandGuidelines: BRAND },
      isUnattendedRun: undefined,
    });
    expect(sent.length).toBeGreaterThan(0);
    expect(brand).toHaveLength(0);
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe('unattendedBrandContextMessage', () => {
  it('returns an empty string when the brand read throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(unattendedBrandContextMessage(async () => { throw new Error('dynamo down'); })).resolves.toBe('');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns an empty string for a not-found or failed read result', async () => {
    await expect(unattendedBrandContextMessage(async () => ({ success: false, exists: false }))).resolves.toBe('');
    await expect(unattendedBrandContextMessage(async () => null)).resolves.toBe('');
  });

  it('stays within the compact cap plus its fixed lead-in', async () => {
    const long = 'x'.repeat(5000);
    const message = await unattendedBrandContextMessage(async () => ({
      exists: true,
      brandData: { brandName: long, tagline: long, valueProposition: long, keyMessages: [long, long], toneOfVoice: long },
    }));
    const leadIn = message.slice(0, message.indexOf('\n') + 1);
    expect(leadIn.length).toBeLessThan(320);
    expect(message.length - leadIn.length).toBeLessThanOrEqual(BRAND_MESSAGING_CONTEXT_MAX_CHARS);
  });
});
