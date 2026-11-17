/**
 * ENG-2645 (security invariant): a share-link viewer gets exactly what its page reads, never the session record.
 *
 * Production, 2026-10-23: an unauthenticated GET /api/agent-mode/share/:id returned ~148 KB — the stored system prompt
 * (row 0), every assistant row's reasoning / reasoning_details / usage / refusal, the owner's whole authorized skills
 * catalog (incl. private skills and the admin bundle), the owner's supportNote (the admin's internal note about
 * the account) and Slack thread, and
 * interactiveShareMetadata, whose token is the conversable credential.
 *
 * Pinned here, for both public views:
 *   - read-only  (/share/:id, portal ShareConversation.tsx): only sessionId/title/messages/workPlan/pendingApprovalDeck;
 *     no system rows; user/assistant rows carry role, content and the five metadata keys the page renders.
 *   - conversable (/ishare/:id?conversable=…, portal AgentMode.tsx + the landing-page status poll): no system prompt
 *     text, no provider fields, no catalog/admin skills, no share metadata — and every field the chat renders is kept,
 *     with system rows kept as empty placeholders so the page's row counting/keys are unchanged.
 *   - the conversable generate and feedback responses do not reopen either leak.
 * Review round (PR #3735): no supportNote on either view; feedback without the rater's userId; the first-attempt
 * telemetry placeholder carries no isErrorMessage (the landing-page poll would mark a retrying run failed) while
 * real failure rows keep it; server-authored user rows (auto-continuation / approval-inbox resume) are not shown
 * as customer bubbles on the read-only page.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionShareMetadata: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));
jest.mock('../services/agentModeService', () => ({
  ADMIN_SKILL_TOOL_NAMES: ['get_pr_digest', 'manage_user_notes'],
  ADMIN_SKILL_VIRTUAL_ID: '__admin_tools__',
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    getSkillsForDisplay: jest.fn(),
  },
}));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn().mockReturnValue(true), has: jest.fn().mockReturnValue(false), add: jest.fn() },
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  emitProgress: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10',
  }),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { userDb } from '../services/db';
import { agentModeController } from '../controllers/agentModeController';

const SESSION_ID = 'share-session-2645';
const TOKEN = 'conversable-token-2645';
const SYSTEM_PROMPT = 'You are Emma. INTERNAL SYSTEM PROMPT — never shown to a share viewer.';
const TELEMETRY = '[telemetry] First-attempt agent failure (retry will follow): boom | ctx: {"errorName":"Err"}';
const CONTINUATION = 'INTERNAL DIRECTIVE: continue generating the remaining media';
const INBOX_RESUME = 'INTERNAL DIRECTIVE: approval inbox decision resolved';

const deck = {
  deckId: 'deck-1',
  status: 'awaiting',
  items: [{ itemId: 'q1', kind: 'plan_choice', question: 'Which?', options: [{ id: 'a', label: 'A' }] }],
  createdAt: '2026-10-23T00:00:00.000Z',
};

const assistantToolCalls = [{ id: 'tc1', name: 'you_search_web', arguments: { q: 'x' }, result: { results: [] } }];

function storedSession() {
  return {
    sessionId: SESSION_ID,
    userId: 'owner-user',
    title: 'Shared chat',
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T01:00:00Z',
    llmModel: 'gpt-5-chat-2',
    associatedSkills: ['skill-installed', '__admin_tools__'],
    slackThread: { channel: 'C123', threadTs: '1700000000.000100' },
    pendingWorkPlanInput: { requestId: 'r1', fields: [] },
    pendingApprovalDeck: deck,
    shareMetadata: { isShared: true, sharedAt: '2026-10-23T00:00:00Z' },
    interactiveShareMetadata: { isActive: true, token: TOKEN, sharedAt: '2026-10-23T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    workPlan: { title: 'Plan', createdAt: 'x', updatedAt: 'x', steps: [{ stepCount: 1, title: 'Research', status: 'pending' }] },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT, messageIndex: 0, metadata: { timestamp: 't0', portalType: 'agent', systemPromptVersion: 'hash' } },
      {
        role: 'user', content: 'Hello Emma', messageIndex: 1, clientId: 'client-1', timestamp: 't1',
        metadata: {
          timestamp: 't1',
          attachments: [{ url: 'https://s3/a.png', filename: 'a.png', size: 10, mimetype: 'image/png', uploadedAt: 't1' }],
          ishareSender: { isAnonymous: true, ip: '203.0.113.9', userAgent: 'Visitor UA' },
        },
      },
      {
        role: 'system', content: 'Image uploaded: a.png', messageIndex: 2, timestamp: 't2',
        metadata: {
          timestamp: 't2', portalType: 'agent',
          toolCalls: [{ id: 'u1', name: 'upload_image', arguments: {}, result: { success: true, imageUrl: 'https://s3/a.png', filename: 'a.png' } }],
        },
      },
      {
        role: 'assistant', content: 'Here is what I found {{cite:1}}', messageIndex: 3, timestamp: 't3', llm: 'gpt-5-chat-2',
        modelCorrection: { requestedModel: 'opus', effectiveModel: 'gpt-5-chat-2' },
        reasoning: 'SECRET CHAIN OF THOUGHT', reasoning_details: [{ type: 'reasoning.text', text: 'SECRET DETAIL' }],
        usage: { prompt_tokens: 101000, completion_tokens: 50, total_tokens: 101050, estimated_cost: 0.42 },
        refusal: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'you_search_web', arguments: '{}' } }],
        metadata: {
          timestamp: 't3',
          toolCalls: assistantToolCalls,
          citations: [{ id: 1, url: 'https://example.com', domain: 'example.com', siteName: 'Example' }],
          suggestedReplies: ['Tell me more'],
          feedback: { type: 'like', timestamp: 't4', userId: 'owner-user' },
          pendingApprovalDeckId: 'deck-1',
          approvalDeckItems: deck.items,
          awaitingUserConfirmation: true,
          crmEvidence: { tools: ['crm'], numbers: [7] },
          relevantChunks: { count: 2, sources: ['internal-doc.pdf'] },
        },
      },
      { role: 'tool', name: 'you_search_web', tool_call_id: 'tc1', content: '{"raw":"tool output"}', messageIndex: 4 },
      { role: 'system', content: TELEMETRY, messageIndex: 5, metadata: { timestamp: 't5', isErrorMessage: true } },
      { role: 'user', content: CONTINUATION, messageIndex: 6, metadata: { timestamp: 't6', kind: 'auto-continuation' } },
      { role: 'assistant', content: 'I encountered an error.', messageIndex: 7, metadata: { timestamp: 't7', isErrorMessage: true } },
      { role: 'user', content: INBOX_RESUME, messageIndex: 8, metadata: { timestamp: 't8', kind: 'approval-inbox-resolution' } },
    ],
  };
}

const catalog = [
  { skillId: 'skill-installed', name: 'Research', description: 'Web research', installed: true, toolNames: ['you_search_web'], visibility: 'public' },
  { skillId: 'skill-private', name: 'Owner Private Skill', description: 'private', installed: false, toolNames: ['private_tool'], visibility: 'private' },
  { skillId: '__other_skills__', name: 'Other Skills', description: 'Tools not associated', installed: false, toolNames: ['loose_tool'] },
  { skillId: '__admin_tools__', name: 'Admin Tools', description: 'admin', installed: true, toolNames: ['get_pr_digest', 'manage_user_notes'] },
];

const makeRes = () => {
  const r = {} as Record<string, jest.Mock>;
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r as unknown as Response & { status: jest.Mock; json: jest.Mock };
};

async function getShare(query: Record<string, string>) {
  const res = makeRes();
  await agentModeController.getSharedConversation({ params: { shareId: SESSION_ID }, query } as unknown as Request, res);
  expect(res.status).toHaveBeenCalledWith(200);
  return res.json.mock.calls[0][0].session;
}

let stored: ReturnType<typeof storedSession>;
let getUserById: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  stored = storedSession();
  (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(stored);
  (agentModeService.getDefaultModel as jest.Mock).mockResolvedValue('gpt-5-chat-2');
  (agentModeService.getSkillsForDisplay as jest.Mock).mockResolvedValue(catalog);
  getUserById = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'owner-user', supportNote: 'Acme Corp' } as unknown as Awaited<ReturnType<typeof userDb.getUserById>>);
});

afterEach(() => getUserById.mockRestore());

describe('ENG-2645 read-only share (/share/:id)', () => {
  it('returns only what ShareConversation reads — no system prompt, provider fields, skills, owner or share metadata', async () => {
    const session = await getShare({});

    expect(Object.keys(session).sort()).toEqual(['messages', 'pendingApprovalDeck', 'sessionId', 'title', 'workPlan']);
    const json = JSON.stringify(session);
    for (const secret of [SYSTEM_PROMPT, TELEMETRY, 'SECRET CHAIN OF THOUGHT', 'SECRET DETAIL', TOKEN, 'Acme Corp', 'C123',
      'Owner Private Skill', 'get_pr_digest', '203.0.113.9', 'internal-doc.pdf', 'tool output', CONTINUATION, INBOX_RESUME]) {
      expect(json).not.toContain(secret);
    }
    for (const field of ['"reasoning"', '"reasoning_details"', '"usage"', '"refusal"', '"tool_calls"', '"skills"',
      '"supportNote"', '"slackThread"', '"shareMetadata"', '"interactiveShareMetadata"', '"llmModel"']) {
      expect(json).not.toContain(field);
    }
    expect(session.messages.some((m: { role: string }) => m.role !== 'user' && m.role !== 'assistant')).toBe(false);
    // The catalog and the owner record are not even read for this view.
    expect(agentModeService.getSkillsForDisplay).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('keeps every field the page renders', async () => {
    const session = await getShare({});

    expect(session).toMatchObject({ sessionId: SESSION_ID, title: 'Shared chat', pendingApprovalDeck: deck });
    expect(session.workPlan.steps[0]).toMatchObject({ stepCount: 1, title: 'Research', status: 'pending' });
    expect(session.messages).toEqual([
      { role: 'user', content: 'Hello Emma', metadata: { timestamp: 't1', attachments: stored.messages[1].metadata!.attachments } },
      {
        role: 'assistant',
        content: 'Here is what I found {{cite:1}}',
        metadata: {
          timestamp: 't3',
          toolCalls: assistantToolCalls,
          citations: stored.messages[3].metadata!.citations,
          pendingApprovalDeckId: 'deck-1',
        },
      },
      // A real failure row is a real assistant bubble on the page.
      { role: 'assistant', content: 'I encountered an error.', metadata: { timestamp: 't7' } },
    ]);
  });

  it('serves the read-only shape whenever no conversable token is presented (the /ishare route included)', async () => {
    const session = await getShare({});
    expect(session).not.toHaveProperty('interactiveShareMetadata');
    expect(JSON.stringify(session)).not.toContain(TOKEN);
  });
});

describe('ENG-2645 conversable share (/ishare/:id?conversable=…)', () => {
  it('never sends the system prompt, provider fields, catalog, admin skills or share metadata', async () => {
    const session = await getShare({ conversable: TOKEN });

    expect(Object.keys(session).sort()).toEqual([
      'createdAt', 'hasActiveProgress', 'llmModel', 'messages', 'pendingApprovalDeck', 'pendingWorkPlanInput', 'sessionId',
      'skills', 'slackThread', 'title', 'updatedAt', 'workPlan',
    ]);
    const json = JSON.stringify(session);
    for (const secret of [SYSTEM_PROMPT, TELEMETRY, 'SECRET CHAIN OF THOUGHT', 'SECRET DETAIL', 'Owner Private Skill', 'Acme Corp',
      'Admin Tools', 'get_pr_digest', 'loose_tool', '203.0.113.9', 'Visitor UA', 'internal-doc.pdf', 'tool output', 'systemPromptVersion']) {
      expect(json).not.toContain(secret);
    }
    for (const field of ['"reasoning"', '"reasoning_details"', '"usage"', '"refusal"', '"tool_calls"', '"ishareSender"',
      '"crmEvidence"', '"shareMetadata"', '"interactiveShareMetadata"', '"visibility"', '"supportNote"', '"userId"']) {
      expect(json).not.toContain(field);
    }
    // supportNote is the admin's internal note: the owner record is not even read for a viewer.
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('keeps every field the chat renders, and system rows as empty placeholders in place', async () => {
    const session = await getShare({ conversable: TOKEN });

    expect(session).toMatchObject({
      sessionId: SESSION_ID, title: 'Shared chat', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T01:00:00Z',
      llmModel: 'gpt-5-chat-2', hasActiveProgress: false,
      slackThread: { channel: 'C123', threadTs: '1700000000.000100' },
      pendingWorkPlanInput: { requestId: 'r1', fields: [] }, pendingApprovalDeck: deck,
    });
    expect(session.skills).toEqual([
      { skillId: 'skill-installed', name: 'Research', description: 'Web research', installed: true, toolNames: ['you_search_web'] },
    ]);

    // Same rows the non-owner filter keeps (only the tool row is gone), same order and messageIndex.
    expect(session.messages.map((m: { role: string; messageIndex: number }) => [m.role, m.messageIndex])).toEqual([
      ['system', 0], ['user', 1], ['system', 2], ['assistant', 3], ['system', 5], ['user', 6], ['assistant', 7], ['user', 8],
    ]);
    const [prompt, user, upload, assistant, telemetry, continuation, failure] = session.messages;
    expect(prompt).toEqual({ role: 'system', content: '', messageIndex: 0, metadata: { timestamp: 't0' } });
    // The landing-page status poll marks the run failed on any row with isErrorMessage: the first-attempt
    // telemetry row only means "a retry follows", so its placeholder does not carry the flag …
    expect(telemetry).toEqual({ role: 'system', content: '', messageIndex: 5, metadata: { timestamp: 't5' } });
    // … while a real failure row keeps it.
    expect(failure).toEqual({
      role: 'assistant', content: 'I encountered an error.', messageIndex: 7, metadata: { timestamp: 't7', isErrorMessage: true },
    });
    // The chat renders an auto-continuation row as a divider from its kind, so the conversable view keeps it.
    expect(continuation).toEqual({ role: 'user', content: CONTINUATION, messageIndex: 6, metadata: { timestamp: 't6', kind: 'auto-continuation' } });
    // A successful upload row is rendered by ChatMessageItem, so it is kept whole.
    expect(upload).toEqual({
      role: 'system', content: 'Image uploaded: a.png', messageIndex: 2,
      metadata: { timestamp: 't2', toolCalls: stored.messages[2].metadata!.toolCalls },
    });
    expect(user).toEqual({
      role: 'user', content: 'Hello Emma', messageIndex: 1, clientId: 'client-1',
      metadata: { timestamp: 't1', attachments: stored.messages[1].metadata!.attachments },
    });
    const am = stored.messages[3].metadata!;
    expect(am.feedback).toEqual({ type: 'like', timestamp: 't4', userId: 'owner-user' });
    expect(assistant).toEqual({
      role: 'assistant', content: 'Here is what I found {{cite:1}}', messageIndex: 3, llm: 'gpt-5-chat-2',
      modelCorrection: { requestedModel: 'opus', effectiveModel: 'gpt-5-chat-2' },
      metadata: {
        timestamp: 't3', toolCalls: assistantToolCalls, citations: am.citations, suggestedReplies: ['Tell me more'],
        // The rater's userId is not sent; MessageFeedbackButtons reads the type.
        feedback: { type: 'like', timestamp: 't4' }, pendingApprovalDeckId: 'deck-1', approvalDeckItems: deck.items, awaitingUserConfirmation: true,
      },
    });
  });

  it('shapes a copy: the stored session (system prompt included, which generation reads) is untouched', async () => {
    const snapshot = JSON.parse(JSON.stringify(stored));
    await getShare({ conversable: TOKEN });
    await getShare({});
    expect(stored).toEqual(snapshot);
    expect(stored.messages[0].content).toBe(SYSTEM_PROMPT);
  });

  it('a wrong token is still refused before anything is shaped', async () => {
    const res = makeRes();
    await agentModeController.getSharedConversation(
      { params: { shareId: SESSION_ID }, query: { conversable: 'wrong' } } as unknown as Request, res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(agentModeService.getSkillsForDisplay).not.toHaveBeenCalled();
  });
});

describe('ENG-2645 conversable generate (/ishare/:id/generate)', () => {
  it('returns this session’s installed skills only — never the owner catalog or the admin bundle', async () => {
    (generateMarketingResponseWorkerService.runInWorker as jest.Mock).mockResolvedValue({
      content: 'Done', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [],
    });
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    const res = makeRes();
    await agentModeController.generateSharedResponse({
      params: { shareId: SESSION_ID },
      query: { conversable: TOKEN },
      body: { userMessage: 'Next step please', attachments: [] },
      ip: '203.0.113.42',
      headers: { 'user-agent': 'Test' },
    } as unknown as Request, res);

    expect(res.status).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.content).toBe('Done');
    expect(body.skills).toEqual([
      { skillId: 'skill-installed', name: 'Research', description: 'Web research', installed: true, toolNames: ['you_search_web'] },
    ]);
  });
});
