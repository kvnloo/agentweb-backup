/**
 * Tests for the ask_user_question tool handler.
 *
 * ENG-1635/1644 (ask_user_question retirement): this tool no longer persists
 * anything itself. execute() mirrors present_question_deck's own execute()
 * exactly — a bare halt marker (questionDeckPayload, one entry), no DB write,
 * no early structural validation (that now happens once, at deck construction
 * time — see approvalDeck.test.ts's validateItemShape coverage). The actual
 * deck-of-one gets built and persisted at the shared iteration-end seam
 * (agentModeService's buildQuestionApprovalDeckFromHalts), covered by
 * agentModeService.questionApprovalDeck.test.ts.
 */

import '../emma/tools'; // side-effect: registers the tool
import { emmaToolRegistry } from '../emma/registry';

describe('ask_user_question tool handler', () => {
  // PR2: no producer writes session.pendingUserQuestion anymore — the
  // method that once persisted it (updateSessionAskUserQuestion) is deleted
  // entirely, so "nothing persists via the old path" is now a structural
  // guarantee rather than something to assert via a spy.

  afterEach(() => jest.restoreAllMocks());

  const validArgs = () => ({
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: [
      { label: 'Leads', consequence: 'Optimizes for booked demos.', recommended: true, why: '162 LEAD events in 30d.', payload: { objective: 'OUTCOME_LEADS' } },
      { label: 'Traffic', consequence: 'Optimizes for visits, not leads.' },
    ],
    immutable: true,
    allow_emma_decide: true,
    kind: 'meta_objective',
  });

  it('is registered', () => {
    expect(emmaToolRegistry.getTool('ask_user_question')).toBeDefined();
  });

  it('SUCCESS: returns a bare halt marker (questionDeckPayload)', async () => {
    const result = await emmaToolRegistry.execute('ask_user_question', validArgs(), { sessionId: 's-1' });

    expect(result.success).toBe(true);
    expect(result.awaitingUserConfirmation).toBe(true); // halts the loop
    expect(result.type).toBe('ask_user_question');
    expect(Array.isArray(result.questionDeckPayload)).toBe(true);
    expect(result.questionDeckPayload).toHaveLength(1);

    const q = result.questionDeckPayload[0];
    expect(q.question).toBe(validArgs().question);
    expect(q.allowEmmaDecide).toBe(true);
    expect(q.kind).toBe('meta_objective');
    expect(q.immutable).toBe(true);

    // no field instructs the model how to answer — only a user selection resolves it
    expect(JSON.stringify(result)).not.toMatch(/confirm\s*[:=]\s*true/i);
  });

  it.each([
    'hot_lead_call_approval:provision:abc:n1',
    'hot_lead_call_approval:',
    'smartlead_push_approval:push:abc:n1',
    'smartlead_push_approval:release:abc:n1',
    'smartlead_push_approval:',
  ])('REJECTS the reserved approval card kind %s, so a model cannot author an approval card', async (kind) => {
    const result = await emmaToolRegistry.execute('ask_user_question', { ...validArgs(), kind }, { sessionId: 's-1' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/reserved/);
    expect(result.questionDeckPayload).toBeUndefined();
    expect(result.awaitingUserConfirmation).toBeUndefined();
  });

  it('still accepts a kind that merely resembles the reserved one', async () => {
    const result = await emmaToolRegistry.execute('ask_user_question', { ...validArgs(), kind: 'hot_lead_call' }, { sessionId: 's-1' });
    expect(result.success).toBe(true);
  });

  it('auto-generates option ids by position when omitted', async () => {
    const result = await emmaToolRegistry.execute('ask_user_question', validArgs(), { sessionId: 's-1' });
    const q = result.questionDeckPayload[0];
    expect(q.options.map((o: any) => o.id)).toEqual(['option-1', 'option-2']);
    expect(q.options.find((o: any) => o.recommended === true).id).toBe('option-1');
  });

  it('respects a model-supplied option id', async () => {
    const args = validArgs();
    (args.options[0] as any).id = 'leads';
    const result = await emmaToolRegistry.execute('ask_user_question', args, { sessionId: 's-1' });
    const q = result.questionDeckPayload[0];
    expect(q.options[0].id).toBe('leads');
  });

  it('defaults kind/immutable/allowEmmaDecide when the model omits them', async () => {
    const args = validArgs();
    delete (args as any).immutable;
    delete (args as any).allow_emma_decide;
    delete (args as any).kind;
    const result = await emmaToolRegistry.execute('ask_user_question', args, { sessionId: 's-1' });
    const q = result.questionDeckPayload[0];
    expect(q.immutable).toBe(false);
    expect(q.allowEmmaDecide).toBe(false);
    expect(q.kind).toBeUndefined();
  });

  it('FAIL: returns an error and does NOT return a halt marker when there is no session', async () => {
    const result = await emmaToolRegistry.execute('ask_user_question', validArgs(), {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/requires an active session/);
    expect(result.awaitingUserConfirmation).toBeUndefined();
  });

  // Structural validation (exactly-one-recommended, 2-4 options, etc.) is no
  // longer checked here — it's enforced once, generically, at deck
  // construction (approvalDeck.ts's validateItemShape), exactly like
  // present_question_deck. A malformed call still halts; the shared
  // iteration-end seam falls back to the old plain-text prompt on a
  // malformed deck rather than throwing (see agentModeService's
  // buildQuestionApprovalDeckFromHalts try/catch).
  it('passes a malformed option set through uninspected — validation happens at deck-build time, not here', async () => {
    const args = validArgs();
    args.options[1] = { label: 'Traffic', consequence: 'x', recommended: true, why: 'also good' } as any; // two recommended
    const result = await emmaToolRegistry.execute('ask_user_question', args, { sessionId: 's-1' });
    expect(result.success).toBe(true);
    expect(result.questionDeckPayload[0].options.filter((o: any) => o.recommended === true)).toHaveLength(2);
  });
});
