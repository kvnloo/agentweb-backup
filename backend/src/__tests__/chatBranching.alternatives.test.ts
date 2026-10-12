/**
 * ENG-113 - branching and saved Compare alternatives.
 *
 *  - a generic branch strips `compareAlternatives` / `compareId` / `compareAlternativesOmitted` from every copied row;
 *  - "Branch with this answer" (`alternativeModel`): the named assistant row keeps its place but its text and `llm`
 *    become the alternative's, the alternatives are removed, `branchedFromAlternative` is added and the new
 *    session's model is the alternative's. Every other branching guarantee is exercised by chatBranching.test.ts.
 * Runs against the real ChatbotDB over the in-memory DocumentClient, like chatBranching.test.ts.
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
import {
  branchChatSession,
  BranchDeps,
  buildBranchRows,
  __resetBranchIdempotencyForTests,
} from '../services/agentMode/chatBranching';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { COMPARE_ROW_CAP_BYTES, serializedBytes, withSavedAlternatives } from '../services/agentMode/compareSaveAlternatives';
import { MAX_MESSAGE_CONTENT_SIZE } from '../services/chatbotService';

const OWNER = 'user-owner';
const SRC = 'src-session-1';
const ts = '2026-10-01T00:00:00.000Z';

const ALTS = [
  { model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', content: 'Sonnet says A', latencyMs: 1200 },
  { model: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google', content: 'Gemini says B', latencyMs: 800 },
];

function rows(): ChatMessage[] {
  const m = (r: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage => ({ timestamp: ts, metadata: { timestamp: ts }, ...r }) as ChatMessage;
  return [
    m({ role: 'system', content: 'SYS' }),
    m({ role: 'user', content: 'Compare these' }),
    m({
      role: 'assistant', content: 'Chosen GPT answer', llm: 'gpt-5.5',
      metadata: { timestamp: ts, portalType: 'agent', compareId: 'cmp-1', compareAlternatives: ALTS },
    }),
    m({ role: 'user', content: 'Follow up' }),
    m({
      role: 'assistant', content: 'Second chosen', llm: 'gpt-5.5',
      metadata: { timestamp: ts, portalType: 'agent', compareId: 'cmp-2', compareAlternativesOmitted: 'size' },
    }),
    m({ role: 'user', content: 'And more' }),
    m({ role: 'assistant', content: 'Plain reply', llm: 'gpt-5.5' }),
  ];
}

function seed(r: ChatMessage[] = rows()) {
  mockFake.seedSession({
    sessionId: SRC, userId: OWNER, title: 'Cmp', createdAt: ts, updatedAt: ts, adminListPartition: 'all',
    portalType: 'agent', pageIdentifier: 'agent-mode', sessionType: 'regular', llmModel: 'gpt-5.5', messageCount: r.length, messages: [],
  });
  mockFake.seedMessages(SRC, r);
}

const claimed = new Set<string>();
function makeDeps(over: Partial<BranchDeps> = {}): BranchDeps {
  return {
    isAcceptingWork: () => true,
    isFeatureEnabled: async () => true,
    getSession: (id, opts) => chatbotDb.getChatSession(id, opts?.consistentRead === true),
    tryClaim: (id) => { if (claimed.has(id)) return false; claimed.add(id); return true; },
    release: (id) => { claimed.delete(id); },
    resolveModel: async ({ requestedModel, explicit }) => ({
      ok: true,
      model: requestedModel || 'gpt-5.5',
      policy: {
        requestedModel: requestedModel || null, effectiveModel: requestedModel || 'gpt-5.5', backupModel: null, backupSource: null,
        modelSelection: explicit ? 'honored' : 'defaulted', modelSelectionReason: 'test', usageMode: 'full_choice', usagePolicyVersion: null, recordedAt: ts,
      },
    }),
    createSession: (a) =>
      chatbotDb.createChatSession(a.userId, undefined, a.portalType, a.pageIdentifier, a.selectedStartupId, undefined, undefined, undefined, 'regular', a.delegateInfo, a.initialState),
    setModel: (id, model, policy) => chatbotDb.updateSessionLlmModel(id, model, policy),
    setTitle: (id, title) => chatbotDb.updateSessionTitle(id, title),
    appendMessages: (id, messages) => chatbotDb.addMessagesToSession(id, messages),
    unarchiveSession: (id) => chatbotDb.unarchiveSession(id),
    getMaxBranchesPerHour: async () => 30,
    sleep: async () => undefined,
    adminToolNames: [],
    maxSessionMessages: MAX_MESSAGE_SIZE_PER_SESSION,
    now: () => Date.parse('2026-10-08T12:00:00.000Z'),
    log: () => undefined,
    ...over,
  };
}

const run = (body: unknown, deps: BranchDeps = makeDeps()) =>
  branchChatSession(deps, { user: { userId: OWNER }, viewerIsAdmin: false, sessionId: SRC, body });
const msgs = (id: string) => mockFake.rows(id).map((r) => r.message as any);
const newIds = () => mockFake.sessionIds().filter((id) => id !== SRC);
const out = (o: { body: unknown }) => o.body as any;

beforeEach(() => {
  mockFake.tables.clear();
  mockFake.dropMessageIndexes.clear();
  mockFake.writeLog.length = 0;
  claimed.clear();
  __resetBranchIdempotencyForTests();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('generic branch strips saved alternatives from copied rows', () => {
  it('copies the chosen answer but no compareAlternatives / compareId / marker', async () => {
    seed();
    const res = await run({ messageIndex: 6 });
    expect(res.status).toBe(201);
    const copied = msgs(out(res).sessionId);
    expect(copied).toHaveLength(7);
    for (const row of copied) {
      expect(row.metadata ?? {}).not.toHaveProperty('compareAlternatives');
      expect(row.metadata ?? {}).not.toHaveProperty('compareId');
      expect(row.metadata ?? {}).not.toHaveProperty('compareAlternativesOmitted');
    }
    expect(copied[2].content).toBe('Chosen GPT answer');
    expect(copied[2].llm).toBe('gpt-5.5');
    expect(JSON.stringify(copied)).not.toContain('Sonnet says A');
    // The SOURCE keeps its alternatives.
    expect(msgs(SRC)[2].metadata.compareAlternatives).toHaveLength(2);
  });

  it('buildBranchRows strips the keys with no replacement given (pure)', () => {
    const built = buildBranchRows(rows().map((r, i) => ({ ...r, messageIndex: i })), 2, { sourceSessionId: SRC, sourceMessageIndex: 2, branchedAt: ts }, ts);
    expect(JSON.stringify(built)).not.toContain('compareAlternatives');
  });
});

describe('Branch with this answer (alternativeModel)', () => {
  it('replaces the target row text + llm, removes alternatives, stamps branchedFromAlternative, sets the session model', async () => {
    seed();
    const res = await run({ messageIndex: 2, alternativeModel: 'claude-sonnet-4-6' });
    expect(res.status).toBe(201);
    const id = out(res).sessionId;
    const copied = msgs(id);
    expect(copied).toHaveLength(3); // rows 0..2
    expect(copied[0].content).toBe('SYS');
    expect(copied[1].content).toBe('Compare these');
    expect(copied[2]).toMatchObject({ role: 'assistant', content: 'Sonnet says A', llm: 'claude-sonnet-4-6' });
    expect(copied[2].metadata.branchedFromAlternative).toEqual({ model: 'claude-sonnet-4-6' });
    expect(copied[2].metadata).not.toHaveProperty('compareAlternatives');
    expect(copied[2].metadata).not.toHaveProperty('compareId');
    expect(JSON.stringify(copied)).not.toContain('Gemini says B');
    expect(JSON.stringify(copied)).not.toContain('Chosen GPT answer');
    expect(mockFake.session(id)!.llmModel).toBe('claude-sonnet-4-6');
    expect(out(res).llmModel).toBe('claude-sonnet-4-6');
    // the source is untouched
    expect(msgs(SRC)[2].content).toBe('Chosen GPT answer');
    expect(msgs(SRC)[2].metadata.compareAlternatives).toHaveLength(2);
  });

  it('later rows of the prefix are copied as today (earlier rows with alternatives stay stripped)', async () => {
    seed();
    const res = await run({ messageIndex: 6 });
    expect(res.status).toBe(201);
    const withAlt = await run({ messageIndex: 2, alternativeModel: 'gemini-3.5-flash' });
    expect(msgs(out(withAlt).sessionId)[2].content).toBe('Gemini says B');
  });

  it('asks the model resolver for the alternative model as an explicit choice (entitlement/usage policy)', async () => {
    seed();
    const resolveModel = jest.fn(async () => ({ ok: false as const, outcome: { status: 403, body: { code: 'model_not_entitled' } } }));
    const res = await run({ messageIndex: 2, alternativeModel: 'claude-sonnet-4-6' }, makeDeps({ resolveModel }));
    expect(resolveModel).toHaveBeenCalledWith({ userId: OWNER, requestedModel: 'claude-sonnet-4-6', explicit: true });
    expect(res.status).toBe(403);
    expect(newIds()).toEqual([]);
  });

  it('a model that is not among the saved alternatives -> 400 alternative_not_found, nothing created', async () => {
    seed();
    const res = await run({ messageIndex: 2, alternativeModel: 'gpt-5.5' }); // the chosen one is not an alternative
    expect(res.status).toBe(400);
    expect(out(res).code).toBe('alternative_not_found');
    expect(newIds()).toEqual([]);
    expect(claimed.size).toBe(0);
    const res2 = await run({ messageIndex: 2, alternativeModel: 'nope/unknown' });
    expect(out(res2).code).toBe('alternative_not_found');
    expect(newIds()).toEqual([]);
  });

  it.each([[4, 'size marker only'], [6, 'plain reply']])('a message with no saved alternatives (%s: %s) -> 400 no_saved_alternatives', async (idx) => {
    seed();
    const res = await run({ messageIndex: idx, alternativeModel: 'claude-sonnet-4-6' });
    expect(res.status).toBe(400);
    expect(out(res).code).toBe('no_saved_alternatives');
    expect(newIds()).toEqual([]);
  });

  it('only an assistant message can be targeted (user row -> existing 400)', async () => {
    seed();
    const res = await run({ messageIndex: 1, alternativeModel: 'claude-sonnet-4-6' });
    expect(res.status).toBe(400);
    expect(out(res).code).toBe('message_not_branchable');
  });

  it.each([[{ alternativeModel: 5 }], [{ alternativeModel: 'x'.repeat(300) }], [{ alternativeModel: 'claude-sonnet-4-6', llmModel: 'gpt-5.5' }]])(
    'malformed or contradictory %j -> 400 invalid_request',
    async (extra) => {
      seed();
      const res = await run({ messageIndex: 2, ...extra });
      expect(res.status).toBe(400);
      expect(out(res).code).toBe('invalid_request');
      expect(newIds()).toEqual([]);
    },
  );

  it('idempotency: same key + same alternative replays; a different alternative (or none) is a different branch', async () => {
    seed();
    const deps = makeDeps();
    const a = await run({ messageIndex: 2, alternativeModel: 'claude-sonnet-4-6', idempotencyKey: 'k' }, deps);
    expect(a.status).toBe(201);
    const again = await run({ messageIndex: 2, alternativeModel: 'claude-sonnet-4-6', idempotencyKey: 'k' }, deps);
    expect(again.status).toBe(200);
    expect(out(again).sessionId).toBe(out(a).sessionId);
    const other = await run({ messageIndex: 2, alternativeModel: 'gemini-3.5-flash', idempotencyKey: 'k' }, deps);
    expect(other.status).toBe(201);
    expect(out(other).sessionId).not.toBe(out(a).sessionId);
    const plain = await run({ messageIndex: 2, idempotencyKey: 'k' }, deps);
    expect(plain.status).toBe(201);
    expect(out(plain).sessionId).not.toBe(out(a).sessionId);
    expect(msgs(out(plain).sessionId)[2].content).toBe('Chosen GPT answer');
  });

  it('the run-store scope names the alternative; without one it is unchanged', async () => {
    seed();
    const scopes: string[] = [];
    const deps = makeDeps({ claimIdempotency: async (_u, scope) => { scopes.push(scope); return { claimed: true }; }, recordIdempotencySessionId: async () => undefined, releaseIdempotency: async () => undefined });
    await run({ messageIndex: 2, idempotencyKey: 'k', alternativeModel: 'claude-sonnet-4-6' }, deps);
    await run({ messageIndex: 2, idempotencyKey: 'k2' }, deps);
    expect(JSON.parse(scopes[0])).toEqual(['branch', SRC, 2, '', 'k', 'claude-sonnet-4-6']);
    expect(JSON.parse(scopes[1])).toEqual(['branch', SRC, 2, '', 'k2']);
  });

  it('keeps the guarantees: source lock released, non-owner 403, branch revealed (not archived)', async () => {
    seed();
    const res = await run({ messageIndex: 2, alternativeModel: 'claude-sonnet-4-6' });
    expect(claimed.size).toBe(0);
    expect(mockFake.session(out(res).sessionId)!.archived).toBeUndefined();
    const stranger = await branchChatSession(makeDeps(), { user: { userId: 'someone-else' }, viewerIsAdmin: false, sessionId: SRC, body: { messageIndex: 2, alternativeModel: 'claude-sonnet-4-6' } });
    expect(stranger.status).toBe(403);
  });
});

describe('Branch with this answer keeps the family link (ENG-112 branchedFrom, root preserved)', () => {
  it('writes branchedFrom on the new session and the family endpoint helper lists it', async () => {
    seed();
    const first = out(await run({ messageIndex: 2, alternativeModel: 'claude-sonnet-4-6' }));
    expect(mockFake.session(first.sessionId)!.branchedFrom).toEqual({
      sessionId: SRC, rootSessionId: SRC, messageIndex: 2, branchedAt: '2026-10-08T12:00:00.000Z',
    });
    expect(mockFake.session(SRC)!.branchedFrom).toBeUndefined();
    // a branch-with-alternative OF that branch keeps the ORIGINAL root
    mockFake.seedMessages(first.sessionId, rows()); // give the branch enough rows to branch from again
    const second = out(
      await branchChatSession(makeDeps(), { user: { userId: OWNER }, viewerIsAdmin: false, sessionId: first.sessionId, body: { messageIndex: 2, alternativeModel: 'claude-sonnet-4-6' } }),
    );
    expect(second.sessionId).toBeDefined();
    expect(mockFake.session(second.sessionId)!.branchedFrom).toMatchObject({ sessionId: first.sessionId, rootSessionId: SRC });
  });
});

describe('a later feedback write never damages an accepted Compare row', () => {
  const alts = ALTS.map((a) => ({ ...a }));
  const rowAt = (bytes: number): ChatMessage => {
    const mk = (n: number) =>
      withSavedAlternatives(
        { role: 'assistant', content: 'x'.repeat(n), timestamp: ts, llm: 'gpt-5.5', metadata: { timestamp: ts, portalType: 'agent' } } as ChatMessage,
        'cmp-1',
        alts,
      );
    return mk(bytes - serializedBytes(mk(0)));
  };

  it('the accepted-row cap leaves headroom under the real persistence cap', () => {
    expect(COMPARE_ROW_CAP_BYTES).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_SIZE - 8_192);
  });

  it('a row accepted at exactly the cap survives updateMessageFeedback with content AND alternatives unchanged', async () => {
    const row = rowAt(COMPARE_ROW_CAP_BYTES);
    expect(serializedBytes(row)).toBe(COMPARE_ROW_CAP_BYTES);
    expect(row.metadata!.compareAlternatives).toHaveLength(2);
    mockFake.seedSession({ sessionId: 'fb', userId: OWNER, title: 't', createdAt: ts, updatedAt: ts, messageCount: 1, messages: [] });
    mockFake.seedMessages('fb', [row]);
    const updated = await chatbotDb.updateMessageFeedback('fb', 0, {
      type: 'like', comment: 'great answer, thanks '.repeat(20), timestamp: ts, userId: OWNER,
    } as any);
    expect(updated.content).toBe(row.content);
    expect(updated.metadata!.compareAlternatives).toEqual(alts);
    expect(updated.metadata!.compareId).toBe('cmp-1');
    expect((updated.metadata as any).feedback.type).toBe('like');
    const stored = msgs('fb')[0];
    expect(stored.content).toBe(row.content);
    expect(stored.metadata.compareAlternatives).toEqual(alts);
  });

  it('one byte over the cap => alternatives omitted with the size marker, chosen answer intact', () => {
    const chars = COMPARE_ROW_CAP_BYTES + 1 - (serializedBytes(rowAt(COMPARE_ROW_CAP_BYTES)) - rowAt(COMPARE_ROW_CAP_BYTES).content.length);
    const over = rowAt(COMPARE_ROW_CAP_BYTES + 1);
    expect(over.content).toBe('x'.repeat(chars));
    expect(over.metadata).not.toHaveProperty('compareAlternatives');
    expect(over.metadata!.compareAlternativesOmitted).toBe('size');
  });
});
