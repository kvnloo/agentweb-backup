/**
 * ENG-2962: submitApprovalDeckAnswers decides "may a self-call approve this?" on the deck it is about to apply (the same deck its
 * conditional write targets), not on an earlier read in the route that could lag behind.
 */
const mockGetChatSession = jest.fn();
const mockUpdateDeck = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: (...a: any[]) => mockGetChatSession(...a),
    updateSessionApprovalDeck: (...a: any[]) => mockUpdateDeck(...a),
  },
}));

import { AgentModeService } from '../services/agentModeService';

const deck = (kind: string, extra: Record<string, unknown> = {}) => ({
  deckId: 'deck-9',
  status: 'awaiting',
  items: [{ itemId: 'question-1', kind, question: 'Approve?', options: [{ id: 'approve', label: 'Approve' }, { id: 'decline', label: 'Decline' }], ...extra }],
  createdAt: '2026-11-13T00:00:00.000Z',
  finalizedAt: '2026-11-13T00:00:01.000Z',
});

// The real method, with only what it touches stubbed.
const submit = (answers: any[], options?: any, expected = 'deck-9') =>
  (AgentModeService.prototype as any).submitApprovalDeckAnswers.call(
    { resumeStuckApprovalDeckWorkflowRun: jest.fn(async () => undefined) },
    'sess-1', expected, answers, 'user', options,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateDeck.mockResolvedValue(null); // conflict: stops the flow right after the check, before any execution
});

describe('submitApprovalDeckAnswers person-only guard (ENG-2962)', () => {
  it.each<[string, string, Record<string, unknown>?]>([
    ['smartlead_push_approval:start:abc:0123456789abcdef', 'approve'],
    ['hot_lead_call_approval:call:abc:0123456789abcdef', 'approve'],
    ['crm_sequence_activation:seq-1:tok', 'activate'],
    ['meta_write', 'approve', { metaWriteDispatch: { action: 'CREATE_PAUSED_BUNDLE' } }],
  ])('a self-call approving %s on the pending deck is refused and nothing is written', async (kind, verdict, extra = {}) => {
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'u-1', pendingApprovalDeck: deck(kind, extra) });
    const out = await submit([{ itemId: 'question-1', verdict }], { refusePersonOnlyApprovals: true });
    expect(out).toMatchObject({ outcome: 'needs_person' });
    expect(mockUpdateDeck).not.toHaveBeenCalled();
  });

  it('a self-call may decline a person-only card', async () => {
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'u-1', pendingApprovalDeck: deck('smartlead_push_approval:start:abc:0123456789abcdef') });
    const out = await submit([{ itemId: 'question-1', verdict: 'decline' }], { refusePersonOnlyApprovals: true });
    expect(out.outcome).not.toBe('needs_person');
    expect(mockUpdateDeck).toHaveBeenCalled();
  });

  it('without the option (a person in the app) the same approval is applied', async () => {
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'u-1', pendingApprovalDeck: deck('smartlead_push_approval:start:abc:0123456789abcdef') });
    const out = await submit([{ itemId: 'question-1', verdict: 'approve' }]);
    expect(out.outcome).not.toBe('needs_person');
    expect(mockUpdateDeck).toHaveBeenCalled();
  });

  it('a self-call may approve a card that is not person-only', async () => {
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'u-1', pendingApprovalDeck: deck('plan_choice') });
    const out = await submit([{ itemId: 'question-1', verdict: 'approve' }], { refusePersonOnlyApprovals: true });
    expect(out.outcome).not.toBe('needs_person');
    expect(mockUpdateDeck).toHaveBeenCalled();
  });
});
