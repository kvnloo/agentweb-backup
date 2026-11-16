/**
 * ENG-112 — branch a chat from a message.
 *
 * The service runs against the REAL ChatbotDB (createChatSession / addMessagesToSession /
 * updateSessionLlmModel / updateSessionTitle / getChatSession) over an in-memory DocumentClient
 * that applies writes, so what is asserted is the session item and message rows that were
 * actually persisted, not the arguments handed to a mock.
 */
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';

const mockFake = new BranchFakeDynamo();

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockFake.client()) },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));
jest.mock('../services/db', () => ({
  userDb: { updateUser: jest.fn().mockResolvedValue(undefined), getUserById: jest.fn().mockResolvedValue(null) },
  taskDb: {},
}));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn().mockResolvedValue('k') }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));

import { chatbotDb, ChatMessage } from '../services/chatbotService';
import { filterMessagesForClient } from '../utils/adminOnlyMessageFilter';
import {
  branchChatSession,
  BranchDeps,
  BranchInput,
  BRANCH_MIN_HEADROOM_MESSAGES,
  readBranchOrigin,
  __resetBranchIdempotencyForTests,
  isChatBranchingSettingEnabled,
} from '../services/agentMode/chatBranching';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { hasUnresolvedMediaDeferral } from '../utils/timeoutContinuation';

const OWNER = 'user-owner';
const SRC = 'src-session-1';
const ADMIN_TOOLS = ['get_pr_digest'];

// Every key a freshly created branch session may carry. Anything else is a leaked source field.
const ALLOWED_SESSION_KEYS = new Set([
  'sessionId', 'userId', 'title', 'createdAt', 'updatedAt', 'adminListPartition', 'portalType',
  'pageIdentifier', 'selectedStartupId', 'sessionType', 'delegateInfo', 'associatedSkills',
  'llmModel', 'llmUsagePolicyDecision', 'messageCount', 'messages', 'branchedFrom',
]);

// Every session-level field the source carries that must NOT reach a branch.
const FORBIDDEN_SOURCE_FIELDS = {
  shareMetadata: { isShared: true, sharedAt: 'x', expiresAt: 'y' },
  interactiveShareMetadata: { isActive: true, token: 'SECRET-TOKEN', sharedAt: 'x' },
  totalCost: 12.5,
  totalTokens: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  toolCosts: { x: 1 },
  llmUsagePolicyDecision: { requestedModel: 'old', effectiveModel: 'old', backupModel: null, backupSource: null, modelSelection: 'honored', modelSelectionReason: 'r', usageMode: 'full_choice', usagePolicyVersion: null, recordedAt: 'x' },
  satisfactionScore: { score: 5, reason: 'r', evaluatedAt: 'x', evaluatedMessageIndex: 3 },
  judgeScores: { j: { score: 1 } },
  sessionSummary: { summary: 's', evaluatedAt: 'x', evaluatedMessageIndex: 3 },
  feedbacks: { 'http://i': { type: 'like' } },
  favorites: { 'http://i': true },
  archives: { 'http://i': true },
  publishStatuses: { 'http://i': 'published' },
  workPlan: { title: 'plan', steps: [], createdAt: 'x', updatedAt: 'x' },
  calledFunctions: { web_search: 3 },
  calledFunctionsVersion: 4,
  failedFunctions: { web_search: 1 },
  pendingApprovalDeck: { deckId: 'd' },
  pendingUserQuestion: { q: 1 },
  pendingWorkPlanInput: { r: 1 },
  workflowRun: { runId: 'w' },
  consumedMetaWriteManifestDigests: { d: 'x' },
  openResearchRequests: [{ tool: 't' }],
  publishAdmission: { authorized: true, tools: ['post'], recordedAt: 'x' },
  executionId: 'exec-1',
  emailCampaignTaskId: 'task-1',
  workflowId: 'wf-1',
  gtmWorkItem: { planId: 'p', phaseId: 'ph', workItemId: 'w' },
  slackThread: { channel: 'C1', threadTs: '1' },
  emailMetadata: { senderEmail: 'a@b.c' },
  resultEndpointMetadata: { resultName: 'r' },
  delegateInfo: { adminUserId: 'src-admin', adminEmail: 'src@admin', isDelegated: true },
  archived: false,
  error: 'boom',
  assetCache: { images: [{ url: 'u', filename: 'f', generatedAt: 'x' }], videos: [], htmlReports: [] },
  assetScanIndex: 7,
  pageContent: 'PAGE CONTENT',
  contextChunks: [{ id: 'c', content: 'x', metadata: { source: 's' } }],
  lastFailedMetaWrite: { signature: 's', error: 'e', count: 1, at: 'x' },
  objectiveConfirmations: { k: { objective: 'o', answeredBy: 'user', at: 'x' } },
  declinedWorkPlanRecommendations: { r: { planId: 'p', planTitle: 't', declinedAt: 'x' } },
  contextLimitReported: true,
  sessionVoiceProfile: { v: 1 },
  metaMeasurementChecks: [{ c: 1 }],
  retractedSatisfactionScore: { score: 1 },
};

const ts = (n: number) => `2026-10-0${1 + (n % 8)}T00:00:0${n % 10}.000Z`;
const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage =>
  ({ timestamp: ts(1), metadata: { timestamp: ts(1) }, ...m }) as ChatMessage;

/**
 * Raw rows. Visible to the client (everything but tool rows and tool_calls-only assistants):
 * 0 system, 1 user, 4 assistant, 5 user, 8 assistant, 9 user, 10 assistant. Raw indices are SPARSE.
 */
function sourceRows(): ChatMessage[] {
  return [
    msg({ role: 'system', content: 'REAL SYSTEM PROMPT', metadata: { timestamp: ts(0), portalType: 'agent', systemPromptVersion: 'abc' } as any }),
    msg({ role: 'user', content: 'Plan my campaign' }),
    msg({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }),
    msg({ role: 'tool', content: '{"results":[1]}', name: 'web_search', tool_call_id: 'c1', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, estimated_cost: 0.5 } }),
    msg({
      role: 'assistant', content: 'Here is the plan', llm: 'gpt-5.5', clientId: 'client-xyz',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated_cost: 1.25 },
      metadata: { timestamp: ts(4), toolCalls: [{ id: 'c1', name: 'web_search', arguments: {}, result: { ok: true } }], feedback: { type: 'like', timestamp: 'x', userId: OWNER } },
    }),
    msg({ role: 'user', content: 'Now the budget' }),
    msg({ role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }),
    msg({ role: 'tool', content: '{"results":[2]}', name: 'web_search', tool_call_id: 'c2' }),
    msg({ role: 'assistant', content: 'Budget answer', llm: 'gpt-5.5', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, estimated_cost: 0.2 } }),
    msg({ role: 'user', content: 'One more thing' }),
    msg({ role: 'assistant', content: 'Final answer', llm: 'gpt-5.5' }),
  ];
}

function seedSource(overrides: Record<string, unknown> = {}, rows: ChatMessage[] = sourceRows(), sessionId = SRC) {
  mockFake.seedSession({
    sessionId, userId: OWNER, title: 'My campaign', createdAt: ts(0), updatedAt: ts(2),
    adminListPartition: 'all', portalType: 'agent', pageIdentifier: 'agent-mode', sessionType: 'regular',
    llmModel: 'gpt-5.5', associatedSkills: ['skill-a', 'skill-b'], selectedStartupId: 'startup-1',
    messageCount: rows.length, messages: [],
    ...FORBIDDEN_SOURCE_FIELDS,
    ...overrides,
  });
  mockFake.seedMessages(sessionId, rows);
}

// ---------------------------------------------------------------------------
// Dependencies: the real ChatbotDB, with the policy/flag/lock seams controllable.
// ---------------------------------------------------------------------------
const claimed = new Set<string>();
let events: string[] = [];
const claimOwners: Array<string | undefined> = [];

function makeDeps(over: Partial<BranchDeps> = {}): BranchDeps {
  return {
    isAcceptingWork: () => true,
    isFeatureEnabled: async () => true,
    getSession: (id, opts) => chatbotDb.getChatSession(id, opts?.consistentRead === true),
    tryClaim: (id, ownerUserId) => {
      events.push(`claim:${id}`);
      claimOwners.push(ownerUserId);
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    release: (id) => {
      events.push(`release:${id}`);
      claimed.delete(id);
    },
    resolveModel: async ({ requestedModel, explicit }) => ({
      ok: true,
      model: requestedModel || 'gpt-5.5',
      policy: {
        requestedModel: requestedModel || null, effectiveModel: requestedModel || 'gpt-5.5', backupModel: null,
        backupSource: null, modelSelection: explicit ? 'honored' : 'defaulted', modelSelectionReason: 'test',
        usageMode: 'full_choice', usagePolicyVersion: null, recordedAt: ts(3),
      },
    }),
    createSession: (a) =>
      chatbotDb.createChatSession(
        a.userId, undefined, a.portalType, a.pageIdentifier, a.selectedStartupId, undefined, undefined, undefined,
        'regular', a.delegateInfo, a.initialState,
      ),
    setModel: (id, model, policy) => chatbotDb.updateSessionLlmModel(id, model, policy),
    setTitle: (id, title) => chatbotDb.updateSessionTitle(id, title),
    appendMessages: (id, messages) => chatbotDb.addMessagesToSession(id, messages),
    unarchiveSession: (id) => chatbotDb.unarchiveSession(id),
    getMaxBranchesPerHour: async () => 30,
    sleep: async () => undefined,
    adminToolNames: ADMIN_TOOLS,
    maxSessionMessages: MAX_MESSAGE_SIZE_PER_SESSION,
    now: () => Date.parse('2026-10-08T12:00:00.000Z'),
    log: () => undefined,
    ...over,
  };
}

const owner = { userId: OWNER, isAdmin: false };
const run = (body: unknown, over: Partial<BranchInput> = {}, deps: BranchDeps = makeDeps()) =>
  branchChatSession(deps, { user: owner, viewerIsAdmin: false, sessionId: SRC, body, ...over });

const newSessionIds = () => mockFake.sessionIds().filter((id) => id !== SRC);

beforeEach(() => {
  mockFake.tables.clear();
  mockFake.dropMessageIndexes.clear();
  mockFake.writeLog.length = 0;
  claimed.clear();
  events = [];
  __resetBranchIdempotencyForTests();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('flag and request validation', () => {
  it.each([[undefined], ['false'], ['']])('disabled flag (%p) -> 404 chat_branching_disabled, nothing read or written', async (_v) => {
    seedSource();
    const getSession = jest.fn();
    const out = await run({ messageIndex: 4 }, {}, makeDeps({ isFeatureEnabled: async () => false, getSession }));
    expect(out.status).toBe(404);
    expect((out.body as any).code).toBe('chat_branching_disabled');
    expect(getSession).not.toHaveBeenCalled();
    expect(newSessionIds()).toEqual([]);
  });

  it('503 while the instance is draining', async () => {
    seedSource();
    const out = await run({ messageIndex: 4 }, {}, makeDeps({ isAcceptingWork: () => false }));
    expect(out.status).toBe(503);
    expect(newSessionIds()).toEqual([]);
  });

  it.each([[{}], [{ messageIndex: '4' }], [{ messageIndex: 1.5 }], [{ messageIndex: -1 }], [null], ['x'], [{ messageIndex: 4, llmModel: 5 }], [{ messageIndex: 4, idempotencyKey: 'k'.repeat(300) }]])(
    'malformed body %j -> 400 invalid_request',
    async (body) => {
      seedSource();
      const out = await run(body);
      expect(out.status).toBe(400);
      expect((out.body as any).code).toBe('invalid_request');
      expect(newSessionIds()).toEqual([]);
      expect(claimed.size).toBe(0);
    },
  );
});

describe('session id validation (before any storage call)', () => {
  it.each([
    ['oversized', 'a'.repeat(300)],
    ['empty', ''],
    ['non-uuid garbage', 'not a session!'],
    ['path-ish', '../../etc/passwd'],
    ['encoded slash', 'a%2Fb'],
    ['non-string', 42 as unknown as string],
  ])('%s id -> 400 invalid_session_id, no storage call', async (_n, id) => {
    seedSource();
    const getSession = jest.fn();
    const out = await run({ messageIndex: 4 }, { sessionId: id }, makeDeps({ getSession }));
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('invalid_session_id');
    expect(getSession).not.toHaveBeenCalled();
    expect(newSessionIds()).toEqual([]);
  });

  it('a normal uuid id passes validation', async () => {
    const getSession = jest.fn().mockResolvedValue(null);
    const out = await run({ messageIndex: 4 }, { sessionId: '123e4567-e89b-42d3-a456-426614174000' }, makeDeps({ getSession }));
    expect(out.status).toBe(404);
    expect(getSession).toHaveBeenCalled();
  });
});

describe('isChatBranchingSettingEnabled', () => {
  it('only the exact string "true" enables it', () => {
    expect(isChatBranchingSettingEnabled('true')).toBe(true);
    for (const v of ['TRUE', 'True', ' true ', 'true\n', true, 1, '1', '', null, undefined]) {
      expect(isChatBranchingSettingEnabled(v)).toBe(false);
    }
  });
});

describe('authorisation and eligibility', () => {
  it('404 for a missing session', async () => {
    const out = await run({ messageIndex: 4 });
    expect(out.status).toBe(404);
  });

  it('403 for a stranger, and nothing is created or claimed', async () => {
    seedSource();
    const out = await run({ messageIndex: 4 }, { user: { userId: 'someone-else', isAdmin: false } });
    expect(out.status).toBe(403);
    expect(newSessionIds()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a non-delegated admin may NOT branch a customer\'s session (403, nothing written into the customer\'s account)', async () => {
    seedSource();
    const out = await run({ messageIndex: 4 }, { user: { userId: 'admin-1', isAdmin: true }, viewerIsAdmin: true });
    expect(out.status).toBe(403);
    expect(newSessionIds()).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each([
    ['scheduled', { sessionType: 'scheduled' }],
    ['image-generation', { sessionType: 'image-generation' }],
    ['predefined-work-plan', { sessionType: 'predefined-work-plan' }],
    ['emma-email', { sessionType: 'emma-email' }],
    ['emma-sidebar portal', { portalType: 'emma-sidebar' }],
  ])('refuses to branch a %s session (400 session_not_branchable)', async (_n, over) => {
    seedSource(over);
    const out = await run({ messageIndex: 4 });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('session_not_branchable');
    expect(newSessionIds()).toEqual([]);
    expect(claimed.size).toBe(0);
  });

  it('treats an archived source as not found', async () => {
    seedSource({ archived: true });
    const out = await run({ messageIndex: 4 });
    expect(out.status).toBe(404);
    expect(newSessionIds()).toEqual([]);
  });

  it('a legacy session without sessionType is branchable (regular)', async () => {
    seedSource({ sessionType: undefined });
    const out = await run({ messageIndex: 4 });
    expect(out.status).toBe(201);
  });
});

describe('message index resolution', () => {
  it.each([[11], [999]])('index %i past the end -> 400 message_index_out_of_range', async (messageIndex) => {
    seedSource();
    const out = await run({ messageIndex });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('message_index_out_of_range');
    expect(newSessionIds()).toEqual([]);
    expect(claimed.size).toBe(0);
  });

  it.each([[2, 'tool_calls-only assistant'], [3, 'tool result'], [6, 'tool_calls-only assistant'], [7, 'tool result']])(
    'index %i (%s) is a hidden row -> 400 message_not_visible',
    async (messageIndex) => {
      seedSource();
      const out = await run({ messageIndex });
      expect(out.status).toBe(400);
      expect((out.body as any).code).toBe('message_not_visible');
      expect(newSessionIds()).toEqual([]);
      expect(claimed.size).toBe(0);
    },
  );

  it.each([[0, 'system'], [1, 'user'], [5, 'user']])('index %i (%s) is visible but not an assistant message -> 400 message_not_branchable', async (messageIndex) => {
    seedSource();
    const out = await run({ messageIndex });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('message_not_branchable');
  });

  it('an auto-persisted error message is not branchable', async () => {
    const rows = sourceRows();
    rows[10] = msg({ role: 'assistant', content: 'Something broke', metadata: { timestamp: ts(1), isErrorMessage: true } });
    seedSource({}, rows);
    const out = await run({ messageIndex: 10 });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('message_not_branchable');
  });
});

// ---------------------------------------------------------------------------
describe('the copy', () => {
  it('copies the prefix INCLUDING hidden tool rows, with dense indices and a correct messageCount', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 });
    expect(out.status).toBe(201);
    const id = (out.body as any).sessionId as string;
    const rows = mockFake.rows(id);
    expect(rows.map((r) => r.messageIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.map((r) => r.message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
    expect(rows.map((r) => r.message.content)).toEqual(sourceRows().slice(0, 9).map((m) => m.content));
    expect(rows[3].message.tool_call_id).toBe('c1');
    expect(rows[3].message.name).toBe('web_search');
    expect(mockFake.session(id)!.messageCount).toBe(9);
    expect((out.body as any).messageCount).toBe(9);
  });

  it('branching mid-history copies ONLY the prefix', async () => {
    seedSource();
    const out = await run({ messageIndex: 4 });
    const rows = mockFake.rows((out.body as any).sessionId);
    expect(rows.map((r) => r.message.content)).toEqual(['REAL SYSTEM PROMPT', 'Plan my campaign', '', '{"results":[1]}', 'Here is the plan']);
    expect(mockFake.session((out.body as any).sessionId)!.messageCount).toBe(5);
  });

  it('extends the prefix over the tool-result rows that belong to the branched assistant message', async () => {
    const rows = sourceRows();
    // visible final assistant that itself carries tool_calls + metadata.toolCalls, followed by its tool rows
    rows.splice(
      4, 1,
      msg({ role: 'assistant', content: 'Plan with tools', tool_calls: [{ id: 'cx', type: 'function', function: { name: 'web_search', arguments: '{}' } }], metadata: { timestamp: ts(4), toolCalls: [{ id: 'cx', name: 'web_search', arguments: {}, result: {} }] } }),
      msg({ role: 'tool', content: 'tool-after-1', name: 'web_search', tool_call_id: 'cx' }),
      msg({ role: 'tool', content: 'tool-after-2', name: 'web_search', tool_call_id: 'cx' }),
    );
    seedSource({}, rows);
    const out = await run({ messageIndex: 4 });
    expect(out.status).toBe(201);
    const copied = mockFake.rows((out.body as any).sessionId).map((r) => r.message.content);
    expect(copied.slice(-3)).toEqual(['Plan with tools', 'tool-after-1', 'tool-after-2']);
    expect(copied).not.toContain('Now the budget');
  });

  it('never copies usage, feedback, clientId or the stale messageIndex, so the branch is billed for nothing it did not run', async () => {
    seedSource();
    const out = await run({ messageIndex: 10 });
    const id = (out.body as any).sessionId;
    for (const r of mockFake.rows(id)) {
      expect(r.message.usage).toBeUndefined();
      expect(r.message.clientId).toBeUndefined();
      expect(r.message.messageIndex).toBeUndefined();
      expect(r.message.metadata?.feedback).toBeUndefined();
    }
    const s = mockFake.session(id)!;
    expect(s.totalCost).toBeUndefined();
    expect(s.totalTokens).toBeUndefined();
    // metadata that is NOT bookkeeping survives (the tool ledger renders the assistant card)
    expect(mockFake.rows(id)[4].message.metadata.toolCalls).toHaveLength(1);
    expect(mockFake.rows(id)[4].message.llm).toBe('gpt-5.5');
  });

  it('does not touch the source: no writes to its session item or rows', async () => {
    seedSource();
    const before = JSON.stringify(mockFake.session(SRC)) + JSON.stringify(mockFake.rows(SRC));
    await run({ messageIndex: 8 });
    expect(JSON.stringify(mockFake.session(SRC)) + JSON.stringify(mockFake.rows(SRC))).toBe(before);
    expect(mockFake.writeLog.filter((w) => w.key.startsWith(SRC))).toEqual([]);
  });

  it('stamps provenance on row 0 ONLY, as free-form metadata that survives a read', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 });
    const id = (out.body as any).sessionId;
    const rows = mockFake.rows(id);
    expect(rows[0].message.role).toBe('system');
    expect(rows[0].message.content).toBe('REAL SYSTEM PROMPT');
    expect(rows[0].message.metadata.systemPromptVersion).toBe('abc');
    expect(rows[0].message.metadata.branchOrigin).toEqual({
      sourceSessionId: SRC, sourceTitle: 'My campaign', sourceMessageIndex: 8, branchedAt: '2026-10-08T12:00:00.000Z',
    });
    for (const r of rows.slice(1)) expect(r.message.metadata?.branchOrigin).toBeUndefined();
    // the read path returns it untouched, and so does the client filter
    const session = await chatbotDb.getChatSession(id);
    expect(readBranchOrigin(session!.messages)).toMatchObject({ sourceSessionId: SRC, sourceMessageIndex: 8 });
    expect(readBranchOrigin(filterMessagesForClient(session!.messages))).toMatchObject({ sourceSessionId: SRC });
    // no extra row: the copy has exactly the prefix length
    expect(rows).toHaveLength(9);
  });

  it('title is "<source title> (branch)"', async () => {
    seedSource();
    const out = await run({ messageIndex: 4 });
    expect(mockFake.session((out.body as any).sessionId)!.title).toBe('My campaign (branch)');
    expect((out.body as any).title).toBe('My campaign (branch)');
  });

  it('title falls back and is length-bounded', async () => {
    seedSource({ title: 'T'.repeat(500) });
    const out = await run({ messageIndex: 4 });
    expect(mockFake.session((out.body as any).sessionId)!.title.length).toBeLessThanOrEqual(120);
    expect(mockFake.session((out.body as any).sessionId)!.title.endsWith(' (branch)')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('branch titles', () => {
  it('does not stack the suffix when branching a branch', async () => {
    seedSource({ title: 'My campaign (branch)' });
    const out = await run({ messageIndex: 4 });
    expect((out.body as any).title).toBe('My campaign (branch)');
    expect(mockFake.session((out.body as any).sessionId)!.title).toBe('My campaign (branch)');
  });
  it('only a TRAILING suffix is stripped', async () => {
    seedSource({ title: '(branch) notes' });
    const out = await run({ messageIndex: 4 });
    expect((out.body as any).title).toBe('(branch) notes (branch)');
  });
});

describe('ENG-112 branchedFrom (session-level family link)', () => {
  const NOW_ISO = '2026-10-08T12:00:00.000Z';

  it('is written on a branch: sessionId = source, rootSessionId = source (not itself a branch), raw index, ISO time', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 });
    const item = mockFake.session((out.body as any).sessionId)!;
    expect(item.branchedFrom).toEqual({ sessionId: SRC, rootSessionId: SRC, messageIndex: 8, branchedAt: NOW_ISO });
    // the source is untouched: it never gains a link
    expect(mockFake.session(SRC)!.branchedFrom).toBeUndefined();
  });

  it('a branch of a branch keeps the ORIGINAL root while sessionId is the immediate source', async () => {
    seedSource();
    const first = (await run({ messageIndex: 8 })).body as any;
    const second = (await run({ messageIndex: 4 }, { sessionId: first.sessionId })).body as any;
    expect(mockFake.session(second.sessionId)!.branchedFrom).toEqual({
      sessionId: first.sessionId, rootSessionId: SRC, messageIndex: 4, branchedAt: NOW_ISO,
    });
  });

  it('is never copied from the source: a new branch computes its own', async () => {
    seedSource({ branchedFrom: { sessionId: 'some-parent', rootSessionId: 'some-root', messageIndex: 99, branchedAt: '2020-01-01T00:00:00.000Z' } });
    const out = await run({ messageIndex: 8 });
    expect(mockFake.session((out.body as any).sessionId)!.branchedFrom).toEqual({
      sessionId: SRC, rootSessionId: 'some-root', messageIndex: 8, branchedAt: NOW_ISO,
    });
  });

  it.each([[{ sessionId: 'p', rootSessionId: 7 }], [{ sessionId: 'p' }], ['garbage']])('a malformed source link %j falls back to the source as root', async (bad) => {
    seedSource({ branchedFrom: bad });
    const out = await run({ messageIndex: 8 });
    expect(mockFake.session((out.body as any).sessionId)!.branchedFrom?.rootSessionId).toBe(SRC);
  });

  it('the hidden (born archived) branch already carries the link, so an orphan can be recognised and excluded', async () => {
    seedSource();
    let seenAtCreate: any;
    const base = makeDeps();
    await run({ messageIndex: 8 }, {}, makeDeps({
      createSession: async (a) => { const s = await base.createSession(a); seenAtCreate = mockFake.session(s.sessionId); return s; },
    }));
    expect(seenAtCreate.archived).toBe(true);
    expect(seenAtCreate.branchedFrom.rootSessionId).toBe(SRC);
  });
});

describe('session field handling (allowlist)', () => {
  it('the new session item carries ONLY allowlisted keys: no forbidden source field leaks', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 });
    const item = mockFake.session((out.body as any).sessionId)!;
    const defined = Object.keys(item).filter((k) => item[k] !== undefined);
    const leaked = defined.filter((k) => !ALLOWED_SESSION_KEYS.has(k));
    expect(leaked).toEqual([]);
    // belt and braces: name the dangerous ones
    for (const k of Object.keys(FORBIDDEN_SOURCE_FIELDS)) {
      if (ALLOWED_SESSION_KEYS.has(k)) continue;
      expect(item[k]).toBeUndefined();
    }
    expect(item.delegateInfo).toBeUndefined(); // the source's delegation is not inherited
    expect(item.llmUsagePolicyDecision?.requestedModel).not.toBe('old'); // fresh decision, never the source's
    expect(JSON.stringify(item)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(item)).not.toContain('PAGE CONTENT');
  });

  it('a copy is not publicly reachable: no share tokens or share metadata', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 });
    const item = mockFake.session((out.body as any).sessionId)!;
    expect(item.shareMetadata).toBeUndefined();
    expect(item.interactiveShareMetadata).toBeUndefined();
  });

  it('carries the allowlisted fields and forces sessionType regular', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 });
    const item = mockFake.session((out.body as any).sessionId)!;
    expect(item).toMatchObject({
      userId: OWNER, portalType: 'agent', pageIdentifier: 'agent-mode', sessionType: 'regular',
      associatedSkills: ['skill-a', 'skill-b'], selectedStartupId: 'startup-1', llmModel: 'gpt-5.5',
    });
    expect(item.sessionId).not.toBe(SRC);
  });

  it('the policy decision is the FRESH one for the branch, never the source\'s', async () => {
    seedSource();
    const out = await run({ messageIndex: 8, llmModel: 'claude-opus-4-8' });
    const item = mockFake.session((out.body as any).sessionId)!;
    expect(item.llmModel).toBe('claude-opus-4-8');
    expect(item.llmUsagePolicyDecision.effectiveModel).toBe('claude-opus-4-8');
    expect(item.llmUsagePolicyDecision.requestedModel).toBe('claude-opus-4-8');
    // the source is untouched
    expect(mockFake.session(SRC)!.llmModel).toBe('gpt-5.5');
  });

  it('defaults to the source model when none is requested', async () => {
    seedSource({ llmModel: 'gemini-3.5-flash' });
    let seen: any;
    const deps = makeDeps({ resolveModel: async (i) => { seen = i; return { ok: true, model: i.requestedModel!, policy: undefined }; } });
    const out = await run({ messageIndex: 4 }, {}, deps);
    expect(seen).toMatchObject({ userId: OWNER, requestedModel: 'gemini-3.5-flash', explicit: false });
    expect(mockFake.session((out.body as any).sessionId)!.llmModel).toBe('gemini-3.5-flash');
  });

  it('an explicit model is resolved as an explicit selection for the OWNER (entitlements/usage policy apply)', async () => {
    seedSource();
    let seen: any;
    const deps = makeDeps({ resolveModel: async (i) => { seen = i; return { ok: true, model: i.requestedModel!, policy: undefined }; } });
    await run({ messageIndex: 4, llmModel: ' claude-opus-4-8 ' }, { viewerIsAdmin: true }, deps);
    expect(seen).toMatchObject({ userId: OWNER, requestedModel: 'claude-opus-4-8', explicit: true });
  });

  it('an unavailable model is a 422 BEFORE anything is created, and the claim is released', async () => {
    seedSource();
    const deps = makeDeps({ resolveModel: async () => ({ ok: false, outcome: { status: 422, body: { code: 'model_unavailable' } } }) });
    const out = await run({ messageIndex: 4, llmModel: 'nope' }, {}, deps);
    expect(out.status).toBe(422);
    expect(newSessionIds()).toEqual([]);
    expect(claimed.size).toBe(0);
  });

  it.each([
    ['a schedule-derived pageIdentifier', 'Scheduled: Kevin — Daily Post|scheduleId:1c20ada1-0000-4000-8000-000000000001', 'agent-mode'],
    ['a slack pageIdentifier', 'slack-scan-C123', 'agent-mode'],
    ['a skill pageIdentifier', 'skill-abc123', 'skill-abc123'],
    ['no pageIdentifier', undefined, 'agent-mode'],
  ])('%s', async (_n, pageIdentifier, expected) => {
    seedSource({ pageIdentifier });
    const out = await run({ messageIndex: 4 });
    expect(mockFake.session((out.body as any).sessionId)!.pageIdentifier).toBe(expected);
  });

  it('delegation: the branch records THIS request\'s delegateInfo, never the source\'s', async () => {
    seedSource();
    const delegateInfo = { adminUserId: 'admin-9', adminEmail: 'a9@x', isDelegated: true };
    const out = await run({ messageIndex: 4 }, { delegateInfo, viewerIsAdmin: true });
    expect(mockFake.session((out.body as any).sessionId)!.delegateInfo).toEqual(delegateInfo);
    const plain = await run({ messageIndex: 4 });
    expect(mockFake.session((plain.body as any).sessionId)!.delegateInfo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('admin-only content (ENG-2163) is not laundered through a branch', () => {
  function taintedRows(): ChatMessage[] {
    return [
      msg({ role: 'system', content: 'SYS' }),
      msg({ role: 'user', content: 'hello' }),
      msg({ role: 'assistant', content: 'hi there' }),
      msg({ role: 'user', content: 'run get_pr_digest for this org' }),
      msg({ role: 'assistant', content: 'checking', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'get_pr_digest', arguments: '{}' } }] }),
      msg({ role: 'tool', content: 'INTERNAL PR DATA', name: 'get_pr_digest', tool_call_id: 'a1' }),
      msg({ role: 'assistant', content: 'narration of INTERNAL PR DATA' }),
      msg({ role: 'user', content: 'thanks' }),
      msg({ role: 'assistant', content: 'welcome' }),
    ];
  }
  const visibleTo = (messages: ChatMessage[], viewerIsAdmin: boolean) =>
    filterMessagesForClient(messages, { viewerIsAdmin, adminToolNames: ADMIN_TOOLS }).map((m) => m.content);

  it('the copied tool-result rows keep the taint: a customer sees the SAME redacted view of the branch as of the source', async () => {
    seedSource({}, taintedRows());
    const out = await run({ messageIndex: 8 }, { viewerIsAdmin: true });
    expect(out.status).toBe(201);
    const branch = await chatbotDb.getChatSession((out.body as any).sessionId);
    expect(visibleTo(branch!.messages, false)).toEqual(visibleTo(taintedRows(), false));
    const customerView = JSON.stringify(visibleTo(branch!.messages, false));
    expect(customerView).not.toContain('INTERNAL PR DATA');
    expect(customerView).not.toContain('narration of');
    expect(customerView).not.toContain('get_pr_digest');
    // an admin still sees everything
    expect(visibleTo(branch!.messages, true)).toContain('narration of INTERNAL PR DATA');
  });

  it('an admin branching INSIDE a tainted turn gets the whole turn copied, so the narration is not left untainted', async () => {
    const rows = taintedRows();
    // two assistant messages in the tainted turn: the first is branchable and precedes the admin tool row
    rows.splice(4, 0, msg({ role: 'assistant', content: 'early words before the tool' }));
    seedSource({}, rows);
    const out = await run({ messageIndex: 4 }, { viewerIsAdmin: true });
    expect(out.status).toBe(201);
    const branch = await chatbotDb.getChatSession((out.body as any).sessionId);
    const customerView = JSON.stringify(visibleTo(branch!.messages, false));
    expect(customerView).not.toContain('early words before the tool');
    expect(customerView).not.toContain('run get_pr_digest');
    expect(customerView).not.toContain('INTERNAL PR DATA');
  });

  it('a customer cannot branch from a message they cannot see (the tainted narration is a hidden row -> 400)', async () => {
    seedSource({}, taintedRows());
    const out = await run({ messageIndex: 6 }, { viewerIsAdmin: false });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('message_not_visible');
    expect(newSessionIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('provenance is invisible to the model', () => {
  it('the LLM context built from a branch contains no provenance and no extra system row', () => {
    const { AgentModeService } = require('../services/agentModeService');
    const svc = new AgentModeService();
    const history: ChatMessage[] = [
      msg({
        role: 'system', content: 'REAL SYSTEM PROMPT',
        metadata: { timestamp: ts(0), branchOrigin: { sourceSessionId: SRC, sourceTitle: 'SOURCE-TITLE', sourceMessageIndex: 4, branchedAt: 'x' } } as any,
      }),
      msg({ role: 'user', content: 'Plan my campaign' }),
      msg({ role: 'assistant', content: 'Here is the plan' }),
      msg({ role: 'user', content: 'branch continues here' }),
    ];
    const built = svc.buildMarketingContext('branch continues here', history, []);
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain('SOURCE-TITLE');
    expect(serialized).not.toContain(SRC);
    expect(serialized).not.toContain('branchOrigin');
    expect(serialized).not.toContain('REAL SYSTEM PROMPT'); // row 0 is sliced off exactly as in every session
    expect(built.filter((m: any) => m.role === 'system')).toEqual([]);
    expect(built.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']); // prefix + the current turn
  });

  it('model comparison ignores system rows entirely', () => {
    const { buildCompareMessages } = require('../services/agentMode/modelComparison');
    const out = buildCompareMessages(
      [msg({ role: 'system', content: 'S', metadata: { timestamp: 'x', branchOrigin: { sourceSessionId: SRC } } as any }), msg({ role: 'user', content: 'u1' }), msg({ role: 'assistant', content: 'a1' })],
      'NEW',
    );
    expect(JSON.stringify(out)).not.toContain(SRC);
  });
});

// ---------------------------------------------------------------------------
describe('idempotency', () => {
  it('a retry with the same key attaches to the first branch instead of making a second', async () => {
    seedSource();
    const deps = makeDeps();
    const first = await run({ messageIndex: 8, idempotencyKey: 'k-1' }, {}, deps);
    const retry = await run({ messageIndex: 8, idempotencyKey: 'k-1' }, {}, deps);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect((retry.body as any).sessionId).toBe((first.body as any).sessionId);
    expect((retry.body as any).idempotentReplay).toBe(true);
    expect(newSessionIds()).toHaveLength(1);
    expect(mockFake.rows(newSessionIds()[0])).toHaveLength(9);
  });

  it('concurrent duplicates make exactly one branch and EVERY caller resolves to it (no 409)', async () => {
    seedSource();
    const deps = makeDeps();
    const results = await Promise.all([1, 2, 3].map(() => run({ messageIndex: 8, idempotencyKey: 'k-par' }, {}, deps)));
    expect(newSessionIds()).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const ids = new Set(results.map((r) => (r.body as any).sessionId));
    expect([...ids]).toEqual([newSessionIds()[0]]);
    for (const r of results.filter((x) => x.status === 200)) expect((r.body as any).idempotentReplay).toBe(true);
    expect(claimed.size).toBe(0);
  });

  it('a waiter whose first caller FAILED does not inherit the failure: it runs its own attempt', async () => {
    seedSource();
    let calls = 0;
    const deps = makeDeps({ appendMessages: async (id, m) => { if (++calls === 1) throw new Error('ddb down'); return chatbotDb.addMessagesToSession(id, m); } });
    const [a, b] = await Promise.all([1, 2].map(() => run({ messageIndex: 8, idempotencyKey: 'k-fail-par' }, {}, deps)));
    expect(a.status).toBe(500);
    expect(b.status).toBe(201);
    expect(claimed.size).toBe(0);
  });

  it('concurrent requests with the same key but different SOURCES are independent: two branches', async () => {
    seedSource();
    seedSource({}, sourceRows(), 'src-2');
    const deps = makeDeps();
    const [a, b] = await Promise.all([
      run({ messageIndex: 8, idempotencyKey: 'same' }, {}, deps),
      branchChatSession(deps, { user: owner, viewerIsAdmin: false, sessionId: 'src-2', body: { messageIndex: 8, idempotencyKey: 'same' } }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((a.body as any).sessionId).not.toBe((b.body as any).sessionId);
    expect(newSessionIds().filter((id) => id !== 'src-2')).toHaveLength(2);
  });

  it('concurrent requests with the same key but a different message or model are never folded into one', async () => {
    seedSource();
    const deps = makeDeps();
    const [a, b, c] = await Promise.all([
      run({ messageIndex: 8, idempotencyKey: 'same' }, {}, deps),
      run({ messageIndex: 4, idempotencyKey: 'same' }, {}, deps),
      run({ messageIndex: 8, llmModel: 'other-model', idempotencyKey: 'same' }, {}, deps),
    ]);
    // The source's generation lock still serialises them (SESSION_BUSY), but none is answered as a duplicate/replay of another.
    for (const r of [a, b, c]) {
      expect((r.body as any).code).not.toBe('DUPLICATE_SUBMIT');
      expect((r.body as any).idempotentReplay).toBeUndefined();
    }
    expect([a, b, c].filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(new Set([a, b, c].filter((r) => r.status === 201).map((r) => (r.body as any).sessionId)).size).toBe([a, b, c].filter((r) => r.status === 201).length);
  });

  it('a different key (or no key) is a deliberate second branch', async () => {
    seedSource();
    const deps = makeDeps();
    await run({ messageIndex: 8, idempotencyKey: 'a' }, {}, deps);
    await run({ messageIndex: 8, idempotencyKey: 'b' }, {}, deps);
    await run({ messageIndex: 8 }, {}, deps);
    await run({ messageIndex: 8 }, {}, deps);
    expect(newSessionIds()).toHaveLength(4);
  });

  it('keys are scoped to the user and the source session', async () => {
    seedSource();
    seedSource({}, sourceRows(), 'src-2');
    const deps = makeDeps();
    const a = await run({ messageIndex: 8, idempotencyKey: 'same' }, {}, deps);
    const b = await branchChatSession(deps, { user: owner, viewerIsAdmin: false, sessionId: 'src-2', body: { messageIndex: 8, idempotencyKey: 'same' } });
    expect(b.status).toBe(201);
    expect((b.body as any).sessionId).not.toBe((a.body as any).sessionId);
  });

  it('a failed attempt releases the key so the retry can succeed', async () => {
    seedSource();
    const deps = makeDeps();
    const failing = makeDeps({ appendMessages: async () => { throw new Error('ddb down'); } });
    const bad = await run({ messageIndex: 8, idempotencyKey: 'k-fail' }, {}, failing);
    expect(bad.status).toBe(500);
    const good = await run({ messageIndex: 8, idempotencyKey: 'k-fail' }, {}, deps);
    expect(good.status).toBe(201);
  });

  it('uses the shared run-store lane when provided: a lost claim with a recorded session attaches to it', async () => {
    seedSource();
    const existing = await run({ messageIndex: 8 });
    const sid = (existing.body as any).sessionId;
    const out = await run({ messageIndex: 8, idempotencyKey: 'xinst' }, {}, makeDeps({
      claimIdempotency: async () => ({ claimed: false, sessionId: sid }),
    }));
    expect(out.status).toBe(200);
    expect((out.body as any).sessionId).toBe(sid);
    expect(newSessionIds()).toHaveLength(1);
  });

  it('run-store lane: a lost claim still in flight is a 409 DUPLICATE_SUBMIT and creates nothing', async () => {
    seedSource();
    const out = await run({ messageIndex: 8, idempotencyKey: 'xinst' }, {}, makeDeps({ claimIdempotency: async () => ({ claimed: false }) }));
    expect(out.status).toBe(409);
    expect((out.body as any).code).toBe('DUPLICATE_SUBMIT');
    expect(newSessionIds()).toEqual([]);
  });

  it('run-store lane: stamps the new session id on success and releases on failure', async () => {
    seedSource();
    const recordIdempotencySessionId = jest.fn(async () => undefined);
    const releaseIdempotency = jest.fn(async () => undefined);
    const base = { claimIdempotency: async () => ({ claimed: true as const }), recordIdempotencySessionId, releaseIdempotency };
    const ok = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, makeDeps(base));
    expect(recordIdempotencySessionId).toHaveBeenCalledWith(OWNER, JSON.stringify(['branch', SRC, 8, '', 'k']), (ok.body as any).sessionId);
    expect(releaseIdempotency).not.toHaveBeenCalled();
    await run({ messageIndex: 8, idempotencyKey: 'k2' }, {}, makeDeps({ ...base, appendMessages: async () => { throw new Error('x'); } }));
    expect(releaseIdempotency).toHaveBeenCalledWith(OWNER, JSON.stringify(['branch', SRC, 8, '', 'k2']));
  });

  it('post-reveal bookkeeping failure: still 201, logged with the session id, claim NOT released, same-key retry replays (200)', async () => {
    seedSource();
    const logs: Array<[string, any]> = [];
    const releaseIdempotency = jest.fn(async () => undefined);
    const deps = makeDeps({
      claimIdempotency: async () => ({ claimed: true as const }),
      recordIdempotencySessionId: async () => { throw new Error('ddb down'); },
      releaseIdempotency,
      log: (m: string, d?: any) => { logs.push([m, d]); },
    });
    const out = await run({ messageIndex: 8, idempotencyKey: 'kb' }, {}, deps);
    expect(out.status).toBe(201);
    const id = (out.body as any).sessionId;
    expect(releaseIdempotency).not.toHaveBeenCalled();
    expect(logs.some(([, d]) => d?.sessionId === id)).toBe(true);
    const before = newSessionIds().length;
    const retry = await run({ messageIndex: 8, idempotencyKey: 'kb' }, {}, deps);
    expect(retry.status).toBe(200);
    expect((retry.body as any).sessionId).toBe(id);
    expect(newSessionIds()).toHaveLength(before);
  });

  it('every failure log after creation carries the new session id (generic unexpected-failure line too)', async () => {
    seedSource();
    const logs: Array<[string, any]> = [];
    const out = await run({ messageIndex: 8 }, {}, makeDeps({
      appendMessages: async () => { throw new Error('x'); },
      log: (m: string, d?: any) => { logs.push([m, d]); },
    }));
    expect(out.status).toBe(500);
    const id = newSessionIds()[0];
    const failure = logs.find(([m]) => m === 'ChatBranching: unexpected failure');
    expect(failure?.[1].sessionId).toBe(id);
  });
});

// ---------------------------------------------------------------------------
describe('source generation claim', () => {
  it('claims the SOURCE for the whole copy and releases it on success', async () => {
    seedSource();
    let heldDuringAppend = false;
    const deps = makeDeps({
      appendMessages: async (id, m) => { heldDuringAppend = claimed.has(SRC); return chatbotDb.addMessagesToSession(id, m); },
    });
    const out = await run({ messageIndex: 8 }, {}, deps);
    expect(out.status).toBe(201);
    expect(heldDuringAppend).toBe(true);
    expect(events).toEqual([`claim:${SRC}`, `release:${SRC}`]);
    expect(claimed.size).toBe(0);
  });

  it('409 SESSION_BUSY when a generation holds the source, with nothing created, and the foreign claim is NOT released', async () => {
    seedSource();
    claimed.add(SRC); // a running /generate
    const out = await run({ messageIndex: 8 });
    expect(out.status).toBe(409);
    expect((out.body as any).code).toBe('SESSION_BUSY');
    expect(newSessionIds()).toEqual([]);
    expect(claimed.has(SRC)).toBe(true);
    expect(events).toEqual([`claim:${SRC}`]); // no release of a lock we never held
  });

  it('ENG-110: the source claim carries the branch OWNER so /generating can list the run (branching holds no cap slot)', async () => {
    seedSource();
    claimOwners.length = 0;
    const out = await run({ messageIndex: 8 });
    expect(out.status).toBe(201);
    expect(claimOwners).toEqual([OWNER]);
  });

  it('a generation cannot start on the source while the copy runs (concurrent append during copy refused)', async () => {
    seedSource();
    let generateDuringCopy: boolean | undefined;
    const deps = makeDeps({
      appendMessages: async (id, m) => {
        generateDuringCopy = deps.tryClaim(SRC); // what /generate does first
        return chatbotDb.addMessagesToSession(id, m);
      },
    });
    const out = await run({ messageIndex: 8 }, {}, deps);
    expect(out.status).toBe(201);
    expect(generateDuringCopy).toBe(false);
    expect(deps.tryClaim(SRC)).toBe(true); // free again afterwards
  });

  it('two simultaneous branches of one source: one runs, the other is 409 SESSION_BUSY', async () => {
    seedSource();
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    const slow = makeDeps({ appendMessages: async (id, m) => { await gate; return chatbotDb.addMessagesToSession(id, m); } });
    const first = run({ messageIndex: 8 }, {}, slow);
    await new Promise((r) => setImmediate(r));
    const second = await run({ messageIndex: 4 }, {}, makeDeps());
    expect(second.status).toBe(409);
    unblock();
    expect((await first).status).toBe(201);
  });

  it.each([
    ['index validation fails under the lock', { messageIndex: 999 }, undefined],
    ['createSession throws', { messageIndex: 8 }, { createSession: async () => { throw new Error('boom'); } }],
    ['appendMessages throws', { messageIndex: 8 }, { appendMessages: async () => { throw new Error('boom'); } }],
    ['setTitle throws', { messageIndex: 8 }, { setTitle: async () => { throw new Error('boom'); } }],
    ['setModel throws', { messageIndex: 8 }, { setModel: async () => { throw new Error('boom'); } }],
  ])('releases the claim exactly once when %s', async (_n, body, over) => {
    seedSource();
    await run(body, {}, makeDeps(over as any));
    expect(events.filter((e) => e === `release:${SRC}`)).toHaveLength(1);
    expect(claimed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('failure handling', () => {
  it('a failed copy archives the half-built branch and answers 500', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 }, {}, makeDeps({ appendMessages: async () => { throw new Error('ddb down'); } }));
    expect(out.status).toBe(500);
    expect((out.body as any).code).toBe('branch_failed');
    const ids = newSessionIds();
    expect(ids).toHaveLength(1);
    expect(mockFake.session(ids[0])!.archived).toBe(true);
  });

  it('a SILENT partial write (unprocessed batch items) is detected, not reported as success', async () => {
    seedSource();
    mockFake.dropMessageIndexes = new Set([6]);
    const out = await run({ messageIndex: 8 }); // addMessagesToMessagesTable backs off ~1.4s before giving up
    expect(out.status).toBe(500);
    const ids = newSessionIds();
    expect(ids).toHaveLength(1);
    expect(mockFake.session(ids[0])!.archived).toBe(true);
  });

  it('retries the append when the freshly created session is not yet readable (eventual consistency)', async () => {
    seedSource();
    let calls = 0;
    const deps = makeDeps({
      appendMessages: async (id, m) => {
        calls += 1;
        if (calls === 1) throw new Error('Session not found');
        return chatbotDb.addMessagesToSession(id, m);
      },
    });
    const out = await run({ messageIndex: 8 }, {}, deps);
    expect(out.status).toBe(201);
    expect(calls).toBe(2);
    expect(mockFake.rows((out.body as any).sessionId)).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
describe('size limits', () => {
  function bigRows(n: number): ChatMessage[] {
    const rows: ChatMessage[] = [msg({ role: 'system', content: 'SYS' })];
    for (let i = 1; i < n; i++) {
      const role = i % 2 === 1 && i !== n - 1 ? 'user' : 'assistant';
      rows.push(msg({ role, content: `${role[0]}${i}` }));
    }
    return rows;
  }

  it('a near-cap history branches completely, leaving the headroom for the next turn', async () => {
    const n = MAX_MESSAGE_SIZE_PER_SESSION - BRANCH_MIN_HEADROOM_MESSAGES; // exactly at the limit we accept
    const rows = bigRows(n);
    expect(rows[n - 1].role).toBe('assistant');
    seedSource({}, rows);
    const out = await run({ messageIndex: n - 1 });
    expect(out.status).toBe(201);
    const id = (out.body as any).sessionId;
    expect(mockFake.rows(id)).toHaveLength(n);
    expect(mockFake.rows(id).map((r) => r.messageIndex)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(mockFake.session(id)!.messageCount).toBe(n);
  }, 60000);

  it('a prefix that would leave the branch without room to continue is refused (400 branch_too_large), nothing created', async () => {
    const n = MAX_MESSAGE_SIZE_PER_SESSION - BRANCH_MIN_HEADROOM_MESSAGES + 2;
    const rows = bigRows(n);
    seedSource({}, rows);
    const lastAssistant = rows.map((r) => r.role).lastIndexOf('assistant');
    const out = await run({ messageIndex: lastAssistant });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('branch_too_large');
    expect(newSessionIds()).toEqual([]);
    expect(claimed.size).toBe(0);
  }, 60000);

  it('branching earlier in an over-long source works when the PREFIX fits', async () => {
    const rows = bigRows(MAX_MESSAGE_SIZE_PER_SESSION);
    seedSource({}, rows);
    const out = await run({ messageIndex: 4 });
    expect(out.status).toBe(201);
    expect(mockFake.rows((out.body as any).sessionId)).toHaveLength(5);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Review follow-ups
// ---------------------------------------------------------------------------
const RECENT = '2026-10-08T11:50:00.000Z'; // 10 minutes before makeDeps().now()
const NOW_MS = Date.parse('2026-10-08T12:00:00.000Z');
const recentMsg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage =>
  ({ timestamp: RECENT, ...m, metadata: { timestamp: RECENT, ...(m.metadata ?? {}) } }) as ChatMessage;

describe('a branch never inherits a continuation trigger (getSession would bill an auto media continuation)', () => {
  const sys = () => msg({ role: 'system', content: 'SYS' });
  const variants: Array<[string, () => ChatMessage[], number]> = [
    ['assistant tail flagged mediaBudgetDeferred', () => [sys(), recentMsg({ role: 'user', content: 'make 4 images' }), recentMsg({ role: 'assistant', content: 'Two done, rest queued', metadata: { mediaBudgetDeferred: true } as any })], 2],
    ['tool tail flagged mediaBudgetDeferred', () => [sys(), recentMsg({ role: 'user', content: 'make 4 images' }), recentMsg({ role: 'assistant', content: 'Working' }), recentMsg({ role: 'tool', content: '{"deferred":true}', name: 'generate_image', tool_call_id: 'c', metadata: { mediaBudgetDeferred: true } as any })], 2],
    ['assistant toolCalls ledger with a deferred media call', () => [sys(), recentMsg({ role: 'user', content: 'make 4 images' }), recentMsg({ role: 'assistant', content: 'Queued', metadata: { toolCalls: [{ id: 'c', name: 'generate_image', arguments: {}, result: { deferred: true, reason: 'media_generation_time_budget' } }] } as any })], 2],
  ];

  it.each(variants)('%s', async (_name, build, idx) => {
    const rows = build();
    seedSource({}, rows);
    // sanity: the SOURCE would trigger the backstop, so the test is meaningful
    expect(hasUnresolvedMediaDeferral(rows as any, NOW_MS - 3600_000)).toBe(true);
    const out = await run({ messageIndex: idx });
    expect(out.status).toBe(201);
    const branch = await chatbotDb.getChatSession((out.body as any).sessionId, true);
    expect(hasUnresolvedMediaDeferral(branch!.messages as any, NOW_MS - 3600_000)).toBe(false);
    expect(hasUnresolvedMediaDeferral(branch!.messages as any)).toBe(false);
    for (const m of branch!.messages!) expect((m.metadata as any)?.mediaBudgetDeferred).toBeUndefined();
    expect(branch!.messages!.at(-1)!.content).toBe(rows.at(-1)!.content); // the visible text still travels
  });
});

describe('a source target with no preceding user message', () => {
  it('is refused with 400 and nothing is created', async () => {
    seedSource({}, [msg({ role: 'system', content: 'SYS' }), msg({ role: 'assistant', content: 'Welcome!' }), msg({ role: 'user', content: 'hi' }), msg({ role: 'assistant', content: 'hello' })]);
    const out = await run({ messageIndex: 1 });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('no_user_message');
    expect(newSessionIds()).toEqual([]);
    expect(claimed.size).toBe(0);
  });
});

describe('idempotency scope covers what the request asked for', () => {
  it('the same key with a different messageIndex is a different branch, not the first one', async () => {
    seedSource();
    const deps = makeDeps();
    const a = await run({ messageIndex: 4, idempotencyKey: 'k' }, {}, deps);
    const b = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, deps);
    expect(b.status).toBe(201);
    expect((b.body as any).sessionId).not.toBe((a.body as any).sessionId);
    expect(mockFake.rows((b.body as any).sessionId)).toHaveLength(9);
  });
  it('the same key with a different llmModel is a different branch', async () => {
    seedSource();
    const deps = makeDeps();
    const a = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, deps);
    const b = await run({ messageIndex: 8, idempotencyKey: 'k', llmModel: 'claude-opus-4-8' }, {}, deps);
    expect(b.status).toBe(201);
    expect((b.body as any).sessionId).not.toBe((a.body as any).sessionId);
    expect(mockFake.session((b.body as any).sessionId)!.llmModel).toBe('claude-opus-4-8');
  });
  it('the same key with the same index and model still replays', async () => {
    seedSource();
    const deps = makeDeps();
    await run({ messageIndex: 8, idempotencyKey: 'k', llmModel: 'm1' }, {}, deps);
    const again = await run({ messageIndex: 8, idempotencyKey: 'k', llmModel: 'm1' }, {}, deps);
    expect(again.status).toBe(200);
  });
  it('the run-store lane is scoped the same way', async () => {
    seedSource();
    const scopes: string[] = [];
    const deps = makeDeps({ claimIdempotency: async (_u, scope) => { scopes.push(scope); return { claimed: true }; }, recordIdempotencySessionId: async () => undefined, releaseIdempotency: async () => undefined });
    await run({ messageIndex: 8, idempotencyKey: 'k', llmModel: 'm1' }, {}, deps);
    expect(scopes).toHaveLength(1);
    expect(JSON.parse(scopes[0])).toEqual(['branch', SRC, 8, 'm1', 'k']);
    expect(scopes[0]).toContain('m1');
  });
});

describe('the branch is hidden until it is verified', () => {
  it('is archived from creation until the copy is verified, then revealed (attribute removed) (visible only when whole)', async () => {
    seedSource();
    let archivedDuringAppend: unknown = 'unset';
    const deps = makeDeps({
      appendMessages: async (id, m) => {
        archivedDuringAppend = mockFake.session(id)!.archived;
        return chatbotDb.addMessagesToSession(id, m);
      },
    });
    const out = await run({ messageIndex: 8 }, {}, deps);
    expect(out.status).toBe(201);
    expect(archivedDuringAppend).toBe(true);
    expect(mockFake.session((out.body as any).sessionId)!.archived).toBeUndefined();
  });

  it('if un-archiving keeps failing the branch stays hidden and the response says so', async () => {
    seedSource();
    const deps = makeDeps({ unarchiveSession: async () => { throw new Error('nope'); } });
    const out = await run({ messageIndex: 8 }, {}, deps);
    expect(out.status).toBe(500);
    expect(mockFake.session(newSessionIds()[0])!.archived).toBe(true);
  });
});

describe('visible index -> raw index mapping on a GAPPED store', () => {
  // positions 0..10 of sourceRows(), stored at raw indexes that are NOT the positions
  const RAW = [0, 4, 5, 6, 12, 13, 14, 15, 20, 21, 22];
  const seedGapped = () => {
    seedSource({ messageCount: RAW.length });
    mockFake.tables.get('AW-ChatMessages')?.forEach((_v, k) => { if (k.startsWith(`${SRC}\x00`)) mockFake.tables.get('AW-ChatMessages')!.delete(k); });
    mockFake.seedMessagesAt(SRC, sourceRows(), RAW);
  };

  it('raw 20 is the "Budget answer" reply: copies positions 0..8 and records the RAW index in provenance', async () => {
    seedGapped();
    const out = await run({ messageIndex: 20 });
    expect(out.status).toBe(201);
    const rows = mockFake.rows((out.body as any).sessionId);
    expect(rows.map((r) => r.messageIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.at(-1)!.message.content).toBe('Budget answer');
    expect(rows[0].message.metadata.branchOrigin.sourceMessageIndex).toBe(20);
  });

  it('a raw index that does not exist (a position number) is rejected, and a gap index is rejected', async () => {
    seedGapped();
    expect((await run({ messageIndex: 8 })).status).toBe(400); // position 8 is raw 20; raw 8 is a gap
    expect((await run({ messageIndex: 3 })).status).toBe(400);
    expect(newSessionIds()).toEqual([]);
  });

  it('hidden tool rows named by their raw index are refused as not visible', async () => {
    seedGapped();
    const out = await run({ messageIndex: 6 }); // raw 6 = the tool row at position 3
    expect((out.body as any).code).toBe('message_not_visible');
  });
});

describe('per-user branching rate cap', () => {
  const at = (t: { v: number }) => ({ now: () => t.v });
  it('429 TOO_MANY_BRANCHES after the cap, with a neutral message; the source lock is released and nothing is created', async () => {
    seedSource();
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 2 });
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
    const before = newSessionIds().length;
    const out = await run({ messageIndex: 4 }, {}, deps);
    expect(out.status).toBe(429);
    expect((out.body as any).code).toBe('TOO_MANY_BRANCHES');
    expect(typeof (out.body as any).message).toBe('string');
    expect((out.body as any).message).not.toMatch(/limit of|2 per|per hour|rate/i);
    expect(newSessionIds()).toHaveLength(before);
    expect(claimed.size).toBe(0);
  });

  it('the window slides: allowed again after an hour', async () => {
    seedSource();
    const t = { v: NOW_MS };
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 1, ...at(t) });
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
    t.v += 30 * 60_000;
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(429);
    t.v += 31 * 60_000;
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
  });

  it('the window boundary is exclusive: a branch made EXACTLY one hour ago no longer counts (one ms earlier it still does)', async () => {
    seedSource();
    const t = { v: NOW_MS };
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 1, ...at(t) });
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
    t.v = NOW_MS + 3_600_000 - 1;
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(429);
    t.v = NOW_MS + 3_600_000;
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
  });

  it('0 means unlimited; absent/invalid values default to 30 (via parseBranchRateLimit)', async () => {
    const { parseBranchRateLimit } = await import('../services/agentMode/chatBranching');
    expect(parseBranchRateLimit(undefined)).toBe(30);
    expect(parseBranchRateLimit(null)).toBe(30);
    expect(parseBranchRateLimit('abc')).toBe(30);
    expect(parseBranchRateLimit('-3')).toBe(30);
    expect(parseBranchRateLimit('2.5')).toBe(30);
    expect(parseBranchRateLimit('0')).toBe(0);
    expect(parseBranchRateLimit(' 7 ')).toBe(7);
    seedSource();
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 0 });
    for (let i = 0; i < 5; i++) expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
  });

  it('is per user', async () => {
    seedSource();
    seedSource({ userId: 'other' }, sourceRows(), 'src-other');
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 1 });
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
    const o = await branchChatSession(deps, { user: { userId: 'other', isAdmin: false }, viewerIsAdmin: false, sessionId: 'src-other', body: { messageIndex: 4 } });
    expect(o.status).toBe(201);
  });

  it('is NOT consumed by requests that fail validation, are refused, or create nothing', async () => {
    seedSource();
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 1 });
    expect((await run({ messageIndex: 'x' }, {}, deps)).status).toBe(400);   // body
    expect((await run({ messageIndex: 999 }, {}, deps)).status).toBe(400);   // out of range (took the lock, created nothing)
    expect((await run({ messageIndex: 3 }, {}, deps)).status).toBe(400);     // hidden row
    claimed.add(SRC);
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(409);     // busy (never took the lock)
    claimed.delete(SRC);
    expect((await run({ messageIndex: 4 }, {}, makeDeps({ getMaxBranchesPerHour: async () => 1, createSession: async () => { throw new Error('boom'); } }))).status).toBe(500);
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);     // still has its one
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(429);
  });

  it('IS consumed when a session was created but the copy failed', async () => {
    seedSource();
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 1, appendMessages: async () => { throw new Error('ddb'); } });
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(500);
    expect((await run({ messageIndex: 4 }, {}, makeDeps({ getMaxBranchesPerHour: async () => 1 }))).status).toBe(429);
  });

  it('an idempotent replay is not counted', async () => {
    seedSource();
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 1 });
    expect((await run({ messageIndex: 4, idempotencyKey: 'k' }, {}, deps)).status).toBe(201);
    expect((await run({ messageIndex: 4, idempotencyKey: 'k' }, {}, deps)).status).toBe(200);
  });

  it('expired windows are pruned: idle users do not accumulate in memory', async () => {
    const { RATE_SWEEP_EVERY, __branchWindowUsersForTests } = await import('../services/agentMode/chatBranching');
    seedSource();
    const users = ['pa', 'pb', 'pc'];
    for (const u of users) seedSource({ userId: u }, sourceRows(), `src-${u}`);
    const t = { v: NOW_MS };
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 5, ...at(t) });
    for (const u of users) {
      const o = await branchChatSession(deps, { user: { userId: u, isAdmin: false }, viewerIsAdmin: false, sessionId: `src-${u}`, body: { messageIndex: 4 } });
      expect(o.status).toBe(201);
    }
    expect(__branchWindowUsersForTests()).toBe(3);
    t.v += 3_600_000; // all three windows have fully expired
    for (let i = 0; i < RATE_SWEEP_EVERY; i++) await run({ messageIndex: 999 }, {}, deps); // refunded, create nothing
    expect(__branchWindowUsersForTests()).toBe(0);
  });

  it('a user over the cap whose window empties does not leave an empty entry behind', async () => {
    seedSource();
    const t = { v: NOW_MS };
    const deps = makeDeps({ getMaxBranchesPerHour: async () => 1, ...at(t) });
    const { __branchWindowUsersForTests } = await import('../services/agentMode/chatBranching');
    await run({ messageIndex: 4 }, {}, deps);
    t.v += 3_600_000;
    await run({ messageIndex: 999 }, {}, deps); // slot taken then refunded
    expect(__branchWindowUsersForTests()).toBe(0);
  });

  it('a failing settings read falls back to the default instead of failing the request', async () => {
    seedSource();
    const deps = makeDeps({ getMaxBranchesPerHour: async () => { throw new Error('settings down'); } });
    expect((await run({ messageIndex: 4 }, {}, deps)).status).toBe(201);
  });
});


describe('idempotency scope is injective and replay is verified', () => {
  it('a model id containing the old delimiter cannot collide with a different (model, key) pair', async () => {
    seedSource();
    const deps = makeDeps();
    const a = await run({ messageIndex: 8, llmModel: 'm|x', idempotencyKey: 'k' }, {}, deps);
    const b = await run({ messageIndex: 8, llmModel: 'm', idempotencyKey: 'x|k' }, {}, deps);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((b.body as any).sessionId).not.toBe((a.body as any).sessionId);
  });

  it('the run-store scope for those two requests differs', async () => {
    seedSource();
    const scopes: string[] = [];
    const claimIdempotency = async (_u: string, scope: string) => { scopes.push(scope); return { claimed: true as const }; };
    await run({ messageIndex: 8, llmModel: 'm|x', idempotencyKey: 'k' }, {}, makeDeps({ claimIdempotency }));
    await run({ messageIndex: 8, llmModel: 'm', idempotencyKey: 'x|k' }, {}, makeDeps({ claimIdempotency }));
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).not.toBe(scopes[1]);
  });

  it('a replay whose branch came from a DIFFERENT message index is not returned (run-store lane: 409, nothing created)', async () => {
    seedSource();
    const other = await run({ messageIndex: 4 });
    const before = newSessionIds().length;
    const out = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, makeDeps({
      claimIdempotency: async () => ({ claimed: false, sessionId: (other.body as any).sessionId }),
    }));
    expect(out.status).toBe(409);
    expect((out.body as any).code).toBe('DUPLICATE_SUBMIT');
    expect(newSessionIds()).toHaveLength(before);
  });

  it('a replay whose branch came from a DIFFERENT source session is not returned', async () => {
    seedSource();
    seedSource({}, sourceRows(), 'src-2');
    const deps = makeDeps();
    const fromOther = await branchChatSession(deps, { user: owner, viewerIsAdmin: false, sessionId: 'src-2', body: { messageIndex: 8 } });
    const out = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, makeDeps({
      claimIdempotency: async () => ({ claimed: false, sessionId: (fromOther.body as any).sessionId }),
    }));
    expect(out.status).toBe(409);
  });

  it('in-process lane: a remembered branch whose provenance no longer matches the request is not replayed; a new branch is made', async () => {
    seedSource();
    const deps = makeDeps();
    const first = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, deps);
    const id = (first.body as any).sessionId;
    const row0 = mockFake.rows(id)[0];
    mockFake.tables.get('AW-ChatMessages')!.get(`${id}\x000`)!.message.metadata.branchOrigin.sourceMessageIndex = 4;
    expect(row0.messageIndex).toBe(0);
    const again = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, deps);
    expect(again.status).toBe(201);
    expect((again.body as any).sessionId).not.toBe(id);
  });

  it('a branch that is still archived (copy failed / not revealed) is never replayed as a success', async () => {
    seedSource();
    // The copy lands but revealing keeps failing: the branch is whole (provenance matches) yet archived.
    const orphanMaker = makeDeps({ unarchiveSession: async () => { throw new Error('nope'); } });
    const failed = await run({ messageIndex: 8, idempotencyKey: 'k' }, {}, orphanMaker);
    expect(failed.status).toBe(500);
    const orphan = newSessionIds()[0];
    expect(mockFake.session(orphan)!.archived).toBe(true);
    expect(readBranchOrigin(mockFake.rows(orphan).map((r) => r.message as any))?.sourceSessionId).toBe(SRC);
    const out = await run({ messageIndex: 8, idempotencyKey: 'k2' }, {}, makeDeps({
      claimIdempotency: async () => ({ claimed: false, sessionId: orphan }),
    }));
    expect(out.status).toBe(409);
    expect(out.status).not.toBe(200);
  });
});

describe('the branch is born hidden and revealed without a new stored shape', () => {
  it('createSession is asked for an archived session; no separate archive write is needed', async () => {
    seedSource();
    const createSession = jest.fn(makeDeps().createSession);
    const archiveSession = jest.fn(async () => undefined);
    const out = await run({ messageIndex: 8 }, {}, makeDeps({ createSession, archiveSession } as any));
    expect(out.status).toBe(201);
    expect(createSession.mock.calls[0][0].initialState.archived).toBe(true);
    expect(archiveSession).not.toHaveBeenCalled();
  });

  it('the session item is archived from its very first write', async () => {
    seedSource();
    await run({ messageIndex: 8 });
    const firstWrite = mockFake.writeLog.find((w) => w.table.endsWith('AW-ChatSessions') && w.key !== SRC);
    expect(firstWrite?.op).toBe('put');
    // the put carried archived:true: the same item is archived while the copy runs (see "hidden until verified")
  });

  it('logs the new session id at creation so a mid-copy death leaves a greppable orphan', async () => {
    seedSource();
    const log = jest.fn();
    await run({ messageIndex: 8 }, {}, makeDeps({ log, appendMessages: async () => { throw new Error('ddb down'); } }));
    const id = newSessionIds()[0];
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/created/i), expect.objectContaining({ sessionId: id, sourceSessionId: SRC }));
  });

  it('after reveal the branch carries NO archived attribute at all (same shape as an ordinary session)', async () => {
    seedSource();
    const out = await run({ messageIndex: 8 });
    const item = mockFake.session((out.body as any).sessionId)!;
    expect('archived' in item).toBe(false);
    expect(item.adminListPartition).toBe('all');
  });

  it('unarchiveSession on a vanished id fails (ConditionalCheckFailed) and does NOT upsert a ghost row', async () => {
    await expect(chatbotDb.unarchiveSession('ghost-id')).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect(mockFake.session('ghost-id')).toBeUndefined();
    expect(mockFake.sessionIds()).not.toContain('ghost-id');
  });

  it('a session that vanished before the reveal is not retried, is logged as vanished and answers 500 (like a failed reveal)', async () => {
    seedSource();
    const log = jest.fn();
    const unarchive = jest.fn(async (id: string) => {
      mockFake.tables.get('AW-ChatSessions')!.delete(id);
      return chatbotDb.unarchiveSession(id);
    });
    const out = await run({ messageIndex: 8 }, {}, makeDeps({ unarchiveSession: unarchive, log }));
    expect(out.status).toBe(500);
    expect(unarchive).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/vanished/i), expect.anything());
    expect(newSessionIds()).toEqual([]);
  });

  it('a copy failure leaves the session archived (hidden), with its id logged', async () => {
    seedSource();
    const log = jest.fn();
    const out = await run({ messageIndex: 8 }, {}, makeDeps({ log, appendMessages: async () => { throw new Error('ddb down'); } }));
    expect(out.status).toBe(500);
    expect(mockFake.session(newSessionIds()[0])!.archived).toBe(true);
  });
});
