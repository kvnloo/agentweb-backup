/**
 * ENG-113 - saved "Compare models" alternatives (the multiverse view).
 *
 * Invariants proven here (see dev/pending/eng-113-saved-alternatives.md):
 *  - trust: the unchosen answers are stored only when a SET token (HMAC over every ok column) verifies;
 *    names/providers come from the server registry; any failure ignores the alternatives and the select still
 *    succeeds for the chosen answer;
 *  - size: alternatives are bounded so the row can never reach the persistence cap; over budget => NONE stored
 *    plus metadata.compareAlternativesOmitted:'size' (never a partial set, never the chosen answer at risk);
 *  - switch: absent / not exactly 'true' / unreadable => nothing stored (today's behaviour);
 *  - replay never rewrites alternatives; usage and cost are untouched (select makes no model call).
 */
import {
  AlternativesTokenFields,
  CompareDeps,
  CompareSession,
  SelectDeps,
  compareModels,
  isSameServedModel,
  selectCompareResult,
  signAlternativesToken,
  signSelectToken,
  verifyAlternativesToken,
  __resetCompareInFlightForTests,
} from '../services/agentMode/modelComparison';
import {
  COMPARE_ALTERNATIVES_BUDGET_BYTES,
  COMPARE_ALTERNATIVES_OMITTED_SIZE,
  COMPARE_ROW_CAP_BYTES,
  COMPARE_SAVE_ALTERNATIVES_SETTING,
  SavedAlternative,
  createCompareSaveAlternatives,
  serializedBytes,
  withSavedAlternatives,
} from '../services/agentMode/compareSaveAlternatives';
import { shrinkMessageForPersistence } from '../utils/messageSizeGuard';
import type { ChatMessage } from '../services/chatbotService';

const SECRET = 'unit-test-secret-not-a-real-one';
const NOW = 1_790_000_000_000;
const OWNER = { userId: 'user-1', isAdmin: false };
const ID = '11111111-2222-4333-8444-555555555555';
const REGISTRY: Record<string, { name: string; provider: string; isLive: boolean; internalOnly: boolean }> = {
  'gpt-5.5': { name: 'GPT-5.5', provider: 'openai', isLive: false, internalOnly: false },
  'gemini-3.5-flash': { name: 'Gemini 3.5 Flash', provider: 'google', isLive: false, internalOnly: false },
  'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', provider: 'anthropic', isLive: false, internalOnly: false },
  'deepseek-v4': { name: 'DeepSeek V4', provider: 'deepseek', isLive: false, internalOnly: false },
};

const sess = (): CompareSession => ({
  sessionId: 's-1',
  userId: OWNER.userId,
  messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ],
});

// ---------------------------------------------------------------------------
describe('compare_save_alternatives switch', () => {
  const make = (rows: Array<unknown | Error>, clock = { t: 1_000_000 }) => {
    let i = 0;
    const getSetting = jest.fn(async (name: string) => {
      expect(name).toBe(COMPARE_SAVE_ALTERNATIVES_SETTING);
      const r = rows[Math.min(i++, rows.length - 1)];
      if (r instanceof Error) throw r;
      return r === null ? null : { settingValue: r };
    });
    const sw = createCompareSaveAlternatives({ getSetting, now: () => clock.t, log: jest.fn() });
    return { sw, getSetting, clock };
  };

  it.each([[null], ['false'], ['TRUE'], [' true'], ['true '], ['1'], [true], [undefined]])('value %p => off', async (v) => {
    expect(await make([v]).sw.isEnabled()).toBe(false);
  });
  it("exactly 'true' => on", async () => {
    expect(await make(['true']).sw.isEnabled()).toBe(true);
  });
  it('cold-start read failure => off', async () => {
    expect(await make([new Error('ddb down')]).sw.isEnabled()).toBe(false);
  });
  it('is cached for ~60s, then re-read', async () => {
    const { sw, getSetting, clock } = make(['true', 'false']);
    expect(await sw.isEnabled()).toBe(true);
    clock.t += 59_000;
    expect(await sw.isEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(1);
    clock.t += 2_000;
    expect(await sw.isEnabled()).toBe(false);
    expect(getSetting).toHaveBeenCalledTimes(2);
  });
  it('a failed refresh keeps the last-known value and retries sooner than a full window', async () => {
    const { sw, getSetting, clock } = make(['true', new Error('blip'), 'true']);
    expect(await sw.isEnabled()).toBe(true);
    clock.t += 61_000;
    expect(await sw.isEnabled()).toBe(true); // refresh failed -> last-known
    clock.t += 6_000;
    await sw.isEnabled();
    expect(getSetting).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
describe('alternatives token', () => {
  const base: AlternativesTokenFields = {
    userId: 'user-1', sessionId: 's-1', compareId: ID, prompt: 'p', issuedAt: NOW,
    columns: [{ model: 'a', content: 'AAA' }, { model: 'b', content: 'BBB' }, { model: 'c', content: 'CCC' }],
  };
  const token = signAlternativesToken(SECRET, base);

  it('verifies, regardless of column order', () => {
    expect(verifyAlternativesToken(SECRET, base, token)).toBe(true);
    expect(verifyAlternativesToken(SECRET, { ...base, columns: [...base.columns].reverse() }, token)).toBe(true);
  });
  it.each<[string, (f: AlternativesTokenFields) => AlternativesTokenFields]>([
    ['userId', (f) => ({ ...f, userId: 'u2' })],
    ['sessionId', (f) => ({ ...f, sessionId: 's-2' })],
    ['compareId', (f) => ({ ...f, compareId: '99999999-2222-4333-8444-555555555555' })],
    ['prompt', (f) => ({ ...f, prompt: 'q' })],
    ['issuedAt', (f) => ({ ...f, issuedAt: f.issuedAt + 1 })],
    ['edited content', (f) => ({ ...f, columns: [f.columns[0], { model: 'b', content: 'BBB!' }, f.columns[2]] })],
    ['re-attributed model', (f) => ({ ...f, columns: [f.columns[0], { model: 'z', content: 'BBB' }, f.columns[2]] })],
    ['extra column', (f) => ({ ...f, columns: [...f.columns, { model: 'd', content: 'DDD' }] })],
    ['missing column', (f) => ({ ...f, columns: f.columns.slice(0, 2) })],
  ])('does not verify when %s changes', (_n, mutate) => {
    expect(verifyAlternativesToken(SECRET, mutate(base), token)).toBe(false);
  });
  it('rejects non-string / short / long tokens and another secret', () => {
    for (const bad of [undefined, null, 5, {}, '', 'abc', token + '0']) expect(verifyAlternativesToken(SECRET, base, bad)).toBe(false);
    expect(verifyAlternativesToken('other-secret', base, token)).toBe(false);
  });
  it('is not interchangeable with a select token', () => {
    const selectToken = signSelectToken(SECRET, { userId: 'user-1', sessionId: 's-1', compareId: ID, prompt: 'p', model: 'a', content: 'AAA', issuedAt: NOW });
    expect(verifyAlternativesToken(SECRET, base, selectToken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('POST /compare issues alternativesToken', () => {
  beforeEach(() => __resetCompareInFlightForTests());
  const makeCompare = (failModels: string[] = []) => {
    let clock = NOW;
    const deps: CompareDeps = {
      isAcceptingWork: () => true,
      isFeatureEnabled: async () => true,
      getSession: async () => sess(),
      checkUsage: async () => ({ allowed: true }),
      buildUsageBlock: () => ({ message: 'paused' }),
      normalizeModelId: (m) => m,
      resolveModel: async ({ requestedModel }) => ({ effectiveModel: requestedModel, modelSelection: 'honored' }),
      getModelInfo: (m) => REGISTRY[m] ?? null,
      isPriced: () => true,
      servedModelMatches: (m, served) => isSameServedModel(`up/${m}`, served),
      resolveBillingUserId: async (u) => u,
      callLLM: jest.fn(async (model: string) => {
        if (failModels.includes(model)) throw new Error('boom');
        return { model: `up/${model}`, choices: [{ message: { role: 'assistant', content: `answer from ${model}` }, finish_reason: 'stop' }] };
      }),
      getSecret: () => SECRET,
      now: () => clock++,
      newId: () => ID,
      log: jest.fn(),
    };
    return deps;
  };
  const go = (deps: CompareDeps, models: string[]) => compareModels(deps, { user: OWNER, body: { sessionId: 's-1', prompt: 'Compare these', models } });

  it('binds EVERY ok column (the set), sorted, with the response fields', async () => {
    const out = await go(makeCompare(), ['gpt-5.5', 'gemini-3.5-flash', 'claude-sonnet-4-6']);
    const body = out.body as any;
    expect(out.status).toBe(200);
    expect(typeof body.alternativesToken).toBe('string');
    const columns = body.results.map((r: any) => ({ model: r.model, content: r.content }));
    expect(verifyAlternativesToken(SECRET, {
      userId: 'user-1', sessionId: 's-1', compareId: body.compareId, prompt: body.prompt, issuedAt: body.issuedAt, columns,
    }, body.alternativesToken)).toBe(true);
  });
  it('failed columns are not in the set; fewer than two ok columns => no token', async () => {
    const two = (await go(makeCompare(['claude-sonnet-4-6']), ['gpt-5.5', 'gemini-3.5-flash', 'claude-sonnet-4-6'])).body as any;
    const ok = two.results.filter((r: any) => r.status === 'ok').map((r: any) => ({ model: r.model, content: r.content }));
    expect(ok).toHaveLength(2);
    expect(verifyAlternativesToken(SECRET, { userId: 'user-1', sessionId: 's-1', compareId: ID, prompt: two.prompt, issuedAt: two.issuedAt, columns: ok }, two.alternativesToken)).toBe(true);
    const one = (await go(makeCompare(['gemini-3.5-flash']), ['gpt-5.5', 'gemini-3.5-flash'])).body as any;
    expect(one.alternativesToken).toBeUndefined();
  });
  it('the token is issued whether or not saving is on (the switch is not part of it); the existing fields are unchanged', async () => {
    const body = (await go(makeCompare(), ['gpt-5.5', 'gemini-3.5-flash'])).body as any;
    expect(Object.keys(body).sort()).toEqual(['alternativesToken', 'compareId', 'issuedAt', 'prompt', 'results']);
    expect(body.results.every((r: any) => typeof r.selectToken === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('POST /compare/select with alternatives', () => {
  const CHOSEN = { model: 'gpt-5.5', content: 'the chosen answer' };
  const ALT1 = { model: 'gemini-3.5-flash', content: 'gemini answer', latencyMs: 900 };
  const ALT2 = { model: 'claude-sonnet-4-6', content: 'sonnet answer', latencyMs: 1500 };
  const issuedAt = NOW - 1000;

  function payload(over: Record<string, unknown> = {}, alts: Array<{ model: string; content: string; latencyMs?: number; name?: string; provider?: string }> = [ALT1, ALT2]) {
    const set = signAlternativesToken(SECRET, {
      userId: OWNER.userId, sessionId: 's-1', compareId: ID, prompt: 'Compare these', issuedAt,
      columns: [CHOSEN, ALT1, ALT2],
    });
    const f = { sessionId: 's-1', compareId: ID, prompt: 'Compare these', model: CHOSEN.model, content: CHOSEN.content, issuedAt, ...over };
    return { ...f, selectToken: signSelectToken(SECRET, { userId: OWNER.userId, ...(f as any) }), alternatives: alts, alternativesToken: set };
  }

  function makeSelect(over: Partial<SelectDeps> = {}, history: CompareSession = sess()) {
    const appendMessages = jest.fn(async (_id: string, messages: ChatMessage[]) => ({
      messages: [...(history.messages ?? []), ...messages.map((m, i) => ({ ...m, messageIndex: (history.messages?.length ?? 0) + i }))],
    }));
    const deps: SelectDeps = {
      isAcceptingWork: () => true,
      isFeatureEnabled: async () => true,
      getSession: jest.fn(async () => history),
      tryClaim: jest.fn(() => true),
      release: jest.fn(),
      appendMessages,
      updateSessionModel: jest.fn(async () => ({})),
      maxSessionMessages: 1000,
      getSecret: () => SECRET,
      now: () => NOW,
      log: jest.fn(),
      isSaveAlternativesEnabled: async () => true,
      getModelInfo: (m) => REGISTRY[m] ?? null,
      ...over,
    };
    return { deps, appendMessages };
  }
  const go = (deps: SelectDeps, b: unknown) => selectCompareResult(deps, { user: OWNER, body: b });
  const assistant = (append: jest.Mock): ChatMessage => append.mock.calls[0][1][1];

  it('stores the set with server-registry names, compareId, and keeps the chosen answer untouched', async () => {
    const { deps, appendMessages } = makeSelect();
    const out = await go(deps, payload());
    expect(out.status).toBe(200);
    const a = assistant(appendMessages);
    expect(a).toMatchObject({ role: 'assistant', content: 'the chosen answer', llm: 'gpt-5.5' });
    expect(a.metadata!.compareId).toBe(ID);
    expect(a.metadata!.compareAlternatives).toEqual([
      { model: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google', content: 'gemini answer', latencyMs: 900 },
      { model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', content: 'sonnet answer', latencyMs: 1500 },
    ]);
    expect(a.metadata).not.toHaveProperty('compareAlternativesOmitted');
    expect(a.usage).toBeUndefined();
    expect(appendMessages.mock.calls[0][1][0].metadata).not.toHaveProperty('compareAlternatives'); // user row
  });

  it('NEVER takes name/provider from the client', async () => {
    const forged = [{ ...ALT1, name: 'Totally Trusted GPT-9', provider: 'evil' }, ALT2];
    const { deps, appendMessages } = makeSelect();
    await go(deps, payload({}, forged));
    const stored = assistant(appendMessages).metadata!.compareAlternatives!;
    expect(stored[0].name).toBe('Gemini 3.5 Flash');
    expect(stored[0].provider).toBe('google');
    expect(JSON.stringify(stored)).not.toContain('Totally Trusted');
  });

  it('an unknown model id (only possible for a signed column) falls back to the id / other, not client text', async () => {
    const odd = { model: 'retired-model', content: 'old answer', latencyMs: 5 };
    const set = signAlternativesToken(SECRET, { userId: OWNER.userId, sessionId: 's-1', compareId: ID, prompt: 'Compare these', issuedAt, columns: [CHOSEN, odd] });
    const { deps, appendMessages } = makeSelect();
    await go(deps, { ...payload({}, [{ ...odd, name: 'client name' }]), alternativesToken: set });
    expect(assistant(appendMessages).metadata!.compareAlternatives).toEqual([{ model: 'retired-model', name: 'retired-model', provider: 'other', content: 'old answer', latencyMs: 5 }]);
  });

  it.each([[undefined], [false]])('switch off (%p) => nothing stored, select succeeds, no marker', async (flag) => {
    const { deps, appendMessages } = makeSelect(flag === undefined ? { isSaveAlternativesEnabled: undefined } : { isSaveAlternativesEnabled: async () => false });
    const out = await go(deps, payload());
    expect(out.status).toBe(200);
    expect(assistant(appendMessages).metadata).toEqual({ timestamp: expect.any(String), portalType: 'agent' });
  });

  it('a throwing switch reader => nothing stored, select succeeds', async () => {
    const { deps, appendMessages } = makeSelect({ isSaveAlternativesEnabled: async () => { throw new Error('x'); } });
    expect((await go(deps, payload())).status).toBe(200);
    expect(assistant(appendMessages).metadata).not.toHaveProperty('compareAlternatives');
  });

  it('no alternatives in the body => exactly today\'s message (no compareId either)', async () => {
    const { deps, appendMessages } = makeSelect();
    const p: any = payload();
    delete p.alternatives;
    delete p.alternativesToken;
    await go(deps, p);
    expect(assistant(appendMessages).metadata).toEqual({ timestamp: expect.any(String), portalType: 'agent' });
  });

  const tamper: Array<[string, (p: any) => any]> = [
    ['edited alternative content', (p) => ({ ...p, alternatives: [{ ...ALT1, content: 'forged answer' }, ALT2] })],
    ['re-attributed alternative model', (p) => ({ ...p, alternatives: [{ ...ALT1, model: 'deepseek-v4' }, ALT2] })],
    ['an EXTRA alternative', (p) => ({ ...p, alternatives: [...p.alternatives, { model: 'deepseek-v4', content: 'injected', latencyMs: 1 }] })],
    ['a dropped alternative (the set is partial)', (p) => ({ ...p, alternatives: [ALT1] })],
    ['alternative equal to the chosen model', (p) => ({ ...p, alternatives: [{ model: 'gpt-5.5', content: 'x', latencyMs: 1 }, ALT2] })],
    ['duplicate alternative models', (p) => ({ ...p, alternatives: [ALT1, { ...ALT1 }] })],
    ['missing alternativesToken', (p) => ({ ...p, alternativesToken: undefined })],
    ['forged alternativesToken', (p) => ({ ...p, alternativesToken: 'a'.repeat(64) })],
    ['non-string alternativesToken', (p) => ({ ...p, alternativesToken: { $ne: 1 } })],
    ['token from another compare', (p) => ({ ...p, alternativesToken: signAlternativesToken(SECRET, { userId: OWNER.userId, sessionId: 's-1', compareId: '99999999-2222-4333-8444-555555555555', prompt: 'Compare these', issuedAt, columns: [CHOSEN, ALT1, ALT2] }) })],
    ['a select token passed as the set token', (p) => ({ ...p, alternativesToken: p.selectToken })],
    ['alternatives not an array', (p) => ({ ...p, alternatives: { 0: ALT1 } })],
    ['empty alternatives', (p) => ({ ...p, alternatives: [] })],
    ['more than 3 alternatives', (p) => ({ ...p, alternatives: [ALT1, ALT2, { model: 'm3', content: 'c', latencyMs: 1 }, { model: 'm4', content: 'c', latencyMs: 1 }] })],
    ['a non-object entry', (p) => ({ ...p, alternatives: [ALT1, 'x'] })],
    ['empty alternative content', (p) => ({ ...p, alternatives: [{ ...ALT1, content: '  ' }, ALT2] })],
    ['alternative content over the 200k limit', (p) => ({ ...p, alternatives: [{ ...ALT1, content: 'x'.repeat(200_001) }, ALT2] })],
  ];
  it.each(tamper)('ignores the alternatives (select still OK for the chosen answer) on %s', async (_n, mutate) => {
    const { deps, appendMessages } = makeSelect();
    const out = await go(deps, mutate(payload()));
    expect(out.status).toBe(200);
    const a = assistant(appendMessages);
    expect(a).toMatchObject({ content: 'the chosen answer', llm: 'gpt-5.5' });
    expect(a.metadata).toEqual({ timestamp: expect.any(String), portalType: 'agent' }); // no alternatives, no marker, no compareId
    expect(deps.log).toHaveBeenCalledWith('ModelCompare: ignoring saved alternatives', expect.any(Object));
  });

  it('domain separation, the other direction: a set token passed as the selectToken is rejected and writes nothing', async () => {
    const { deps, appendMessages } = makeSelect();
    const p: any = payload();
    const out = await go(deps, { ...p, selectToken: p.alternativesToken });
    expect(out.status).toBe(400);
    expect((out.body as any).code).toBe('invalid_select_token');
    expect(appendMessages).not.toHaveBeenCalled();
  });

  it('a chosen answer outside the signed set cannot be saved with alternatives (select token still guards the chosen)', async () => {
    const { deps, appendMessages } = makeSelect();
    // chosen answer swapped for another signed select token: set no longer matches
    const p = payload({ content: 'a different chosen answer' });
    const out = await go(deps, p);
    expect(out.status).toBe(200);
    expect(assistant(appendMessages).metadata).not.toHaveProperty('compareAlternatives');
  });

  it('latencyMs is clamped display data (negative / NaN / huge)', async () => {
    const { deps, appendMessages } = makeSelect();
    await go(deps, payload({}, [{ ...ALT1, latencyMs: -5 }, { ...ALT2, latencyMs: 9e15 }]));
    const stored = assistant(appendMessages).metadata!.compareAlternatives!;
    expect(stored.map((s) => s.latencyMs)).toEqual([0, 3_600_000]);
  });

  describe('replay and one-pair-per-compare are unchanged', () => {
    it('an exact replay returns the existing pair, writes nothing, never rewrites alternatives', async () => {
      const stamp = new Date(NOW).toISOString();
      const history: CompareSession = {
        ...sess(),
        messages: [
          ...sess().messages!,
          { role: 'user', content: 'Compare these', timestamp: stamp, metadata: { timestamp: stamp } },
          { role: 'assistant', content: CHOSEN.content, llm: CHOSEN.model, timestamp: stamp, metadata: { timestamp: stamp } },
        ] as ChatMessage[],
      };
      const { deps, appendMessages } = makeSelect({}, history);
      const out = await go(deps, payload());
      expect(out.status).toBe(200);
      expect((out.body as any).replayed).toBe(true);
      expect(appendMessages).not.toHaveBeenCalled();
      expect(deps.updateSessionModel).not.toHaveBeenCalled();
      expect((out.body as any).messages[1].metadata).toEqual({ timestamp: stamp }); // not rewritten
    });
    it('a second column of the same comparison is still 409 compare_already_selected', async () => {
      const stamp = new Date(NOW).toISOString();
      const history: CompareSession = {
        ...sess(),
        messages: [
          ...sess().messages!,
          { role: 'user', content: 'Compare these', timestamp: stamp, metadata: { timestamp: stamp } },
          { role: 'assistant', content: 'other', llm: 'claude-sonnet-4-6', timestamp: stamp, metadata: { timestamp: stamp } },
        ] as ChatMessage[],
      };
      const { deps, appendMessages } = makeSelect({}, history);
      const out = await go(deps, payload());
      expect(out.status).toBe(409);
      expect((out.body as any).code).toBe('compare_already_selected');
      expect(appendMessages).not.toHaveBeenCalled();
    });
  });

  it('select makes no model call: SelectDeps has no LLM seam, so usage/cost cannot change', () => {
    const { deps } = makeSelect();
    expect(Object.keys(deps).filter((k) => /llm|usage|cost|bill/i.test(k))).toEqual([]);
  });

  describe('size budget', () => {
    const bigPayload = (chars1: number, chars2: number, chosenChars = 100) => {
      const chosen = { model: CHOSEN.model, content: 'c'.repeat(chosenChars) };
      const a1 = { ...ALT1, content: 'a'.repeat(chars1) };
      const a2 = { ...ALT2, content: 'b'.repeat(chars2) };
      const set = signAlternativesToken(SECRET, { userId: OWNER.userId, sessionId: 's-1', compareId: ID, prompt: 'Compare these', issuedAt, columns: [chosen, a1, a2] });
      const f = { sessionId: 's-1', compareId: ID, prompt: 'Compare these', model: chosen.model, content: chosen.content, issuedAt };
      return { ...f, selectToken: signSelectToken(SECRET, { userId: OWNER.userId, ...f }), alternatives: [a1, a2], alternativesToken: set };
    };

    it('over the alternatives budget => NONE stored (not a partial set) + metadata.compareAlternativesOmitted:"size"; chosen intact', async () => {
      const { deps, appendMessages } = makeSelect();
      const out = await go(deps, bigPayload(100_000, 100_000));
      expect(out.status).toBe(200);
      const a = assistant(appendMessages);
      expect(a.content).toBe('c'.repeat(100));
      expect(a.metadata).not.toHaveProperty('compareAlternatives');
      expect(a.metadata).toMatchObject({ compareAlternativesOmitted: 'size', compareId: ID });
      expect(COMPARE_ALTERNATIVES_OMITTED_SIZE).toBe('size');
    });

    it('just under the budget => stored', async () => {
      const { deps, appendMessages } = makeSelect();
      await go(deps, bigPayload(55_000, 55_000));
      const a = assistant(appendMessages);
      expect(a.metadata!.compareAlternatives).toHaveLength(2);
      expect(serializedBytes(a.metadata!.compareAlternatives)).toBeLessThanOrEqual(COMPARE_ALTERNATIVES_BUDGET_BYTES);
    });
  });
});

// ---------------------------------------------------------------------------
describe('size budget by construction (withSavedAlternatives + messageSizeGuard)', () => {
  const alt = (model: string, content: string): SavedAlternative => ({ model, name: model, provider: 'p', content, latencyMs: 1 });
  const base = (content: string): ChatMessage => ({
    role: 'assistant', content, timestamp: '2026-10-12T00:00:00.000Z', llm: 'gpt-5.5',
    metadata: { timestamp: '2026-10-12T00:00:00.000Z', portalType: 'agent' },
  });

  it('the cap is the real persistence cap minus 8 KiB headroom, and the alternatives budget leaves >= 200KB for the chosen answer', async () => {
    const { MAX_MESSAGE_CONTENT_SIZE } = await import('../services/chatbotService');
    expect(COMPARE_ROW_CAP_BYTES).toBe(MAX_MESSAGE_CONTENT_SIZE - 8_192);
    expect(COMPARE_ROW_CAP_BYTES - COMPARE_ALTERNATIVES_BUDGET_BYTES).toBeGreaterThanOrEqual(200_000);
  });

  it('stored rows are always accepted untouched by shrinkMessageForPersistence (same reference, metadata intact)', () => {
    const cases: Array<[string, string, SavedAlternative[]]> = [
      ['small', 'x', [alt('a', 'one'), alt('b', 'two')]],
      ['at budget', 'x'.repeat(200_000), [alt('a', 'q'.repeat(59_000)), alt('b', 'q'.repeat(59_000))]],
      ['ascii worst-case chosen (200k chars) + alternatives at budget', 'x'.repeat(200_000), [alt('a', 'z'.repeat(40_000)), alt('b', 'z'.repeat(40_000)), alt('c', 'z'.repeat(39_000))]],
    ];
    for (const [, chosen, alts] of cases) {
      const out = withSavedAlternatives(base(chosen), 'cmp', alts);
      expect(out.metadata!.compareAlternatives).toBeDefined();
      expect(serializedBytes(out)).toBeLessThanOrEqual(COMPARE_ROW_CAP_BYTES);
      expect(shrinkMessageForPersistence(out, COMPARE_ROW_CAP_BYTES)).toBe(out);
    }
  });

  it('alternatives over the budget => none stored + marker; never partial', () => {
    const out = withSavedAlternatives(base('chosen'), 'cmp', [alt('a', 'q'.repeat(70_000)), alt('b', 'q'.repeat(70_000))]);
    expect(out.metadata).not.toHaveProperty('compareAlternatives');
    expect(out.metadata!.compareAlternativesOmitted).toBe('size');
    expect(out.content).toBe('chosen');
    expect(shrinkMessageForPersistence(out, COMPARE_ROW_CAP_BYTES)).toBe(out);
  });

  it('multi-byte content is measured in UTF-8 BYTES (CJK / emoji / control chars), not characters', () => {
    // 45,000 CJK chars = 135,000 bytes: fewer characters than the budget, more bytes.
    const cjk = withSavedAlternatives(base('chosen'), 'cmp', [alt('a', '漢'.repeat(45_000))]);
    expect(cjk.metadata!.compareAlternativesOmitted).toBe('size');
    const emoji = withSavedAlternatives(base('chosen'), 'cmp', [alt('a', '😀'.repeat(31_000))]); // 124,000 bytes
    expect(emoji.metadata!.compareAlternativesOmitted).toBe('size');
    // control chars JSON-escape to 6 bytes each: 25,000 chars = 150,000 bytes
    const ctrl = withSavedAlternatives(base('chosen'), 'cmp', [alt('a', '\u0001'.repeat(25_000))]);
    expect(ctrl.metadata!.compareAlternativesOmitted).toBe('size');
  });

  it('extreme: a huge chosen answer + alternatives that fit the budget but not the ROW => none stored, chosen answer untouched', () => {
    const chosen = 'x'.repeat(300_000);
    const out = withSavedAlternatives(base(chosen), 'cmp', [alt('a', 'q'.repeat(60_000)), alt('b', 'q'.repeat(30_000))]);
    expect(out.metadata).not.toHaveProperty('compareAlternatives');
    expect(out.metadata!.compareAlternativesOmitted).toBe('size');
    expect(out.content).toBe(chosen);
    expect(serializedBytes(out)).toBeLessThanOrEqual(COMPARE_ROW_CAP_BYTES);
    expect(shrinkMessageForPersistence(out, COMPARE_ROW_CAP_BYTES)).toBe(out);
  });

  it('extreme: a chosen answer already at the cap => message returned UNCHANGED (no marker pushes it over; nothing truncated by us)', () => {
    const overhead = serializedBytes(base(''));
    const chosen = 'x'.repeat(COMPARE_ROW_CAP_BYTES - overhead - 10); // leaves 10 bytes: marker would not fit
    const msg = base(chosen);
    expect(serializedBytes(msg)).toBeLessThanOrEqual(COMPARE_ROW_CAP_BYTES);
    const out = withSavedAlternatives(msg, 'cmp', [alt('a', 'q')]);
    expect(out).toBe(msg);
    expect(shrinkMessageForPersistence(out, COMPARE_ROW_CAP_BYTES)).toBe(out);
  });

  it('the input message is never mutated', () => {
    const msg = base('chosen');
    const snapshot = JSON.stringify(msg);
    withSavedAlternatives(msg, 'cmp', [alt('a', 'q')]);
    withSavedAlternatives(msg, 'cmp', [alt('a', 'q'.repeat(200_000))]);
    expect(JSON.stringify(msg)).toBe(snapshot);
  });
});
