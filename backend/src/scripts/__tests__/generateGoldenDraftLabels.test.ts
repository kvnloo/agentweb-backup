import {
  DEFAULT_DRAFT_LABEL_MODEL,
  buildAccountHealthContentText,
  buildPreflight,
  collectCandidates,
  draftLabelsForCase,
  parseArgs,
  resolveAccountHealthContent,
  resolveAgentContent,
  redactedDraftSummary,
  resolveCreativeContent,
  run,
  runCli,
  selectCandidateCases,
  type CliOptions,
  type GenerateDraftDeps,
} from '../generateGoldenDraftLabels';
import { newGoldenCase, parseDraft, type GoldenCase } from '../../loops/eval/goldenSet';
import type { GoldenSetStore } from '../../loops/eval/goldenSetStore';
import type { ChatMessage, ChatSession } from '../../services/chatbotService';
import type { HumanEvalCandidate } from '../../services/humanEvalService';
import type { User } from '../../services/db';
import type { AccountHealthSignals, AccountHealthClassification } from '../../services/accountHealthClassifier';

const NOW = new Date('2026-09-29T00:00:00.000Z');

function agentCase(id: string, overrides: Partial<GoldenCase> = {}): GoldenCase {
  return { ...newGoldenCase({ surface: 'agent', taskType: 'fp_catalogue', sourceId: id, seedSource: 'fp_catalogue:ENG-47', now: NOW }), ...overrides };
}

function creativeCase(id: string, overrides: Partial<GoldenCase> = {}): GoldenCase {
  return { ...newGoldenCase({ surface: 'creative', taskType: 'creative_image', sourceId: id, seedSource: 'seed:1', now: NOW }), ...overrides };
}

function accountHealthCase(id: string, overrides: Partial<GoldenCase> = {}): GoldenCase {
  return { ...newGoldenCase({ surface: 'account_health', taskType: 'subscription_canceled', sourceId: id, seedSource: 'seed:1', now: NOW }), ...overrides };
}

/** No-op deps a test overrides selectively; every source lookup/LLM call fails loudly if hit unexpectedly. */
function baseDeps(overrides: Partial<GenerateDraftDeps> = {}): GenerateDraftDeps {
  return {
    getChatSession: async () => {
      throw new Error('getChatSession should not be called in this test');
    },
    getCandidate: async () => {
      throw new Error('getCandidate should not be called in this test');
    },
    getUserById: async () => {
      throw new Error('getUserById should not be called in this test');
    },
    gatherAccountHealthSignals: async () => {
      throw new Error('gatherAccountHealthSignals should not be called in this test');
    },
    callLLM: async () => {
      throw new Error('callLLM should not be called in this test');
    },
    store: {
      listCases: async () => [],
      saveDraft: async (caseId, draft) => ({ ...agentCase(caseId), draft }) as GoldenCase,
    },
    now: () => NOW,
    sleep: async () => undefined,
    ...overrides,
  };
}

function llmJsonResponse(payload: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

describe('generateGoldenDraftLabels (ENG-2208)', () => {
  describe('draftLabelsForCase: building and validating a draft', () => {
    it('builds a valid GoldenCaseDraft from the LLM JSON response and it round-trips through parseDraft', async () => {
      const c = agentCase('s1');
      const llmPayload = {
        task_success: { label: 'pass', rationale: 'delivered' },
        tool_correctness: { label: 'pass', rationale: 'tools checked' },
        groundedness: { label: 'na', rationale: 'no claims made' },
        instruction_compliance: { label: 'pass', rationale: 'followed' },
        argued_with_instruction: { label: 'fail', rationale: 'no pushback' },
        escalated_when_not_required: { label: 'fail', rationale: 'resolved itself' },
        failed_to_escalate: { label: 'fail', rationale: 'nothing blocked' },
      };
      const session: ChatSession = {
        sessionId: 's1',
        userId: 'u1',
        messages: [{ role: 'user', content: 'do the thing' }, { role: 'assistant', content: 'done' }],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
      let capturedModel: string | undefined;
      const deps = baseDeps({
        getChatSession: async () => session,
        callLLM: async (model) => {
          capturedModel = model;
          return llmJsonResponse(llmPayload);
        },
      });

      const result = await draftLabelsForCase(deps, c, DEFAULT_DRAFT_LABEL_MODEL);

      expect(result.status).toBe('drafted');
      expect(capturedModel).toBe(DEFAULT_DRAFT_LABEL_MODEL);
      expect(result.draft?.model).toBe(DEFAULT_DRAFT_LABEL_MODEL);
      expect(result.draft?.generatedAt).toBe(NOW.toISOString());
      expect(result.draft?.labels.task_success).toEqual({ label: 'pass', rationale: 'delivered' });
      // Round-trips through the strict parser the store itself validates against.
      const reparsed = parseDraft(c.surface, c.criteria, result.draft);
      expect(reparsed).toEqual(result.draft);
    });

    it('logs and skips malformed LLM output without throwing', async () => {
      const c = agentCase('s1');
      const session: ChatSession = { sessionId: 's1', userId: 'u1', messages: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };

      const notJson = baseDeps({
        getChatSession: async () => session,
        callLLM: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
      });
      await expect(draftLabelsForCase(notJson, c, DEFAULT_DRAFT_LABEL_MODEL)).resolves.toMatchObject({
        status: 'skipped',
        reason: expect.stringContaining('malformed LLM JSON'),
      });

      const wrongShape = baseDeps({
        getChatSession: async () => session,
        callLLM: async () => llmJsonResponse({ task_success: { label: 'maybe', rationale: 'x' } }),
      });
      await expect(draftLabelsForCase(wrongShape, c, DEFAULT_DRAFT_LABEL_MODEL)).resolves.toMatchObject({
        status: 'skipped',
        reason: expect.stringContaining('label'),
      });

      const llmThrows = baseDeps({
        getChatSession: async () => session,
        callLLM: async () => {
          throw new Error('upstream 500');
        },
      });
      await expect(draftLabelsForCase(llmThrows, c, DEFAULT_DRAFT_LABEL_MODEL)).resolves.toMatchObject({
        status: 'skipped',
        reason: expect.stringContaining('upstream 500'),
      });
    });

    it('skips (never throws) when the source content cannot be resolved', async () => {
      const c = agentCase('missing');
      const deps = baseDeps({ getChatSession: async () => null });
      await expect(draftLabelsForCase(deps, c, DEFAULT_DRAFT_LABEL_MODEL)).resolves.toMatchObject({
        status: 'skipped',
        reason: expect.stringContaining('missing'),
      });
    });

    it('skips (never throws) when content resolution itself throws, e.g. a DynamoDB error (CodeRabbit finding, PR #3149)', async () => {
      const c = agentCase('s1');
      const deps = baseDeps({
        getChatSession: async () => {
          throw new Error('ProvisionedThroughputExceededException');
        },
      });
      await expect(draftLabelsForCase(deps, c, DEFAULT_DRAFT_LABEL_MODEL)).resolves.toMatchObject({
        status: 'skipped',
        reason: expect.stringContaining('ProvisionedThroughputExceededException'),
      });
    });

    it('rejects a draft that omits any of the case criteria — an empty or partial LLM reply must not "poison" the case for future runs (CodeRabbit finding, PR #3149)', async () => {
      const c = agentCase('s1');
      const session: ChatSession = { sessionId: 's1', userId: 'u1', messages: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };

      const empty = baseDeps({ getChatSession: async () => session, callLLM: async () => llmJsonResponse({}) });
      await expect(draftLabelsForCase(empty, c, DEFAULT_DRAFT_LABEL_MODEL)).resolves.toMatchObject({
        status: 'skipped',
        reason: expect.stringContaining('omitted criteria'),
      });

      const partial = baseDeps({
        getChatSession: async () => session,
        callLLM: async () => llmJsonResponse({ task_success: { label: 'pass', rationale: 'ok' } }),
      });
      const result = await draftLabelsForCase(partial, c, DEFAULT_DRAFT_LABEL_MODEL);
      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('tool_correctness');
      expect(result.draft).toBeUndefined();
    });
  });

  describe('content resolvers', () => {
    it('agent: resolves the transcript, or skips when getChatSession returns null', async () => {
      const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
      const ok = await resolveAgentContent(async () => ({ sessionId: 's', userId: 'u', messages, createdAt: '', updatedAt: '' }), 's');
      expect(ok).toEqual({ ok: true, content: expect.stringContaining('hello') });

      const missing = await resolveAgentContent(async () => null, 's');
      expect(missing.ok).toBe(false);
    });

    it('creative: never reads creativeGates/creativeRubric/creativePairwise, and attaches an image block for creative_image', async () => {
      const candidate: HumanEvalCandidate = {
        candidateId: 'c1',
        reviewType: 'creative_image',
        reviewer: 'matt',
        status: 'pending',
        outputSummary: 'a bold hero image',
        originalRequest: 'make an ad',
        artifactUrl: 'https://example.com/img.png',
        // Judge outputs that must never reach the drafting prompt (the whole point of this test).
        creativeGates: { checks: [], passed: true } as unknown as HumanEvalCandidate['creativeGates'],
        creativeRubric: { score: 5 } as unknown as HumanEvalCandidate['creativeRubric'],
        creativePairwise: { winner: 'A' } as unknown as HumanEvalCandidate['creativePairwise'],
        feedback: [],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
      const resolved = await resolveCreativeContent(async () => candidate, 'c1');
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error('unreachable');
      expect(Array.isArray(resolved.content)).toBe(true);
      const serialized = JSON.stringify(resolved.content);
      expect(serialized).toContain('a bold hero image');
      expect(serialized).toContain('https://example.com/img.png');
      expect(serialized).toContain('image_url');
      expect(serialized).not.toContain('passed');
      expect(serialized).not.toContain('"score":5');
      expect(serialized).not.toContain('winner');

      const missing = await resolveCreativeContent(async () => null, 'c1');
      expect(missing.ok).toBe(false);
    });

    it('creative: a non-image candidate gets plain text content, no image block', async () => {
      const candidate: HumanEvalCandidate = {
        candidateId: 'c2',
        reviewType: 'landing_page',
        reviewer: 'matt',
        status: 'pending',
        outputSummary: 'a landing page',
        feedback: [],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
      const resolved = await resolveCreativeContent(async () => candidate, 'c2');
      expect(resolved).toEqual({ ok: true, content: expect.stringContaining('a landing page') });
    });

    it('account_health: skips when the user is not found, otherwise feeds only gathered signals', async () => {
      const missing = await resolveAccountHealthContent(async () => undefined, async () => {
        throw new Error('gatherAccountHealthSignals should not run when the user is missing');
      }, 'u1', NOW.getTime());
      expect(missing.ok).toBe(false);

      const user = { userId: 'u1', email: 'a@b.com' } as User;
      const signals = { nowMs: NOW.getTime(), connectedAccounts: null, requirement: null, payments: null, campaigns: null, recentAdSpend: null } as AccountHealthSignals;
      let capturedNowMs: number | undefined;
      const ok = await resolveAccountHealthContent(
        async () => user,
        async (u, nowMs) => {
          capturedNowMs = nowMs;
          expect(u.userId).toBe('u1');
          return { signals };
        },
        'u1',
        NOW.getTime(),
      );
      expect(capturedNowMs).toBe(NOW.getTime());
      expect(ok).toEqual({ ok: true, content: buildAccountHealthContentText(signals) });
    });
  });

  describe('regression guard: the account_health prompt builder cannot accept a classifier verdict', () => {
    it('buildAccountHealthContentText only type-checks against AccountHealthSignals, never AccountHealthClassification', () => {
      const signals: AccountHealthSignals = {
        nowMs: NOW.getTime(),
        connectedAccounts: null,
        requirement: null,
        payments: null,
        campaigns: null,
        recentAdSpend: null,
      };
      expect(() => buildAccountHealthContentText(signals)).not.toThrow();

      const classification: AccountHealthClassification = {
        state: 'at_risk',
        confidence: 'high',
        evidence: [{ code: 'payment_failed', kind: 'risk', detail: 'payment failed' }],
        connection: { state: 'connected', meta: 'connected', others: {} },
        requirement: 'required',
        billingCycle: '2026-09-29',
      };
      // @ts-expect-error regression guard (ENG-2208): classifyAccountHealth's own verdict must be
      // structurally impossible to pass into the drafting prompt — it is exactly what the golden
      // label is meant to independently validate, so it cannot type-check as AccountHealthSignals.
      buildAccountHealthContentText(classification);
    });

    it('never leaks connected-account credentials into the prompt text (CodeRabbit finding, PR #3149)', () => {
      const signals: AccountHealthSignals = {
        nowMs: NOW.getTime(),
        connectedAccounts: [
          {
            platform: 'meta',
            account_id: 'act_super_secret_account_id',
            account_name: 'Jane Doe Ad Account',
            config: {
              account_type: 'ad_account',
              access_token: 'EAABsbCS1secretaccesstoken',
              refresh_token: 'refresh_super_secret_token',
              token_expires_at: NOW.getTime() + 1000,
              scopes: ['ads_management', 'business_management'],
            },
          },
        ] as unknown as AccountHealthSignals['connectedAccounts'],
        requirement: null,
        payments: null,
        campaigns: null,
        recentAdSpend: null,
      };

      const text = buildAccountHealthContentText(signals);

      expect(text).not.toContain('secretaccesstoken');
      expect(text).not.toContain('refresh_super_secret_token');
      expect(text).not.toContain('act_super_secret_account_id');
      expect(text).not.toContain('Jane Doe Ad Account');
      expect(text).not.toContain('ads_management');
      expect(text).not.toContain('access_token');
      expect(text).not.toContain('refresh_token');
      expect(text).not.toContain('scopes');
      // The criteria-relevant, non-identifying shape is still present.
      expect(text).toContain('"platform": "meta"');
      expect(text).toContain('"hasUsableToken": true');
    });
  });

  describe('selectCandidateCases: skip logic', () => {
    it('skips pairwise cases, already-fully-labelled cases, and cases with an existing draft unless --force', () => {
      const plain = agentCase('a');
      const fullyLabelled = agentCase('b', {
        labels: {
          task_success: 'pass',
          tool_correctness: 'pass',
          groundedness: 'pass',
          instruction_compliance: 'pass',
          argued_with_instruction: 'fail',
          escalated_when_not_required: 'fail',
          failed_to_escalate: 'fail',
        },
      });
      const alreadyDrafted = agentCase('c', { draft: { labels: {}, model: 'x', generatedAt: NOW.toISOString() } });
      const pairwise = creativeCase('d', {
        criteria: ['pairwise_preference'],
        pair: { candidateIdB: 'other', batch: '2026-W39', position: 0, batchSize: 2, category: 'ad', placement: 'feed', signal: 'clear' },
      });

      const cases = [plain, fullyLabelled, alreadyDrafted, pairwise];
      expect(selectCandidateCases(cases, false).map((c) => c.caseId)).toEqual([plain.caseId]);
      expect(selectCandidateCases(cases, true).map((c) => c.caseId).sort()).toEqual([alreadyDrafted.caseId, plain.caseId].sort());
    });
  });

  describe('collectCandidates + run: end-to-end orchestration', () => {
    it('iterates every surface by default, applies --limit across surfaces, and skips a case whose draft field is already the wrong shape', async () => {
      const listed: Record<string, GoldenCase[]> = {
        agent: [agentCase('a1'), agentCase('a2')],
        creative: [creativeCase('c1')],
        account_health: [accountHealthCase('h1')],
      };
      const store: Pick<GoldenSetStore, 'listCases' | 'saveDraft'> = {
        listCases: async (surface) => listed[surface] ?? [],
        saveDraft: async (caseId, draft) => ({ ...agentCase(caseId), draft }) as GoldenCase,
      };
      const opts: Pick<CliOptions, 'surface' | 'force' | 'limit'> = { limit: 2, force: false };
      const candidates = await collectCandidates({ store }, opts);
      expect(candidates.map((c) => c.caseId)).toEqual([agentCase('a1').caseId, agentCase('a2').caseId]);
    });

    it('run(): --dry-run resolves content and calls the LLM but never calls store.saveDraft', async () => {
      const c = agentCase('a1');
      const session: ChatSession = { sessionId: 'a1', userId: 'u1', messages: [{ role: 'user', content: 'hi' }], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      const saveDraft = jest.fn(async (caseId: string, draft: unknown) => ({ ...c, draft }) as GoldenCase);
      const deps = baseDeps({
        getChatSession: async () => session,
        callLLM: async () =>
          llmJsonResponse({
            task_success: { label: 'pass', rationale: 'ok' },
            tool_correctness: { label: 'pass', rationale: 'ok' },
            groundedness: { label: 'na', rationale: 'ok' },
            instruction_compliance: { label: 'pass', rationale: 'ok' },
            argued_with_instruction: { label: 'fail', rationale: 'ok' },
            escalated_when_not_required: { label: 'fail', rationale: 'ok' },
            failed_to_escalate: { label: 'fail', rationale: 'ok' },
          }),
        store: { listCases: async (surface) => (surface === 'agent' ? [c] : []), saveDraft },
      });
      const opts: CliOptions = { model: DEFAULT_DRAFT_LABEL_MODEL, force: false, dryRun: true };

      const summary = await run(deps, opts);

      expect(summary).toEqual({ processed: 1, drafted: 1, skipped: 0 });
      expect(saveDraft).not.toHaveBeenCalled();
    });

    it('run(): live mode calls store.saveDraft for a drafted case and never for a skipped one', async () => {
      const drafted = agentCase('a1');
      const skipped = agentCase('a2');
      const session: ChatSession = { sessionId: 'x', userId: 'u1', messages: [{ role: 'user', content: 'hi' }], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      const saveDraft = jest.fn(async (caseId: string, draft: unknown) => ({ ...drafted, draft }) as GoldenCase);
      const deps = baseDeps({
        getChatSession: async (sessionId) => (sessionId === skipped.sourceRef.id ? null : session),
        callLLM: async () =>
          llmJsonResponse({
            task_success: { label: 'pass', rationale: 'ok' },
            tool_correctness: { label: 'pass', rationale: 'ok' },
            groundedness: { label: 'na', rationale: 'ok' },
            instruction_compliance: { label: 'pass', rationale: 'ok' },
            argued_with_instruction: { label: 'fail', rationale: 'ok' },
            escalated_when_not_required: { label: 'fail', rationale: 'ok' },
            failed_to_escalate: { label: 'fail', rationale: 'ok' },
          }),
        store: { listCases: async (surface) => (surface === 'agent' ? [drafted, skipped] : []), saveDraft },
      });
      const opts: CliOptions = { model: DEFAULT_DRAFT_LABEL_MODEL, force: false, dryRun: false };

      const summary = await run(deps, opts);

      expect(summary).toEqual({ processed: 2, drafted: 1, skipped: 1 });
      expect(saveDraft).toHaveBeenCalledTimes(1);
      expect(saveDraft).toHaveBeenCalledWith(drafted.caseId, expect.objectContaining({ model: DEFAULT_DRAFT_LABEL_MODEL }));
    });

    it('run(): a single failing store.saveDraft does not stop the batch — the remaining cases still process (CodeRabbit finding, PR #3149)', async () => {
      const failsToSave = agentCase('a1');
      const savesFine = agentCase('a2');
      const session: ChatSession = { sessionId: 'x', userId: 'u1', messages: [{ role: 'user', content: 'hi' }], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      const saveDraft = jest.fn(async (caseId: string, draft: unknown) => {
        if (caseId === failsToSave.caseId) throw new Error('ConditionalCheckFailedException');
        return { ...savesFine, draft } as GoldenCase;
      });
      const deps = baseDeps({
        getChatSession: async () => session,
        callLLM: async () =>
          llmJsonResponse({
            task_success: { label: 'pass', rationale: 'ok' },
            tool_correctness: { label: 'pass', rationale: 'ok' },
            groundedness: { label: 'na', rationale: 'ok' },
            instruction_compliance: { label: 'pass', rationale: 'ok' },
            argued_with_instruction: { label: 'fail', rationale: 'ok' },
            escalated_when_not_required: { label: 'fail', rationale: 'ok' },
            failed_to_escalate: { label: 'fail', rationale: 'ok' },
          }),
        store: { listCases: async (surface) => (surface === 'agent' ? [failsToSave, savesFine] : []), saveDraft },
      });
      const opts: CliOptions = { model: DEFAULT_DRAFT_LABEL_MODEL, force: false, dryRun: false };

      const summary = await run(deps, opts);

      expect(summary).toEqual({ processed: 2, drafted: 1, skipped: 1 });
      expect(saveDraft).toHaveBeenCalledTimes(2);
    });
  });

  describe('parseArgs', () => {
    it('defaults to DEFAULT_DRAFT_LABEL_MODEL and parses flags', () => {
      expect(parseArgs([])).toEqual({ model: DEFAULT_DRAFT_LABEL_MODEL, force: false, dryRun: false, surface: undefined, limit: undefined });
      expect(parseArgs(['--surface', 'creative', '--force', '--dry-run', '--limit', '5'])).toEqual({
        surface: 'creative',
        model: DEFAULT_DRAFT_LABEL_MODEL,
        force: true,
        dryRun: true,
        limit: 5,
      });
    });

    it('rejects an unknown surface, a model not in the registry, and a non-positive --limit', () => {
      expect(() => parseArgs(['--surface', 'bogus'])).toThrow(/--surface/);
      expect(() => parseArgs(['--model', 'not-a-real-model'])).toThrow(/LLM_MODEL_REGISTRY/);
      expect(() => parseArgs(['--limit', '0'])).toThrow(/--limit/);
      expect(() => parseArgs(['--limit', 'nope'])).toThrow(/--limit/);
    });
  });

  describe('preflight, --yes and dry-run redaction (ENG-2135)', () => {
    const fullLlm = () =>
      llmJsonResponse({
        task_success: { label: 'pass', rationale: 'CUSTOMER-QUOTE-ABC' },
        tool_correctness: { label: 'pass', rationale: 'x' },
        groundedness: { label: 'na', rationale: 'x' },
        instruction_compliance: { label: 'pass', rationale: 'x' },
        argued_with_instruction: { label: 'fail', rationale: 'x' },
        escalated_when_not_required: { label: 'fail', rationale: 'x' },
        failed_to_escalate: { label: 'fail', rationale: 'x' },
      });
    const session: ChatSession = { sessionId: 'a1', userId: 'u1', messages: [{ role: 'user', content: 'hi' }], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
    const setup = () => {
      const callLLM = jest.fn(async () => fullLlm());
      const saveDraft = jest.fn(async (caseId: string, draft: unknown) => ({ ...agentCase(caseId), draft }) as GoldenCase);
      const deps = baseDeps({
        getChatSession: async () => session,
        callLLM,
        store: { listCases: async (surface) => (surface === 'agent' ? [agentCase('a1'), agentCase('a2')] : []), saveDraft },
      });
      return { deps, callLLM, saveDraft };
    };

    it('preflight names the table, surface, case count and model', () => {
      const text = buildPreflight({ tableName: 'AW-EvalGoldenCases', opts: { model: DEFAULT_DRAFT_LABEL_MODEL, force: false, dryRun: false, surface: 'agent' }, wouldDraft: 2 }).join('\n');
      expect(text).toContain('AW-EvalGoldenCases');
      expect(text).toContain('surface: agent');
      expect(text).toContain('would draft: 2');
      expect(text).toContain(DEFAULT_DRAFT_LABEL_MODEL);
    });

    it('a live run without --yes prints the preflight, exits 1, and neither calls the LLM nor writes', async () => {
      const { deps, callLLM, saveDraft } = setup();
      const lines: string[] = [];
      const code = await runCli(['--surface', 'agent'], deps, 'AW-EvalGoldenCases', (l) => lines.push(l));
      expect(code).toBe(1);
      expect(callLLM).not.toHaveBeenCalled();
      expect(saveDraft).not.toHaveBeenCalled();
      expect(lines.join('\n')).toMatch(/table:\s+AW-EvalGoldenCases/);
      expect(lines.join('\n')).toMatch(/would draft: 2/);
    });

    it('a live run with --yes proceeds and writes', async () => {
      const { deps, saveDraft } = setup();
      const code = await runCli(['--surface', 'agent', '--yes'], deps, 'AW-EvalGoldenCases', () => undefined);
      expect(code).toBe(0);
      expect(saveDraft).toHaveBeenCalledTimes(2);
    });

    it('--dry-run needs no --yes, writes nothing, and prints no rationale text', async () => {
      const { deps, saveDraft } = setup();
      const logged: string[] = [];
      const spy = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')));
      const code = await runCli(['--surface', 'agent', '--dry-run'], deps, 'AW-EvalGoldenCases', () => undefined);
      spy.mockRestore();
      expect(code).toBe(0);
      expect(saveDraft).not.toHaveBeenCalled();
      const out = logged.join('\n');
      expect(out).toMatch(/would draft \(dry-run\) task_success=pass tool_correctness=pass/);
      expect(out).not.toContain('CUSTOMER-QUOTE-ABC');
    });

    it('refuses when the store is not provisioned', async () => {
      const { deps, callLLM } = setup();
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await runCli(['--yes'], deps, null, () => undefined)).toBe(1);
      err.mockRestore();
      expect(callLLM).not.toHaveBeenCalled();
    });

    it('redactedDraftSummary keeps criterion and label only', () => {
      const out = redactedDraftSummary({ model: 'm', generatedAt: 'g', labels: { hook: { label: 'fail', rationale: 'SECRET' } } });
      expect(out).toBe('hook=fail');
    });
  });
});
