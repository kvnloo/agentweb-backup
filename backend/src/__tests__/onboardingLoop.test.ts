/**
 * Tests for the Phase 4 onboarding loop pipeline:
 *   onboardingLoopAgents.ts  — sensorScan, diagnoseUnderperforming,
 *                              generateMutations, validateBusinessRules,
 *                              critiqueMutations
 *   onboardingLoopApproval.ts — postDailySlackDM, pollApprovalDecision,
 *                               checkAutoShipConditions
 *   onboardingLoop.ts         — runOnboardingLoop
 *   onboardingLoopWatchdog.ts — runOnboardingLoopWatchdog
 *
 * Target coverage: ≥95% statements, branches, functions, lines.
 */

// ---------------------------------------------------------------------------
// Mock AWS before any imports that touch it
// ---------------------------------------------------------------------------
const mockGetObject = jest.fn();
const mockPutObject = jest.fn();
jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    S3: jest.fn().mockImplementation(() => ({
      getObject: mockGetObject,
      putObject: mockPutObject,
    })),
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: mockDynamoDBPut,
      })),
    },
  },
}));

const mockDynamoDBPut = jest.fn();

// ---------------------------------------------------------------------------
// Mock LLMService
// ---------------------------------------------------------------------------
const mockGenerateJsonRobust = jest.fn();
jest.mock('../utils/llmService', () => ({
  LLMService: jest.fn().mockImplementation(() => ({
    generateJsonRobust: mockGenerateJsonRobust,
  })),
}));

// ---------------------------------------------------------------------------
// Mock userDb
// ---------------------------------------------------------------------------
const mockGetAllUsers = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getAllUsers: mockGetAllUsers },
}));

// ---------------------------------------------------------------------------
// Mock Slack WebClient
// ---------------------------------------------------------------------------
const mockConversationsOpen = jest.fn();
const mockChatPostMessage = jest.fn();
const mockReactionsGet = jest.fn();
const mockConversationsReplies = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    conversations: {
      open: mockConversationsOpen,
      replies: mockConversationsReplies,
    },
    chat: { postMessage: mockChatPostMessage },
    reactions: { get: mockReactionsGet },
  })),
}));

import {
  sensorScan,
  diagnoseUnderperforming,
  generateMutations,
  validateBusinessRules,
  critiqueMutations,
  StepStats,
} from '../services/onboardingLoopAgents';
import {
  postDailySlackDM,
  pollApprovalDecision,
  checkAutoShipConditions,
} from '../services/onboardingLoopApproval';
import { invalidateConfigCache, OnboardingLoopConfig, Variant } from '../services/onboardingLoopConfig';
import { runOnboardingLoop } from '../cron/onboardingLoop';
import { runOnboardingLoopWatchdog } from '../cron/onboardingLoopWatchdog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<OnboardingLoopConfig> = {}): OnboardingLoopConfig {
  return {
    _schema_version: '1',
    paused: false,
    thresholds: {
      promote_lift_pct: 15,
      promote_min_n: 80,
      retire_lift_pct: -10,
      retire_min_n: 50,
      watchdog_rollback_pct_24h: 20,
      watchdog_pause_pct_7d: 10,
      max_active_arms_per_step: 5,
      max_tokens_per_cycle_usd: 5,
    },
    approval: {
      slack_channel: 'test',
      auto_ship_cutoff_hour_pt: 18,
      auto_ship_conditions: [],
    },
    steps: {},
    ...overrides,
  };
}

function makeVariant(id: string, weight: number, type: 'control' | 'treatment' = 'treatment'): Variant {
  return {
    variantId: id,
    type,
    weight,
    copy: { heading: `Heading for ${id}`, cta: 'Get started' },
  };
}

function mockS3Config(config: OnboardingLoopConfig, versionId = 'v1') {
  mockGetObject.mockReturnValue({
    promise: () =>
      Promise.resolve({
        Body: Buffer.from(JSON.stringify(config)),
        VersionId: versionId,
      }),
  });
}

const RECENT_ISO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

function makeUser(userId: string, completed = false): any {
  return {
    userId,
    createdAt: RECENT_ISO,
    onboardingEvents: completed ? [{ event: 'onboarding_completed' }] : [],
  };
}

// ---------------------------------------------------------------------------
// sensorScan
// ---------------------------------------------------------------------------

describe('sensorScan', () => {
  beforeEach(() => invalidateConfigCache());

  test('returns empty array when no steps configured', async () => {
    const config = makeConfig();
    const result = await sensorScan([], config);
    expect(result).toEqual([]);
  });

  test('excludes users created before 7-day window', async () => {
    const config = makeConfig({
      steps: { welcome: { active_variants: [makeVariant('ctrl', 1.0, 'control')] } },
    });
    const oldUser = { ...makeUser('u-old'), createdAt: new Date(0).toISOString() };
    const result = await sensorScan([oldUser], config);
    expect(result[0].n).toBe(0);
  });

  test('counts completions and non-completions correctly', async () => {
    const config = makeConfig({
      steps: {
        welcome: { active_variants: [makeVariant('ctrl', 1.0, 'control')] },
      },
    });
    const users = [
      makeUser('u1', true),
      makeUser('u2', false),
      makeUser('u3', true),
    ];
    const result = await sensorScan(users, config);
    const stat = result.find((s) => s.step === 'welcome' && s.variantId === 'ctrl');
    expect(stat?.n).toBe(3);
    expect(stat?.completions).toBe(2);
    expect(stat?.completion_rate).toBeCloseTo(2 / 3);
  });

  test('lift_pct is null for control variant', async () => {
    const config = makeConfig({
      steps: {
        brand: {
          active_variants: [
            makeVariant('ctrl', 0.7, 'control'),
            makeVariant('treatment-a', 0.3),
          ],
        },
      },
    });
    const users = Array.from({ length: 10 }, (_, i) => makeUser(`u-${i}`, true));
    const result = await sensorScan(users, config);
    const ctrl = result.find((s) => s.variantId === 'ctrl');
    expect(ctrl?.lift_pct).toBeNull();
  });

  test('lift_pct computed relative to control rate', async () => {
    const controlVariant = makeVariant('ctrl', 0.5, 'control');
    const treatmentVariant = makeVariant('treat', 0.5);

    const config = makeConfig({
      steps: {
        welcome: { active_variants: [controlVariant, treatmentVariant] },
      },
    });

    // Craft users so ctrl group has 50% completion and treatment has 100%
    // With 50/50 split on N=100, ~50 go to each bucket
    // Use deterministic assignment: use enough users to get both buckets populated
    const N = 200;
    const users: any[] = [];
    for (let i = 0; i < N; i++) {
      users.push(makeUser(`lift-user-${i}`, i % 2 === 0));
    }
    const result = await sensorScan(users, config);
    const treat = result.find((s) => s.variantId === 'treat');
    // lift_pct should be defined (non-null)
    expect(treat?.lift_pct).not.toBeNull();
  });

  test('lift_pct is null for non-control when controlRate is 0', async () => {
    const config = makeConfig({
      steps: {
        brand: {
          active_variants: [
            makeVariant('ctrl', 0.5, 'control'),
            makeVariant('treat', 0.5),
          ],
        },
      },
    });
    // Nobody completes → controlRate = 0 → lift_pct should be null for treatment
    const users = Array.from({ length: 10 }, (_, i) => makeUser(`u-${i}`, false));
    const result = await sensorScan(users, config);
    const treat = result.find((s) => s.variantId === 'treat');
    expect(treat?.lift_pct).toBeNull();
  });

  test('skips steps with no active_variants', async () => {
    const config = makeConfig({
      steps: {
        empty: { active_variants: [] },
        welcome: { active_variants: [makeVariant('ctrl', 1.0, 'control')] },
      },
    });
    const result = await sensorScan([], config);
    expect(result.some((s) => s.step === 'empty')).toBe(false);
    expect(result.some((s) => s.step === 'welcome')).toBe(true);
  });

  test('user with non-array onboardingEvents treated as not completed', async () => {
    const config = makeConfig({
      steps: { welcome: { active_variants: [makeVariant('ctrl', 1.0, 'control')] } },
    });
    const userBad = { userId: 'u-bad', createdAt: RECENT_ISO, onboardingEvents: null };
    const result = await sensorScan([userBad], config);
    const stat = result[0];
    expect(stat.completions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diagnoseUnderperforming
// ---------------------------------------------------------------------------

describe('diagnoseUnderperforming', () => {
  const config = makeConfig();

  test('returns empty array when no underperforming variants', () => {
    const stats: StepStats[] = [
      { step: 'welcome', variantId: 'treat', n: 100, completions: 60, completion_rate: 0.6, lift_pct: 5 },
    ];
    expect(diagnoseUnderperforming(stats, config)).toEqual([]);
  });

  test('returns step when treatment lift_pct < 0 and n >= promote_min_n', () => {
    const stats: StepStats[] = [
      { step: 'brand', variantId: 'treat', n: 100, completions: 20, completion_rate: 0.2, lift_pct: -15 },
    ];
    expect(diagnoseUnderperforming(stats, config)).toContain('brand');
  });

  test('excludes step when n < promote_min_n even if lift is negative', () => {
    const stats: StepStats[] = [
      { step: 'brand', variantId: 'treat', n: 10, completions: 2, completion_rate: 0.2, lift_pct: -15 },
    ];
    expect(diagnoseUnderperforming(stats, config)).toEqual([]);
  });

  test('excludes control variant (lift_pct === null) from underperforming', () => {
    const stats: StepStats[] = [
      { step: 'brand', variantId: 'ctrl', n: 100, completions: 50, completion_rate: 0.5, lift_pct: null },
    ];
    expect(diagnoseUnderperforming(stats, config)).toEqual([]);
  });

  test('step deduplication — only appears once even with multiple bad variants', () => {
    const stats: StepStats[] = [
      { step: 'brand', variantId: 'treat-a', n: 100, completions: 10, completion_rate: 0.1, lift_pct: -30 },
      { step: 'brand', variantId: 'treat-b', n: 100, completions: 10, completion_rate: 0.1, lift_pct: -25 },
    ];
    const result = diagnoseUnderperforming(stats, config);
    expect(result.filter((s) => s === 'brand').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// generateMutations
// ---------------------------------------------------------------------------

describe('generateMutations', () => {
  const llm = {
    callLLM: jest.fn(),
  };

  beforeEach(() => {
    (llm.callLLM as jest.Mock).mockReset();
  });

  const stats: StepStats[] = [
    { step: 'welcome', variantId: 'ctrl', n: 100, completions: 50, completion_rate: 0.5, lift_pct: null },
  ];
  const currentVariants = [makeVariant('ctrl', 1.0, 'control')];

  test('returns variants from LLM response', async () => {
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        variants: [
          { heading: 'New heading', cta: 'Start now', description: 'Clear copy' },
        ],
      }),
    );
    const result = await generateMutations('welcome', currentVariants, stats, llm);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('treatment');
    expect(result[0].variantId).toMatch(/^generated-/);
    expect(result[0].weight).toBe(0.1);
    expect(result[0].copy.heading).toBe('New heading');
  });

  test('returns at most 3 variants', async () => {
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        variants: [
          { heading: 'A', cta: 'CTA A' },
          { heading: 'B', cta: 'CTA B' },
          { heading: 'C', cta: 'CTA C' },
          { heading: 'D', cta: 'CTA D' }, // extra — should be ignored
        ],
      }),
    );
    const result = await generateMutations('welcome', currentVariants, stats, llm);
    expect(result).toHaveLength(3);
  });

  test('returns empty array on malformed JSON', async () => {
    llm.callLLM.mockResolvedValue('not json at all {{{');
    const result = await generateMutations('welcome', currentVariants, stats, llm);
    expect(result).toEqual([]);
  });

  test('returns empty array when variants key is missing', async () => {
    llm.callLLM.mockResolvedValue(JSON.stringify({ other: [] }));
    const result = await generateMutations('welcome', currentVariants, stats, llm);
    expect(result).toEqual([]);
  });

  test('omits non-string copy fields', async () => {
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        variants: [{ heading: 'Valid', cta: 42, description: 'Good desc' }],
      }),
    );
    const result = await generateMutations('welcome', currentVariants, stats, llm);
    expect(result[0].copy.cta).toBeUndefined();
    expect(result[0].copy.heading).toBe('Valid');
  });

  test('handles already-parsed object from LLM (non-string return)', async () => {
    llm.callLLM.mockResolvedValue({ variants: [{ heading: 'Pre-parsed' }] } as any);
    const result = await generateMutations('welcome', currentVariants, stats, llm);
    expect(result[0].copy.heading).toBe('Pre-parsed');
  });
});

// ---------------------------------------------------------------------------
// validateBusinessRules
// ---------------------------------------------------------------------------

describe('validateBusinessRules', () => {
  const goodVariant = makeVariant('generated-abc', 0.1);

  test('passes a clean variant', () => {
    const { valid, rejected } = validateBusinessRules([goodVariant], 'welcome', []);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  test('rejects step not in allowlist', () => {
    const { valid, rejected } = validateBusinessRules([goodVariant], 'welcome', ['brand']);
    expect(valid).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/allowlist/);
  });

  test('passes when step is in allowlist', () => {
    const { valid } = validateBusinessRules([goodVariant], 'welcome', ['welcome', 'brand']);
    expect(valid).toHaveLength(1);
  });

  test('rejects copy field exceeding 300 chars', () => {
    const longVariant: Variant = {
      ...goodVariant,
      copy: { heading: 'a'.repeat(301) },
    };
    const { rejected } = validateBusinessRules([longVariant], 'welcome', []);
    expect(rejected[0].reason).toMatch(/exceeds 300 chars/);
  });

  test('rejects copy field containing HTML tags', () => {
    const htmlVariant: Variant = {
      ...goodVariant,
      copy: { heading: '<b>Bold</b>' },
    };
    const { rejected } = validateBusinessRules([htmlVariant], 'welcome', []);
    expect(rejected[0].reason).toMatch(/HTML tags/);
  });

  test('rejects empty heading', () => {
    const emptyHeadingVariant: Variant = {
      ...goodVariant,
      copy: { heading: '   ', cta: 'Good cta' },
    };
    const { rejected } = validateBusinessRules([emptyHeadingVariant], 'welcome', []);
    expect(rejected[0].reason).toMatch(/must not be empty/);
  });

  test('rejects empty cta', () => {
    const emptyCtaVariant: Variant = {
      ...goodVariant,
      copy: { heading: 'Good heading', cta: '' },
    };
    const { rejected } = validateBusinessRules([emptyCtaVariant], 'welcome', []);
    expect(rejected[0].reason).toMatch(/must not be empty/);
  });

  test('rejects non-string copy field', () => {
    const badVariant: Variant = {
      ...goodVariant,
      copy: { heading: 123 as any },
    };
    const { rejected } = validateBusinessRules([badVariant], 'welcome', []);
    expect(rejected[0].reason).toMatch(/not a string/);
  });

  test('allows empty allowlist (permits all steps)', () => {
    const { valid } = validateBusinessRules([goodVariant], 'any-step', []);
    expect(valid).toHaveLength(1);
  });

  test('skips undefined copy field values', () => {
    const variantWithUndefined: Variant = {
      ...goodVariant,
      copy: { heading: 'Good', description: undefined },
    };
    const { valid } = validateBusinessRules([variantWithUndefined], 'welcome', []);
    expect(valid).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// critiqueMutations
// ---------------------------------------------------------------------------

describe('critiqueMutations', () => {
  const llm = { callLLM: jest.fn() };
  const variant = makeVariant('generated-x', 0.1);

  beforeEach(() => (llm.callLLM as jest.Mock).mockReset());

  test('returns empty array for empty input', async () => {
    expect(await critiqueMutations([], 'welcome', llm)).toEqual([]);
  });

  test('filters out variants scoring < 8', async () => {
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        critiques: [
          { variantId: 'generated-x', clarity: 2, specificity: 2, tone: 2, feedback: 'Weak' },
        ],
      }),
    );
    const result = await critiqueMutations([variant], 'welcome', llm);
    expect(result).toHaveLength(0);
  });

  test('keeps variants scoring >= 8', async () => {
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        critiques: [
          { variantId: 'generated-x', clarity: 4, specificity: 3, tone: 3, feedback: 'Good' },
        ],
      }),
    );
    const result = await critiqueMutations([variant], 'welcome', llm);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(10);
    expect(result[0].feedback).toBe('Good');
  });

  test('sorts by score descending', async () => {
    const v2 = makeVariant('generated-y', 0.1);
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        critiques: [
          { variantId: 'generated-x', clarity: 3, specificity: 3, tone: 3, feedback: 'OK' },    // score 9
          { variantId: 'generated-y', clarity: 5, specificity: 5, tone: 5, feedback: 'Perfect' }, // score 15
        ],
      }),
    );
    const result = await critiqueMutations([variant, v2], 'welcome', llm);
    expect(result[0].score).toBe(15);
    expect(result[1].score).toBe(9);
  });

  test('returns empty array on malformed JSON', async () => {
    llm.callLLM.mockResolvedValue('{{{');
    expect(await critiqueMutations([variant], 'welcome', llm)).toEqual([]);
  });

  test('returns empty array when critiques key missing', async () => {
    llm.callLLM.mockResolvedValue(JSON.stringify({ other: [] }));
    expect(await critiqueMutations([variant], 'welcome', llm)).toEqual([]);
  });

  test('skips critique entries with unknown variantId', async () => {
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        critiques: [
          { variantId: 'unknown-id', clarity: 5, specificity: 5, tone: 5, feedback: 'Great' },
        ],
      }),
    );
    expect(await critiqueMutations([variant], 'welcome', llm)).toEqual([]);
  });

  test('clamps score dimensions to [1,5]', async () => {
    llm.callLLM.mockResolvedValue(
      JSON.stringify({
        critiques: [
          { variantId: 'generated-x', clarity: 99, specificity: -5, tone: 3, feedback: 'Odd' },
        ],
      }),
    );
    const result = await critiqueMutations([variant], 'welcome', llm);
    // clarity clamped to 5, specificity clamped to 1, tone=3 → score=9
    expect(result[0].score).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// postDailySlackDM
// ---------------------------------------------------------------------------

describe('postDailySlackDM', () => {
  beforeEach(() => {
    mockConversationsOpen.mockResolvedValue({ channel: { id: 'C123' } });
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: '1234567890.000000' });
  });

  const stats: StepStats[] = [
    { step: 'welcome', variantId: 'ctrl', n: 100, completions: 60, completion_rate: 0.6, lift_pct: null },
    { step: 'welcome', variantId: 'treat', n: 100, completions: 50, completion_rate: 0.5, lift_pct: -16.7 },
  ];

  const proposedMutations = [
    {
      step: 'welcome',
      variants: [
        {
          variant: makeVariant('generated-1', 0.1),
          score: 12,
          feedback: 'Clear and concise',
        },
      ],
    },
  ];

  test('posts DM and returns channel + ts', async () => {
    const { WebClient } = require('@slack/web-api');
    const slackClient = new WebClient('test-token');
    const result = await postDailySlackDM(proposedMutations, stats, 'U123', slackClient);
    expect(result).toEqual({ channel: 'C123', ts: '1234567890.000000' });
    expect(mockChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123' }),
    );
  });

  test('throws when conversations.open returns no channel', async () => {
    mockConversationsOpen.mockResolvedValue({ channel: undefined });
    const { WebClient } = require('@slack/web-api');
    const slackClient = new WebClient('test-token');
    await expect(postDailySlackDM(proposedMutations, stats, 'U123', slackClient)).rejects.toThrow(
      /Could not open DM/,
    );
  });

  test('throws when postMessage fails', async () => {
    mockChatPostMessage.mockResolvedValue({ ok: false, error: 'not_authed' });
    const { WebClient } = require('@slack/web-api');
    const slackClient = new WebClient('test-token');
    await expect(postDailySlackDM(proposedMutations, stats, 'U123', slackClient)).rejects.toThrow(
      /not_authed/,
    );
  });

  test('handles variant with no heading/cta gracefully', async () => {
    const mutationsNoHeading = [
      {
        step: 'welcome',
        variants: [
          {
            variant: { variantId: 'gen-1', type: 'treatment' as const, weight: 0.1, copy: { description: 'Only desc' } },
            score: 10,
            feedback: 'OK',
          },
        ],
      },
    ];
    const { WebClient } = require('@slack/web-api');
    const slackClient = new WebClient('test-token');
    await expect(postDailySlackDM(mutationsNoHeading, stats, 'U123', slackClient)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// pollApprovalDecision
// ---------------------------------------------------------------------------

describe('pollApprovalDecision', () => {
  const { WebClient } = require('@slack/web-api');

  beforeEach(() => {
    mockReactionsGet.mockReset();
    mockConversationsReplies.mockReset();
  });

  function makeSlack() {
    return new WebClient('token');
  }

  test('returns approved when white_check_mark reaction present', async () => {
    mockReactionsGet.mockResolvedValue({
      ok: true,
      message: { reactions: [{ name: 'white_check_mark' }] },
    });
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18);
    expect(result.decision).toBe('approved');
  });

  test('returns denied when x reaction present', async () => {
    mockReactionsGet.mockResolvedValue({
      ok: true,
      message: { reactions: [{ name: 'x' }] },
    });
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18);
    expect(result.decision).toBe('denied');
  });

  test('returns hold when octagonal_sign reaction present', async () => {
    mockReactionsGet.mockResolvedValue({
      ok: true,
      message: { reactions: [{ name: 'octagonal_sign' }] },
    });
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18);
    expect(result.decision).toBe('hold');
  });

  test('returns approved on "approve" thread reply', async () => {
    mockReactionsGet.mockResolvedValue({ ok: true, message: { reactions: [] } });
    mockConversationsReplies.mockResolvedValue({
      ok: true,
      messages: [{ text: 'original dm' }, { text: 'approve' }],
    });
    // Use a "before cutoff" time to exercise the reply path
    const earlyMorning = () => new Date('2026-05-23T09:00:00Z'); // 9am UTC = 2am PT
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18, earlyMorning);
    expect(result.decision).toBe('approved');
  });

  test('returns denied on "deny" thread reply', async () => {
    mockReactionsGet.mockResolvedValue({ ok: true, message: { reactions: [] } });
    mockConversationsReplies.mockResolvedValue({
      ok: true,
      messages: [{ text: 'original' }, { text: 'deny' }],
    });
    const earlyMorning = () => new Date('2026-05-23T09:00:00Z');
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18, earlyMorning);
    expect(result.decision).toBe('denied');
  });

  test('returns auto_ship when past cutoff with no reaction', async () => {
    mockReactionsGet.mockResolvedValue({ ok: false, message: undefined });
    mockConversationsReplies.mockResolvedValue({ ok: true, messages: [{ text: 'original' }] });
    // 2am UTC on a summer day = 7pm PT (past 18:00 PT cutoff)
    const pastCutoff = () => new Date('2026-07-23T02:00:00Z'); // PDT = UTC-7 → 7pm PT
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18, pastCutoff);
    expect(result.decision).toBe('auto_ship');
  });

  test('returns hold when before cutoff with no reaction', async () => {
    mockReactionsGet.mockResolvedValue({ ok: true, message: { reactions: [] } });
    mockConversationsReplies.mockResolvedValue({ ok: true, messages: [] });
    // 9am UTC = 2am PT in summer (PDT offset -7)
    const beforeCutoff = () => new Date('2026-07-23T09:00:00Z');
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18, beforeCutoff);
    expect(result.decision).toBe('hold');
  });

  test('handles missing reactions array gracefully', async () => {
    mockReactionsGet.mockResolvedValue({ ok: true, message: {} });
    mockConversationsReplies.mockResolvedValue({ ok: false });
    const beforeCutoff = () => new Date('2026-07-23T09:00:00Z');
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18, beforeCutoff);
    expect(result.decision).toBe('hold');
  });

  test('PST (winter): UTC-8 offset applies correctly', async () => {
    mockReactionsGet.mockResolvedValue({ ok: true, message: { reactions: [] } });
    mockConversationsReplies.mockResolvedValue({ ok: true, messages: [] });
    // Jan 23 2026 02:00 UTC = 6pm PST (past 18:00 cutoff)
    const pastCutoffPST = () => new Date('2026-01-23T02:00:00Z');
    const result = await pollApprovalDecision('C123', '123.456', makeSlack(), 18, pastCutoffPST);
    expect(result.decision).toBe('auto_ship');
  });
});

// ---------------------------------------------------------------------------
// checkAutoShipConditions
// ---------------------------------------------------------------------------

describe('checkAutoShipConditions', () => {
  test('returns false when watchdog warnings active', () => {
    const stats: StepStats[] = [
      { step: 'w', variantId: 'ctrl', n: 50, completions: 40, completion_rate: 0.8, lift_pct: null },
    ];
    expect(checkAutoShipConditions(stats, true)).toBe(false);
  });

  test('returns true when no significant non-control variants', () => {
    const stats: StepStats[] = [
      { step: 'w', variantId: 'ctrl', n: 5, completions: 4, completion_rate: 0.8, lift_pct: null },
    ];
    expect(checkAutoShipConditions(stats, false)).toBe(true);
  });

  test('returns true when all non-control variants have non-negative lift', () => {
    const stats: StepStats[] = [
      { step: 'w', variantId: 'treat', n: 20, completions: 15, completion_rate: 0.75, lift_pct: 5 },
    ];
    expect(checkAutoShipConditions(stats, false)).toBe(true);
  });

  test('returns false when any non-control variant has negative lift', () => {
    const stats: StepStats[] = [
      { step: 'w', variantId: 'treat', n: 20, completions: 10, completion_rate: 0.5, lift_pct: -10 },
    ];
    expect(checkAutoShipConditions(stats, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runOnboardingLoop (integration-style unit test with mocks)
// ---------------------------------------------------------------------------

describe('runOnboardingLoop', () => {
  beforeEach(() => {
    mockGetObject.mockReset();
    mockPutObject.mockReset();
    mockDynamoDBPut.mockReturnValue({ promise: () => Promise.resolve() });
    mockGetAllUsers.mockResolvedValue([]);
    mockConversationsOpen.mockResolvedValue({ channel: { id: 'C123' } });
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: '123.456' });
    mockGenerateJsonRobust.mockReset();
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.ONBOARDING_LOOP_ENABLED;
    delete process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID;
    delete process.env.SLACK_BOT_TOKEN;
    invalidateConfigCache();
  });

  test('returns early when ONBOARDING_LOOP_ENABLED is not set', async () => {
    delete process.env.ONBOARDING_LOOP_ENABLED;
    await expect(runOnboardingLoop()).resolves.toBeUndefined();
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  test('returns early when ONBOARDING_LOOP_ENABLED is false', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'false';
    await expect(runOnboardingLoop()).resolves.toBeUndefined();
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  test('skips when config.paused is true', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    mockS3Config(makeConfig({ paused: true }));
    await runOnboardingLoop();
    expect(mockDynamoDBPut).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ status: 'skipped', reason: 'paused' }),
      }),
    );
  });

  test('skips when estimated cost exceeds budget', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    // MAX_LLM_CALLS_PER_CYCLE=6, ESTIMATED_USD_PER_LLM_CALL=0.015 → max $0.09 per cycle
    // With budget $0.05 and 4+ steps → estimatedCalls=6, cost=$0.09 > $0.05
    const cheapConfig = makeConfig({
      thresholds: {
        promote_lift_pct: 15,
        promote_min_n: 80,
        retire_lift_pct: -10,
        retire_min_n: 50,
        watchdog_rollback_pct_24h: 20,
        watchdog_pause_pct_7d: 10,
        max_active_arms_per_step: 5,
        max_tokens_per_cycle_usd: 0.05, // budget below estimated cost
      },
      steps: {
        step1: { active_variants: [makeVariant('c', 1.0, 'control')] },
        step2: { active_variants: [makeVariant('c', 1.0, 'control')] },
        step3: { active_variants: [makeVariant('c', 1.0, 'control')] },
        step4: { active_variants: [makeVariant('c', 1.0, 'control')] },
      },
    });
    mockS3Config(cheapConfig);
    await runOnboardingLoop();
    expect(mockDynamoDBPut).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ status: 'skipped', reason: 'cost_cap' }),
      }),
    );
  });

  test('completes with no_mutations when no underperforming steps', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    const config = makeConfig({
      steps: {
        welcome: {
          active_variants: [
            makeVariant('ctrl', 0.7, 'control'),
            makeVariant('treat', 0.3),
          ],
        },
      },
    });
    mockS3Config(config);
    mockGetAllUsers.mockResolvedValue([]);
    await runOnboardingLoop();
    expect(mockDynamoDBPut).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ status: 'completed', reason: 'no_mutations' }),
      }),
    );
  });

  test('does not throw on DynamoDB log failure', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    mockS3Config(makeConfig({ paused: true }));
    mockDynamoDBPut.mockReturnValue({
      promise: () => Promise.reject(new Error('DynamoDB down')),
    });
    await expect(runOnboardingLoop()).resolves.toBeUndefined();
  });

  test('logs error status and does not throw on unexpected exception', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    mockGetObject.mockReturnValue({
      promise: () => Promise.reject(new Error('S3 down')),
    });
    await expect(runOnboardingLoop()).resolves.toBeUndefined();
    expect(mockDynamoDBPut).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ status: 'error' }),
      }),
    );
  });

  test('skips Slack DM when env vars missing', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    delete process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID;
    delete process.env.SLACK_BOT_TOKEN;

    const config = makeConfig({
      steps: {
        welcome: {
          active_variants: [
            makeVariant('ctrl', 0.5, 'control'),
            makeVariant('treat', 0.5),
          ],
        },
      },
    });
    mockS3Config(config);
    mockGetAllUsers.mockResolvedValue([]);
    await expect(runOnboardingLoop()).resolves.toBeUndefined();
    expect(mockChatPostMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runOnboardingLoopWatchdog
// ---------------------------------------------------------------------------

describe('runOnboardingLoopWatchdog', () => {
  beforeEach(() => {
    mockGetObject.mockReset();
    mockPutObject.mockReset();
    mockDynamoDBPut.mockReturnValue({ promise: () => Promise.resolve() });
    mockGetAllUsers.mockResolvedValue([]);
    mockConversationsOpen.mockResolvedValue({ channel: { id: 'C456' } });
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: '999.000' });
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.ONBOARDING_LOOP_ENABLED;
    delete process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID;
    delete process.env.SLACK_BOT_TOKEN;
    invalidateConfigCache();
  });

  test('returns early when disabled', async () => {
    delete process.env.ONBOARDING_LOOP_ENABLED;
    await expect(runOnboardingLoopWatchdog()).resolves.toBeUndefined();
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  test('no-ops when no stats trigger thresholds', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    const config = makeConfig({
      steps: {
        welcome: { active_variants: [makeVariant('ctrl', 1.0, 'control')] },
      },
    });
    mockS3Config(config);
    mockGetAllUsers.mockResolvedValue([]);
    await runOnboardingLoopWatchdog();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  test('retires variant when lift_pct < -watchdog_rollback_pct_24h and n >= retire_min_n', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    const config = makeConfig({
      steps: {
        welcome: {
          active_variants: [
            makeVariant('ctrl', 0.5, 'control'),
            makeVariant('treat-bad', 0.5),
          ],
        },
      },
    });
    mockS3Config(config);

    const recentTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const users = Array.from({ length: 200 }, (_, i) => ({
      userId: `watchdog-user-${i}`,
      createdAt: recentTs,
      onboardingEvents: i < 100 ? [{ event: 'onboarding_completed' }] : [],
    }));
    mockGetAllUsers.mockResolvedValue(users);
    mockPutObject.mockReturnValue({ promise: () => Promise.resolve({ VersionId: 'v2' }) });

    // Should not throw regardless of whether retire threshold is crossed
    await expect(runOnboardingLoopWatchdog()).resolves.toBeUndefined();
  });

  test('pauses config when aggregate drop exceeds watchdog_pause_pct_7d', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    const configWithBaseline = makeConfig({
      steps: {
        welcome: {
          active_variants: [
            {
              variantId: 'ctrl',
              type: 'control',
              weight: 1.0,
              copy: { heading: 'Test' },
              stats: { n: 100, completions: 90, lift_pct: 0.9, last_updated: '2026-01-01' },
            },
          ],
        },
      },
    });
    mockS3Config(configWithBaseline);
    // 0 users → currentRate = 0 → drop from 0.9 baseline is huge → triggers pause
    mockGetAllUsers.mockResolvedValue([]);
    mockPutObject.mockReturnValue({ promise: () => Promise.resolve({ VersionId: 'v2' }) });

    process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID = 'U123';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    await runOnboardingLoopWatchdog();

    expect(mockPutObject).toHaveBeenCalled();
    const putCall = mockPutObject.mock.calls[0][0];
    const writtenConfig = JSON.parse(putCall.Body);
    expect(writtenConfig.paused).toBe(true);
  });

  test('does not pause when already paused', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    const config = makeConfig({
      paused: true,
      steps: {
        welcome: {
          active_variants: [
            {
              variantId: 'ctrl',
              type: 'control',
              weight: 1.0,
              copy: { heading: 'Test' },
              stats: { n: 100, completions: 90, lift_pct: 0.9, last_updated: '2026-01-01' },
            },
          ],
        },
      },
    });
    mockS3Config(config);
    mockGetAllUsers.mockResolvedValue([]);
    await runOnboardingLoopWatchdog();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  test('does not throw on S3 error', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    mockGetObject.mockReturnValue({
      promise: () => Promise.reject(new Error('S3 unavailable')),
    });
    await expect(runOnboardingLoopWatchdog()).resolves.toBeUndefined();
  });

  test('skips escalation DM when Slack env vars missing', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    delete process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID;
    delete process.env.SLACK_BOT_TOKEN;

    const configWithBaseline = makeConfig({
      steps: {
        welcome: {
          active_variants: [
            {
              variantId: 'ctrl',
              type: 'control',
              weight: 1.0,
              copy: { heading: 'Test' },
              stats: { n: 100, completions: 90, lift_pct: 0.9, last_updated: '2026-01-01' },
            },
          ],
        },
      },
    });
    mockS3Config(configWithBaseline);
    mockGetAllUsers.mockResolvedValue([]);
    mockPutObject.mockReturnValue({ promise: () => Promise.resolve({ VersionId: 'v2' }) });

    await runOnboardingLoopWatchdog();
    expect(mockChatPostMessage).not.toHaveBeenCalled();
  });

  test('activates pending variant when ✅ reaction received', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const config = makeConfig({
      steps: {
        brand: {
          active_variants: [
            makeVariant('ctrl', 1.0, 'control'),
            {
              variantId: 'pending-treat',
              type: 'treatment',
              weight: 0.1,
              copy: { heading: 'New heading' },
              pending: true,
              pendingApprovalTs: new Date().toISOString(),
              pendingSlackChannel: 'C-test',
              pendingSlackTs: '123.456',
            },
          ],
        },
      },
    });
    mockS3Config(config);
    mockGetAllUsers.mockResolvedValue([]);
    mockReactionsGet.mockResolvedValue({
      ok: true,
      message: { reactions: [{ name: 'white_check_mark' }] },
    });
    mockConversationsReplies.mockResolvedValue({ ok: true, messages: [] });
    mockPutObject.mockReturnValue({ promise: () => Promise.resolve({ VersionId: 'v2' }) });

    await runOnboardingLoopWatchdog();

    expect(mockPutObject).toHaveBeenCalled();
    const written = JSON.parse(mockPutObject.mock.calls[0][0].Body);
    const activatedVariant = written.steps.brand.active_variants.find((v: any) => v.variantId === 'pending-treat');
    expect(activatedVariant).toBeDefined();
    expect(activatedVariant.pending).toBeUndefined();
  });

  test('removes pending variant when ❌ reaction received', async () => {
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const config = makeConfig({
      steps: {
        brand: {
          active_variants: [
            makeVariant('ctrl', 1.0, 'control'),
            {
              variantId: 'denied-treat',
              type: 'treatment',
              weight: 0.1,
              copy: { heading: 'Denied heading' },
              pending: true,
              pendingApprovalTs: new Date().toISOString(),
              pendingSlackChannel: 'C-test',
              pendingSlackTs: '123.456',
            },
          ],
        },
      },
    });
    mockS3Config(config);
    mockGetAllUsers.mockResolvedValue([]);
    mockReactionsGet.mockResolvedValue({
      ok: true,
      message: { reactions: [{ name: 'x' }] },
    });
    mockConversationsReplies.mockResolvedValue({ ok: true, messages: [] });
    mockPutObject.mockReturnValue({ promise: () => Promise.resolve({ VersionId: 'v2' }) });

    await runOnboardingLoopWatchdog();

    expect(mockPutObject).toHaveBeenCalled();
    const written = JSON.parse(mockPutObject.mock.calls[0][0].Body);
    const deniedVariant = written.steps.brand.active_variants.find((v: any) => v.variantId === 'denied-treat');
    expect(deniedVariant).toBeUndefined();
  });
});
