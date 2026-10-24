/**
 * ENG-2113 PR C0: golden test for the turn preamble of generateMarketingResponse.
 *
 * C0 moves the preamble (everything from the first data fetch to the anti-loop directive) into prepareTurnContext() so the
 * Claude Code backend can build the identical context. The move must change nothing Emma's own loop sends to the model. This
 * test drives the whole method with a mocked LLM and records, per fixture, what the first model call received: every message
 * (role, length, sha256, and the text itself when short) and the names of the tools offered. The recording was made on the code
 * BEFORE the move and committed; the test fails on any byte of difference.
 *
 * Re-record (only when a prompt change is intended, never in a pure refactor): UPDATE_GOLDEN=1 npx jest <this file>
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { AgentModeService } from '../services/agentModeService';

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(),
    getSkillsByIds: jest.fn(),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn(),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const GOLDEN_PATH = join(__dirname, '__golden__', 'prepareTurnContext.golden.json');
const FROZEN_NOW = new Date('2026-10-25T12:00:00.000Z');
const SCHEDULE_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';

const memory = (id: string, content: string, createdAt: string) => ({ memoryId: id, category: 'insight', content, createdAt, embedding: [] });
const skill = (id: string) => ({ skillId: id, name: `Skill ${id}`, description: `Does ${id}`, toolNames: ['read_brand_guidelines'], instructions: `Use ${id}.` });

interface Fixture {
  name: string;
  message: string;
  history: any[];
  session: Record<string, any> | null;
  user?: Record<string, any> | null;
  memories?: any[];
  orgMemories?: any[];
  org?: Record<string, any> | null;
  published?: any[];
  installed?: any[];
  allowedSkills?: string[] | null;
  schedule?: Record<string, any> | null;
  args?: { isInteractiveShare?: boolean; isDelegatedAccess?: boolean; screenshotUrl?: string; isUnattendedRun?: boolean; publishOverride?: any };
}

const turn = (role: 'user' | 'assistant', content: string, timestamp: string) => ({ role, content, timestamp });

const FIXTURES: Fixture[] = [
  { name: 'plain first turn', message: 'Hello', history: [], session: { sessionId: 'golden', messages: [], associatedSkills: null } },
  {
    name: 'legacy session with history and memory',
    message: 'What did we decide about pricing?',
    history: [turn('user', 'Draft a pricing page', '2026-10-25T10:00:00.000Z'), turn('assistant', 'Here is a draft.', '2026-10-25T10:01:00.000Z')],
    session: { sessionId: 'golden', messages: [], associatedSkills: null },
    memories: [memory('m1', 'Prefers a short tone', '2026-10-01T00:00:00.000Z'), memory('m2', 'ICP is B2B SaaS', '2026-09-20T00:00:00.000Z')],
  },
  {
    name: 'org member with account and org memory',
    message: 'Summarise our pipeline',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
    user: { userId: 'golden-user', isAdmin: false, memoryEnabled: true, orgId: 'org-1' },
    org: { orgId: 'org-1', name: 'Acme Co', orgMemoryEnabled: true },
    memories: [memory('m1', 'Likes tables', '2026-10-02T00:00:00.000Z')],
    orgMemories: [memory('o1', 'Q3 pipeline $1.2M', '2026-10-03T00:00:00.000Z')],
  },
  {
    name: 'memory disabled for the account',
    message: 'Hi',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
    user: { userId: 'golden-user', isAdmin: false, memoryEnabled: false, orgId: null },
    memories: [memory('m1', 'Should not appear', '2026-10-02T00:00:00.000Z')],
  },
  {
    name: 'memory over the injection limit falls back to recency',
    message: 'Tell me about cats',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
    memories: Array.from({ length: 25 }, (_, i) => memory(`m${i}`, `Note number ${i}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString())),
  },
  {
    name: 'slack session gets the team roster',
    message: 'Who is the CMO?',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [], pageIdentifier: 'slack|C123' },
  },
  {
    name: 'voice card appended to the message',
    message: 'Write a post',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [], sessionVoiceProfile: { voiceCard: 'Warm, plain, no jargon.' } },
  },
  {
    name: 'admin user, installed skill and a published skill',
    message: 'Use my skill',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: ['s1'] },
    user: { userId: 'golden-user', isAdmin: true, memoryEnabled: true, orgId: null },
    installed: [skill('s1')],
    published: [skill('s1'), skill('s2')],
    allowedSkills: ['s1', 's2'],
  },
  {
    name: 'allowed skills unresolved (fails closed)',
    message: 'Hello',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: ['s1'] },
    installed: [skill('s1')],
    published: [skill('s1')],
    allowedSkills: null,
  },
  {
    name: 'delegated admin access on a non-admin account',
    message: 'Check the account',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
    args: { isDelegatedAccess: true },
  },
  {
    name: 'interactive share blocks admin access',
    message: 'Check the account',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
    user: { userId: 'golden-user', isAdmin: true, memoryEnabled: true, orgId: null },
    args: { isInteractiveShare: true },
  },
  {
    name: 'user not found (orphaned)',
    message: 'Hello',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
    user: null,
  },
  {
    name: 'no session row',
    message: 'Hello',
    history: [],
    session: null,
  },
  {
    name: 'loop breaker fires on the third identical message',
    message: 'just do it',
    history: [turn('user', 'just do it', '2026-10-25T11:00:00.000Z'), turn('assistant', 'Which site?', '2026-10-25T11:00:30.000Z'), turn('user', 'just do it', '2026-10-25T11:01:00.000Z'), turn('assistant', 'Which site?', '2026-10-25T11:01:30.000Z'), turn('user', 'just do it', '2026-10-25T11:02:00.000Z')],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
  },
  {
    name: 'loop breaker suppressed for a verification press',
    message: 'Please try again. Make sure to post_on_connected_account (1 more time needed)',
    history: [
      turn('user', 'Please try again. Make sure to post_on_connected_account (1 more time needed)', '2026-10-25T11:00:00.000Z'),
      turn('user', 'Please try again. Make sure to post_on_connected_account (1 more time needed)', '2026-10-25T11:01:00.000Z'),
      turn('user', 'Please try again. Make sure to post_on_connected_account (1 more time needed)', '2026-10-25T11:02:00.000Z'),
    ],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
  },
  {
    name: 'slow human pace (long pause in history)',
    message: 'Back again',
    history: [turn('user', 'First', '2026-10-25T08:00:00.000Z'), turn('assistant', 'Reply', '2026-10-25T08:00:10.000Z'), turn('user', 'Second', '2026-10-25T09:30:00.000Z')],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
  },
  {
    name: 'scheduled unattended run, publish authorized',
    message: 'Run the weekly report',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [], sessionType: 'scheduled', pageIdentifier: `agent|scheduled|scheduleId:${SCHEDULE_ID}` },
    args: { isUnattendedRun: true, publishOverride: { authorized: true, tools: ['post_on_connected_account'] } },
    schedule: { scheduleId: SCHEDULE_ID },
  },
  {
    name: 'scheduled unattended run, publish withheld',
    message: 'Run the weekly report',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [], sessionType: 'scheduled', pageIdentifier: `agent|scheduled|scheduleId:${SCHEDULE_ID}` },
    args: { isUnattendedRun: true, publishOverride: { authorized: false, tools: [] } },
    schedule: { scheduleId: SCHEDULE_ID, requirePublishApproval: true, slackSendRequiresApproval: true },
  },
  {
    name: 'scheduled session reopened attended',
    message: 'Show me the last run',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [], sessionType: 'scheduled', pageIdentifier: `agent|scheduled|scheduleId:${SCHEDULE_ID}` },
    schedule: { scheduleId: SCHEDULE_ID },
  },
  {
    name: 'screenshot attached',
    message: 'What is wrong with this page?',
    history: [],
    session: { sessionId: 'golden', messages: [], associatedSkills: [] },
    args: { screenshotUrl: 'https://example.com/shot.png' },
  },
];

function setup(f: Fixture) {
  const chatbot = require('../services/chatbotService');
  chatbot.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(f.session),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    updateChatSession: jest.fn().mockResolvedValue(undefined),
  };
  require('../services/settingsService').settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
  const db = require('../services/db');
  db.userDb = {
    getUserById: jest.fn().mockResolvedValue(
      f.user === undefined ? { userId: 'golden-user', isAdmin: false, memoryEnabled: true, orgId: null } : f.user,
    ),
  };
  db.accountMemoryDb = { getUserMemories: jest.fn().mockResolvedValue(f.memories ?? []), setMemoryEmbedding: jest.fn().mockResolvedValue(undefined) };
  db.orgMemoryDb = { getOrgMemories: jest.fn().mockResolvedValue(f.orgMemories ?? []), setMemoryEmbedding: jest.fn().mockResolvedValue(undefined) };
  db.orgDb = { getOrgById: jest.fn().mockResolvedValue(f.org ?? null) };
  db.scheduleDb = { getScheduleById: jest.fn().mockResolvedValue(f.schedule ?? null) };
  const skills = require('../services/skillService').skillService;
  skills.getPublishedSkills.mockResolvedValue(f.published ?? []);
  skills.getSkillsByIds.mockResolvedValue(f.installed ?? []);
  require('../services/subscriptionService').getAllowedSkills.mockResolvedValue(f.allowedSkills === undefined ? ['*'] : f.allowedSkills);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function describeMessages(messages: any[]) {
  return messages.map((m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return { role: m.role, length: text.length, sha256: sha(text), ...(text.length <= 3000 ? { text } : {}) };
  });
}

function describeOptions(options: any) {
  if (!options) return null;
  const { tools, ...rest } = options;
  const names = Array.isArray(tools) ? tools.map((t: any) => t?.function?.name ?? t?.name ?? '?').sort() : null;
  return { tools: names, rest: JSON.parse(JSON.stringify(rest)) };
}

async function record(f: Fixture) {
  setup(f);
  const svc = new AgentModeService();
  // Snapshot at call time: the loop keeps appending to the same array after the call returns.
  let first: { messages: any[]; options: any } | undefined;
  // The tool list is built from preamble outputs (allowed tool names, legacy flag, loop breaker, entitlement), so record what
  // the filter was asked for and hand back a fixed catalogue in which the loop breaker's install_skills strip is visible.
  const filterCalls: any[] = [];
  const catalogue = ['install_skills', 'read_brand_guidelines', 'read_market_strategy', 'post_on_connected_account'].map((name) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
  }));
  jest.spyOn(svc as any, 'getFilteredTools').mockImplementation(async (...args: any[]) => {
    filterCalls.push(JSON.parse(JSON.stringify(args, (_k, v) => (v instanceof Set ? ['Set', ...[...v].sort()] : v))));
    return catalogue;
  });
  const spy = jest.spyOn(svc as any, 'callLLM').mockImplementation(async (...args: any[]) => {
    first ??= { messages: describeMessages(args[1]), options: describeOptions(args[2]) };
    return {
      choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  });
  const a = f.args ?? {};
  await svc.generateMarketingResponse(
    f.message,
    f.history as any,
    'golden-user',
    svc.default_model,
    'golden',
    false,
    undefined,
    undefined,
    a.isInteractiveShare ?? false,
    undefined,
    undefined,
    a.screenshotUrl,
    a.isDelegatedAccess ?? false,
    false,
    undefined,
    a.publishOverride,
    undefined,
    false,
    a.isUnattendedRun,
  );
  expect(spy).toHaveBeenCalled();
  return { ...first!, filterCalls };
}

describe('generateMarketingResponse turn preamble — golden (ENG-2113 PR C0)', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: FROZEN_NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'performance', 'hrtime'],
    });
  });
  afterAll(() => jest.useRealTimers());
  beforeEach(() => jest.clearAllMocks());

  const recorded: Record<string, unknown> = {};
  const golden: Record<string, unknown> = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {};

  for (const f of FIXTURES) {
    it(f.name, async () => {
      const got = await record(f);
      recorded[f.name] = got;
      if (process.env.UPDATE_GOLDEN) return;
      expect(golden[f.name]).toBeDefined();
      expect(got).toEqual(golden[f.name]);
    });
  }

  afterAll(() => {
    if (!process.env.UPDATE_GOLDEN) return;
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, JSON.stringify(recorded, null, 2) + '\n');
  });

  it('every fixture is recorded and nothing stale is left in the golden file', () => {
    if (process.env.UPDATE_GOLDEN) return;
    expect(Object.keys(golden).sort()).toEqual(FIXTURES.map((f) => f.name).sort());
  });
});
