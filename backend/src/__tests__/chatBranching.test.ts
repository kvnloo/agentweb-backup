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
} from '../services/agentMode/chatBranching';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';

const OWNER = 'user-owner';
const SRC = 'src-session-1';
const ADMIN_TOOLS = ['get_pr_digest'];

// Every key a freshly created branch session may carry. Anything else is a leaked source field.
const ALLOWED_SESSION_KEYS = new Set([
  'sessionId', 'userId', 'title', 'createdAt', 'updatedAt', 'adminListPartition', 'portalType',
  'pageIdentifier', 'selectedStartupId', 'sessionType', 'delegateInfo', 'associatedSkills',
  'llmModel', 'llmUsagePolicyDecision', 'messageCount', 'messages',
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

function makeDeps(over: Partial<BranchDeps> = {}): BranchDeps {
  return {
    isAcceptingWork: () => true,
    isFeatureEnabled: async () => true,
    getSession: (id, opts) => chatbotDb.getChatSession(id, opts?.consistentRead === true),
    tryClaim: (id) => {
      events.push(`claim:${id}`);
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
    archiveSession: (id) => chatbotDb.archiveSession(id),
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

  it('an admin may branch another user\'s session; the branch stays owned by the source owner', async () => {
    seedSource();
    const out = await run({ messageIndex: 4 }, { user: { userId: 'admin-1', isAdmin: true }, viewerIsAdmin: true });
    expect(out.status).toBe(201);
    expect(mockFake.session((out.body as any).sessionId)!.userId).toBe(OWNER);
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
    await run({ messageIndex: 4, llmModel: ' claude-opus-4-8 ' }, { user: { userId: 'admin-1', isAdmin: true }, viewerIsAdmin: true }, deps);
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

  it('concurrent duplicates make exactly one branch', async () => {
    seedSource();
    const deps = makeDeps();
    const results = await Promise.all([1, 2, 3].map(() => run({ messageIndex: 8, idempotencyKey: 'k-par' }, {}, deps)));
    expect(newSessionIds()).toHaveLength(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect([200, 409]).toContain(r.status);
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
    expect(recordIdempotencySessionId).toHaveBeenCalledWith(OWNER, `branch|${SRC}|k`, (ok.body as any).sessionId);
    expect(releaseIdempotency).not.toHaveBeenCalled();
    await run({ messageIndex: 8, idempotencyKey: 'k2' }, {}, makeDeps({ ...base, appendMessages: async () => { throw new Error('x'); } }));
    expect(releaseIdempotency).toHaveBeenCalledWith(OWNER, `branch|${SRC}|k2`);
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
