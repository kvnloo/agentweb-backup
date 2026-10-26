/**
 * ENG-2648: a branch is born with a COPY of its source's turns. Scoring, grading and the admin/analytics readers
 * must count only the branch's own turns, so a never-continued branch (or the hidden leftover of a failed copy)
 * is not a second scored/graded/listed session and a continued branch is not credited with its source's work.
 */
import { branchOwnMessages, buildBranchRows, type BranchOrigin } from '../services/agentMode/chatBranching';
import {
  BRANCH_CONTEXT_CLOSE_MARKER,
  BRANCH_CONTEXT_OPEN_MARKER,
  judgeCohortExclusion,
  judgeScoringPath,
  scoreSessionIfNeeded,
} from '../services/sessionScoringService';
import { buildLoadedSession, type DocItem } from '../loops/eval/agentGraderLoader';
import { agentModeService } from '../services/agentModeService';
import type { ChatMessage } from '../services/chatbotService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
    resolveGenerationModel: (m: string) => ({ model: m, fellBack: false, requestedModel: m }),
  },
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: jest.fn().mockResolvedValue({}),
    updateSessionJudgeScore: jest.fn().mockResolvedValue({}),
  },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const BRANCHED_AT = at(30);

/** Source: system, two complete turns (the first with a tool call), branched from the second reply (index 5). */
const SOURCE: ChatMessage[] = [
  { role: 'system', content: 'sys', messageIndex: 0 },
  { role: 'user', content: 'find leads', timestamp: at(1), metadata: { timestamp: at(1) }, messageIndex: 1 },
  { role: 'assistant', content: '', llm: 'model-a', metadata: { timestamp: at(2), toolCalls: [{ id: 'src-1', name: 'search_leads', arguments: {} }] }, messageIndex: 2 },
  { role: 'tool', content: '{"success":true}', tool_call_id: 'src-1', name: 'search_leads', metadata: { timestamp: at(2) }, messageIndex: 3 },
  { role: 'user', content: 'now draft the email', timestamp: at(3), metadata: { timestamp: at(3) }, messageIndex: 4 },
  { role: 'assistant', content: 'Here is the draft.', llm: 'model-a', metadata: { timestamp: at(4) }, messageIndex: 5 },
] as unknown as ChatMessage[];

const ORIGIN: BranchOrigin = { sourceSessionId: 'src', sourceMessageIndex: 5, branchedAt: BRANCHED_AT };
const COPY = buildBranchRows(SOURCE, 5, ORIGIN, BRANCHED_AT);

const OWN: ChatMessage[] = [
  { role: 'user', content: 'make it shorter', timestamp: at(40), metadata: { timestamp: at(40) } },
  { role: 'assistant', content: '', llm: 'model-b', metadata: { timestamp: at(41), toolCalls: [{ id: 'own-1', name: 'send_email', arguments: {} }] } },
  { role: 'tool', content: '{"success":true}', tool_call_id: 'own-1', name: 'send_email' },
  { role: 'assistant', content: 'Sent.', llm: 'model-b', metadata: { timestamp: at(42) } },
] as unknown as ChatMessage[];

const session = (messages: ChatMessage[]) => ({
  sessionId: 'branch-1',
  userId: 'u1',
  messages,
  messageCount: messages.length,
  createdAt: BRANCHED_AT,
  updatedAt: new Date().toISOString(),
}) as any;

describe('branchOwnMessages', () => {
  it('returns an ordinary (non-branch) history unchanged', () => {
    expect(branchOwnMessages(SOURCE)).toEqual(SOURCE);
  });

  it('a branch nobody continued (or a failed-copy leftover) has no own rows', () => {
    expect(branchOwnMessages(COPY)).toEqual([]);
    // a partial copy (the append died midway) is still nothing of its own
    expect(branchOwnMessages(COPY.slice(0, 3))).toEqual([]);
  });

  it('a continued branch: its own rows start at its first own user message', () => {
    expect(branchOwnMessages([...COPY, ...OWN])).toEqual(OWN);
  });

  it('an own user row with no timestamp still counts (it sits after the branched-from row)', () => {
    const untimed = { role: 'user', content: 'and translate it' } as ChatMessage;
    expect(branchOwnMessages([...COPY, untimed])).toEqual([untimed]);
  });

  it('a copied user row stamped after branchedAt (skewed source clock) is still a copy', () => {
    const skewed = COPY.map((m) => (m.role === 'user'
      ? { ...m, timestamp: at(35), metadata: { ...(m.metadata ?? {}), timestamp: at(35) } }
      : m)) as ChatMessage[];
    expect(branchOwnMessages(skewed)).toEqual([]);
    expect(branchOwnMessages([...skewed, ...OWN])).toEqual(OWN);
  });
});

describe('satisfaction scoring counts a branch by its own turns', () => {
  beforeEach(() => mockCallLLM.mockReset());

  it('a never-continued branch is outside both cohorts: no judge call, no score', async () => {
    expect(judgeCohortExclusion(session(COPY))).toEqual({ reason: 'no-user-message', retract: false });
    await expect(scoreSessionIfNeeded(session(COPY))).resolves.toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('a continued branch is still scored', async () => {
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ reason: 'ok', score: 4, dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 } }) } }],
    } as any);
    expect(judgeCohortExclusion(session([...COPY, ...OWN]))).toBeNull();
    await expect(scoreSessionIfNeeded(session([...COPY, ...OWN]))).resolves.toMatchObject({ score: 4 });
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('the judge scores only the own turns; the copied prefix is a marked context block before them', async () => {
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ reason: 'ok', score: 4, dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 } }) } }],
    } as any);
    await scoreSessionIfNeeded(session([...COPY, ...OWN]));
    const prompt = String((mockCallLLM.mock.calls[0][1] as any[])[1].content);
    const open = prompt.indexOf(BRANCH_CONTEXT_OPEN_MARKER);
    const close = prompt.indexOf(BRANCH_CONTEXT_CLOSE_MARKER);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    for (const copied of ['user: find leads', 'user: now draft the email', 'assistant: Here is the draft.']) {
      const at = prompt.indexOf(copied);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
      expect(prompt.indexOf(copied, close)).toBe(-1);
    }
    expect(prompt.indexOf('user: make it shorter')).toBeGreaterThan(close);
    expect(prompt.indexOf('assistant: Sent.')).toBeGreaterThan(close);
  });

  it('a non-branch transcript carries no copied-context block', async () => {
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ reason: 'ok', score: 4, dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 } }) } }],
    } as any);
    await scoreSessionIfNeeded(session(SOURCE));
    expect(String((mockCallLLM.mock.calls[0][1] as any[])[1].content)).not.toContain(BRANCH_CONTEXT_OPEN_MARKER);
  });

  it('turn state is the own turns\': an own question with no reply yet is in flight, not judged on the copied reply', async () => {
    const waiting = session([...COPY, OWN[0]]);
    expect(judgeScoringPath(waiting)).toBe('in-flight');
    await expect(scoreSessionIfNeeded(waiting)).resolves.toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});

describe('eval graders grade a branch by its own turns', () => {
  const rows = (messages: ChatMessage[]): DocItem[] =>
    messages.map((message, messageIndex) => ({ sessionId: 'branch-1', messageIndex, message: message as unknown as DocItem }));

  it('copied user turns are not graded again; the ledger stays the whole history (groundedness)', () => {
    const loaded = buildLoadedSession({ sessionId: 'branch-1' }, rows([...COPY, ...OWN]), [], undefined);
    expect(loaded.branchCopyOnly).toBeUndefined();
    expect(loaded.session.ledger.map((c) => c.id)).toEqual(['src-1', 'own-1']);
    expect(loaded.session.userTurns).toBe(1);
    expect((loaded.session.turns ?? []).map((t) => t.userText)).toEqual(['make it shorter']);
    expect(loaded.session.finalReply).toBe('Sent.');
  });

  it('a never-continued branch is flagged copy-only and has no own turns or reply', () => {
    const loaded = buildLoadedSession({ sessionId: 'branch-1' }, rows(COPY), [], undefined);
    expect(loaded.branchCopyOnly).toBe(true);
    expect(loaded.session.userTurns).toBe(0);
    expect(loaded.session.finalReply).toBeUndefined();
    expect(buildLoadedSession({ sessionId: 'src' }, rows(SOURCE), [], undefined).branchCopyOnly).toBeUndefined();
  });
});
