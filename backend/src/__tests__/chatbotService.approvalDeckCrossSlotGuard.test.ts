/**
 * ENG-1635/1644 gap 6 — the 3-way cross-slot guard across the session's
 * three human-interrupt slots (pendingUserQuestion, pendingWorkPlanInput,
 * pendingApprovalDeck). Round 2 of the plan's critical verification found
 * the pre-existing 2-slot pattern was NOT already symmetric —
 * updateSessionAskUserQuestion's guard checked only its own field, so a
 * question could open while a work-plan-input was already awaiting even
 * though the reverse direction was already refused. This file proves all
 * three guards now cross-check the OTHER two, not just inherit an assumed
 * pattern.
 *
 * Same style as chatbotService.workflowRun.test.ts: spies on the exported
 * DynamoDB client and asserts on the CONSTRUCTED ConditionExpression, so the
 * guard's own body is actually exercised rather than mocked away.
 */

import { chatbotDb, dynamodb } from '../services/chatbotService';
import { buildPendingUserQuestion } from '../services/agentMode/core/askUserQuestion';
import { createApprovalDeck, appendApprovalDeckItem, finalizeApprovalDeck } from '../services/agentMode/core/approvalDeck';

function sampleQuestion() {
  return buildPendingUserQuestion({
    questionId: 'q-1',
    question: 'Which objective?',
    options: [
      { id: 'a', label: 'A', consequence: 'x' },
      { id: 'b', label: 'B', consequence: 'y', recommended: true, why: 'z' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

function sampleFinalizedDeck() {
  let deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
  deck = appendApprovalDeckItem(deck, {
    itemId: 'write-1', kind: 'meta_write', question: 'Approve this write?',
    metaWriteManifestDigest: 'digest-1', metaWriteDispatch: { entity_type: 'AD', action: 'UPDATE', account_id: 'a', params: {} },
  });
  return finalizeApprovalDeck(deck, '2026-01-01T00:00:01.000Z');
}

describe('ENG-1635/1644 gap 6 — 3-way cross-slot guard', () => {
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('updateSessionAskUserQuestion cross-checks ALL THREE slots, not just its own', async () => {
    await chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion(), { failIfAwaitingExists: true });
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toMatch(/pendingUserQuestion\.#pStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingWorkPlanInput\.#wStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingApprovalDeck\.#dStatus <> :awaitingStatus/);
  });

  it('updateSessionWorkPlanInputRequest cross-checks ALL THREE slots', async () => {
    await chatbotDb.updateSessionWorkPlanInputRequest(
      's-1',
      { requestId: 'r-1', channel: 'chat', prompt: 'x', fields: [], status: 'awaiting', createdAt: '2026-01-01T00:00:00.000Z' } as any,
      { failIfAwaitingExists: true },
    );
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toMatch(/pendingWorkPlanInput\.#inputStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingUserQuestion\.#questionStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingApprovalDeck\.#deckStatus <> :awaitingStatus/);
  });

  it('updateSessionApprovalDeck (finalize) cross-checks ALL THREE slots', async () => {
    await chatbotDb.updateSessionApprovalDeck('s-1', sampleFinalizedDeck(), { failIfAwaitingExists: true });
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toMatch(/pendingApprovalDeck\.#dStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingUserQuestion\.#qStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingWorkPlanInput\.#iStatus <> :awaitingStatus/);
  });

  // A DynamoDB ConditionalCheckFailedException means the ConditionExpression
  // just proven above (which names all three slots) evaluated false against
  // the STORED item — DynamoDB's own conditional-write semantics are what
  // actually enforce which slot caused the refusal, not this test. What this
  // file adds on top: a guard that fails its condition must be REFUSED
  // (null), never thrown as an unhandled error, for the new method too.
  it('updateSessionApprovalDeck returns null (refuses), not throws, on a conditional check failure', async () => {
    updateSpy.mockReturnValue({
      promise: () => Promise.reject(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' })),
    } as any);
    const res = await chatbotDb.updateSessionApprovalDeck('s-1', sampleFinalizedDeck(), { failIfAwaitingExists: true });
    expect(res).toBeNull();
  });

  it('updateSessionApprovalDeck append (requireStillBuilding) does NOT cross-check the other two slots — building is not yet live', async () => {
    let deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    deck = appendApprovalDeckItem(deck, {
      itemId: 'write-1', kind: 'meta_write', question: 'x',
      metaWriteManifestDigest: 'digest-1', metaWriteDispatch: { entity_type: 'AD', action: 'UPDATE', account_id: 'a', params: {} },
    });
    await chatbotDb.updateSessionApprovalDeck('s-1', deck, { requireStillBuilding: 'deck-1' });
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toBe("pendingApprovalDeck.deckId = :requireBuildingDeckId AND pendingApprovalDeck.#dStatus = :buildingStatus");
    expect(params.ConditionExpression).not.toMatch(/pendingUserQuestion/);
    expect(params.ConditionExpression).not.toMatch(/pendingWorkPlanInput/);
  });

  it('updateSessionApprovalDeck finalize composes BOTH the cross-slot guard AND requireStillBuilding', async () => {
    await chatbotDb.updateSessionApprovalDeck('s-1', sampleFinalizedDeck(), {
      failIfAwaitingExists: true,
      requireStillBuilding: 'deck-1',
    });
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toMatch(/pendingApprovalDeck\.#dStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingUserQuestion\.#qStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingWorkPlanInput\.#iStatus <> :awaitingStatus/);
    expect(params.ConditionExpression).toMatch(/pendingApprovalDeck\.deckId = :requireBuildingDeckId/);
    expect(params.ConditionExpression).toMatch(/pendingApprovalDeck\.#dStatus = :buildingStatus/);
  });
});
