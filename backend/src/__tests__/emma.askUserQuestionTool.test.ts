/**
 * Tests for the ask_user_question tool handler (ENG-396). Verifies the handler
 * normalizes options, persists the question as the single active pending
 * question, and returns a payload that HALTS the loop (awaitingUserConfirmation)
 * while carrying the structured card fields. The barrier/validation logic itself
 * lives in the pure module (askUserQuestion.test.ts); this covers the wiring.
 */

import '../emma/tools'; // side-effect: registers the tool
import { emmaToolRegistry } from '../emma/registry';
import { chatbotDb } from '../services/chatbotService';
import type { PendingUserQuestion } from '../services/agentMode/core/askUserQuestion';

describe('ask_user_question tool handler', () => {
  let persistSpy: jest.SpyInstance;

  beforeEach(() => {
    persistSpy = jest
      .spyOn(chatbotDb, 'updateSessionAskUserQuestion')
      .mockResolvedValue({} as any);
  });

  afterEach(() => jest.restoreAllMocks());

  const validArgs = () => ({
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: [
      { label: 'Leads', consequence: 'Optimizes for booked demos.', recommended: true, why: '162 LEAD events in 30d.', payload: { objective: 'OUTCOME_LEADS' } },
      { label: 'Traffic', consequence: 'Optimizes for visits, not leads.' },
    ],
    immutable: true,
    allow_emma_decide: true,
  });

  it('is registered', () => {
    expect(emmaToolRegistry.getTool('ask_user_question')).toBeDefined();
  });

  it('SUCCESS: persists an awaiting question and returns a halting card payload', async () => {
    const result = await emmaToolRegistry.execute('ask_user_question', validArgs(), { sessionId: 's-1' });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [sessionId, persisted] = persistSpy.mock.calls[0] as [string, PendingUserQuestion];
    expect(sessionId).toBe('s-1');
    expect(persisted.status).toBe('awaiting');
    expect(persisted.immutable).toBe(true);
    expect(persisted.recommendedOptionId).toBe('option-1');

    expect(result.success).toBe(true);
    expect(result.awaitingUserConfirmation).toBe(true); // halts the loop
    expect(result.type).toBe('ask_user_question');
    expect(result.recommendedOptionId).toBe('option-1');
    expect(result.allowEmmaDecide).toBe(true);
    expect(result.confirmationPrompt).toMatch(/⭐ Recommended: 162 LEAD events/);
    // no field instructs the model how to answer — only a user selection resolves it
    expect(JSON.stringify(result)).not.toMatch(/confirm\s*[:=]\s*true/i);
  });

  it('auto-generates option ids by position when omitted', async () => {
    await emmaToolRegistry.execute('ask_user_question', validArgs(), { sessionId: 's-1' });
    const persisted = persistSpy.mock.calls[0][1] as PendingUserQuestion;
    expect(persisted.options.map((o) => o.id)).toEqual(['option-1', 'option-2']);
  });

  it('respects a model-supplied option id', async () => {
    const args = validArgs();
    (args.options[0] as any).id = 'leads';
    await emmaToolRegistry.execute('ask_user_question', args, { sessionId: 's-1' });
    const persisted = persistSpy.mock.calls[0][1] as PendingUserQuestion;
    expect(persisted.options[0].id).toBe('leads');
    expect(persisted.recommendedOptionId).toBe('leads');
  });

  it('FAIL: returns an error and does NOT persist when there is no session', async () => {
    const result = await emmaToolRegistry.execute('ask_user_question', validArgs(), {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/requires an active session/);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('FAIL: returns a fixable validation error and does NOT persist on a bad option set', async () => {
    const args = validArgs();
    args.options[1] = { label: 'Traffic', consequence: 'x', recommended: true, why: 'also good' } as any; // two recommended
    const result = await emmaToolRegistry.execute('ask_user_question', args, { sessionId: 's-1' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Invalid ask_user_question: Exactly one option/);
    expect(persistSpy).not.toHaveBeenCalled();
  });
});
