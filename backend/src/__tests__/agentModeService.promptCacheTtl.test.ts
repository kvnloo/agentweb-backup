/**
 * ENG-893 — extended (1-hour) prompt-cache TTL on the Bedrock Converse path.
 *
 * Long, human-paced agent-mode sessions were paying ~77% of their bill in
 * cache-WRITE churn: every time the user took longer than the default 5-minute
 * prompt-cache TTL to reply, the whole 100k+ token prefix was re-written at
 * 1.25x the input rate instead of being read back at 0.1x.
 *
 * The Converse API accepts `cachePoint: { type: 'default', ttl: '1h' }`. These
 * tests pin (a) that we ask for it on the models we have verified honour it,
 * (b) that we do NOT ask for it on the rest, and (c) that cache writes bill at
 * the rate for the TTL Bedrock actually APPLIED.
 *
 * (b) and (c) are not the same guard. Bedrock does NOT reject an unsupported
 * `ttl` — probed live in us-west-2, models AWS documents as 5-minute-only
 * accept the field — so the allowlist cannot protect us from a crash. What
 * protects the ledger is (c): billing off `usage.cacheDetails` means asking for
 * 1h and being served 5m costs 1.25x, not 2x.
 */

import { AgentModeService } from '../services/agentModeService';
import { getModelPrice, MODEL_PRICING, cacheWriteCost } from '../utils/llmPricing';
import {
  BEDROCK_EXTENDED_CACHE_TTL_MODELS,
  bedrockCacheTtl,
} from '../utils/bedrockInferenceProfiles';

jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(),
      scan: jest.fn(), query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('test-bedrock-bearer-token'),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockBedrockSend,
  })),
  ConverseCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

/** A 4-message conversation, so the wrapper emits BOTH cache points. */
const CONVERSATION = [
  { role: 'system', content: 'System prompt here' },
  { role: 'user', content: 'First message' },
  { role: 'assistant', content: 'First response' },
  { role: 'user', content: 'Second message' },
];

function lastBlockOfPivot(input: any): any {
  const pivot = input.messages[input.messages.length - 2];
  return pivot.content[pivot.content.length - 1];
}

describe('ENG-893 — Bedrock prompt-cache TTL', () => {
  describe('bedrockCacheTtl', () => {
    it('returns 1h for models whose Bedrock model card lists a 1-hour TTL', () => {
      expect(bedrockCacheTtl('anthropic.claude-opus-5')).toBe('1h');
      expect(bedrockCacheTtl('anthropic.claude-sonnet-5')).toBe('1h');
      expect(bedrockCacheTtl('anthropic.claude-opus-4-8')).toBe('1h');
      // Live-verified against the docs table, which is stale — see ENG-893.
      expect(bedrockCacheTtl('anthropic.claude-sonnet-4-6')).toBe('1h');
      expect(bedrockCacheTtl('anthropic.claude-opus-4-6-v1')).toBe('1h');
    });

    it('returns undefined for a Bedrock model we have not verified', () => {
      // Every model we currently SERVE is verified 1h-capable, so the negative
      // branch is reached only by a model we have not measured — an older id,
      // or the next one AWS ships. It must default to today's 5-minute
      // behaviour rather than opting itself in.
      expect(bedrockCacheTtl('anthropic.claude-3-7-sonnet-20250219-v1:0')).toBeUndefined();
      expect(bedrockCacheTtl('anthropic.claude-opus-4-20250514-v1:0')).toBeUndefined();
    });

    it('returns undefined for non-Bedrock and unknown model ids', () => {
      expect(bedrockCacheTtl('gpt-5-chat-2')).toBeUndefined();
      expect(bedrockCacheTtl('gemini-3.1-pro-preview')).toBeUndefined();
      expect(bedrockCacheTtl('')).toBeUndefined();
      // Prototype members must not resolve as if they were mapped model ids.
      expect(bedrockCacheTtl('constructor')).toBeUndefined();
    });
  });

  describe('cachePoint markers on the Converse request', () => {
    let agentModeService: AgentModeService;

    beforeEach(() => {
      agentModeService = new AgentModeService();
      jest.clearAllMocks();
      process.env.AWS_REGION = 'us-west-2';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';

      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'response' }] } },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 80,
          cacheWriteInputTokens: 0,
        },
        stopReason: 'end_turn',
      });
    });

    afterEach(() => {
      delete process.env.AWS_REGION;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    });

    it('asks for the 1h TTL on the system cache point for an extended-TTL model', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION, { humanPaced: true });

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.system).toEqual([
        { text: 'System prompt here' },
        { cachePoint: { type: 'default', ttl: '1h' } },
      ]);
    });

    it('asks for the 1h TTL on the conversation-prefix cache point too', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION, { humanPaced: true });

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      // The history — not the ~14k-token system prompt — is the bulk of the
      // 80k-185k re-caches, so the message checkpoint is the one that matters.
      expect(lastBlockOfPivot(input)).toEqual({ cachePoint: { type: 'default', ttl: '1h' } });
    });

    it('emits two independent cachePoint objects (no shared reference)', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION, { humanPaced: true });

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      const systemPoint = input.system[input.system.length - 1];
      expect(systemPoint).not.toBe(lastBlockOfPivot(input));
    });

    it('omits ttl entirely on an unverified Bedrock model', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      // No SERVED model takes this branch today, so register a stand-in for the
      // next Bedrock model added: it must send the bare block until someone
      // measures it and adds it to the allowlist.
      const unverified = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
      (agentModeService as any).llmModels[unverified] = { client: null, supportsTemperature: true };

      await (agentModeService as any).callLLM(unverified, CONVERSATION, { humanPaced: true });

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.system[input.system.length - 1]).toEqual({ cachePoint: { type: 'default' } });
      expect(lastBlockOfPivot(input)).toEqual({ cachePoint: { type: 'default' } });
    });

    it('omits the 1h TTL by DEFAULT, so a caller that never considered pacing pays 1.25x', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      // No `humanPaced` at all — scheduled runs, loops, one-shot judges and any
      // future call site land here and keep today's 5-minute behaviour.
      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION);

      // A 1h write costs 2x vs 1.25x, and a hit refreshes the TTL for free, so
      // scheduled runs firing turns back-to-back would pay the surcharge and
      // get nothing — measured at +43% of their cache-write spend.
      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.system[input.system.length - 1]).toEqual({ cachePoint: { type: 'default' } });
      expect(lastBlockOfPivot(input)).toEqual({ cachePoint: { type: 'default' } });
    });

    it('does not let one session\'s pacing leak into the next via the cached client', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      // The Bedrock client is memoised on the model registry and shared by every
      // session in the process. Resolving the TTL when the client is BUILT would
      // pin whichever pacing happened to construct it first.
      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION, {
        humanPaced: false,
      });
      const scheduled = (ConverseCommand as jest.Mock).mock.calls[0][0];

      (ConverseCommand as jest.Mock).mockClear();
      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION, {
        humanPaced: true,
      });
      const interactive = (ConverseCommand as jest.Mock).mock.calls[0][0];

      expect(scheduled.system[scheduled.system.length - 1]).toEqual({
        cachePoint: { type: 'default' },
      });
      expect(interactive.system[interactive.system.length - 1]).toEqual({
        cachePoint: { type: 'default', ttl: '1h' },
      });
    });

    it('never leaks the humanPaced hint into a non-Bedrock request body', async () => {
      // `params` is handed verbatim to client.chat.completions.create() for
      // every provider and the OpenAI SDK forwards unknown body fields to the
      // API, where Azure returns 400 on an unrecognised argument. Only the
      // Bedrock wrapper may ever see this field.
      const created: any[] = [];
      (agentModeService as any).llmModels['gpt-5-chat-2'].client = {
        chat: { completions: { create: async (p: any) => { created.push(p); return { choices: [{ message: { content: 'ok' } }] }; } } },
      };

      await (agentModeService as any).callLLM('gpt-5-chat-2', CONVERSATION, { humanPaced: true });

      expect(created).toHaveLength(1);
      expect(created[0]).not.toHaveProperty('humanPaced');
    });

    it('warns once when Bedrock serves a shorter TTL than we asked for', async () => {
      // Sonnet 4.6 / Opus 4.6 are on the allowlist against AWS's published
      // "5 minutes only" table, on the strength of live probes. Billing is safe
      // either way, but if AWS ever enforces the docs we want to hear about it
      // rather than silently stop saving.
      AgentModeService.__resetCacheTtlDowngradeWarnsForTests();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'response' }] } },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 9000,
          cacheDetails: [{ ttl: '5m', inputTokens: 9000 }],
        },
        stopReason: 'end_turn',
      });

      await (agentModeService as any).callLLM('anthropic.claude-sonnet-4-6', CONVERSATION, { humanPaced: true });
      await (agentModeService as any).callLLM('anthropic.claude-sonnet-4-6', CONVERSATION, { humanPaced: true });

      const downgradeWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes('did NOT honour the requested prompt-cache TTL')
      );
      expect(downgradeWarns).toHaveLength(1);
      expect(String(downgradeWarns[0][0])).toContain("asked for '1h', got '5m'");
      warn.mockRestore();
    });

    it('stays quiet when Bedrock honours the requested TTL', async () => {
      AgentModeService.__resetCacheTtlDowngradeWarnsForTests();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'response' }] } },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 9000,
          cacheDetails: [{ ttl: '1h', inputTokens: 9000 }],
        },
        stopReason: 'end_turn',
      });

      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION, { humanPaced: true });

      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('did NOT honour'))
      ).toHaveLength(0);
      warn.mockRestore();
    });

    it('never mixes TTLs within one request (Bedrock requires longer TTLs first)', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      const unverified = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
      (agentModeService as any).llmModels[unverified] = { client: null, supportsTemperature: true };
      for (const model of ['anthropic.claude-opus-5', unverified]) {
        (ConverseCommand as jest.Mock).mockClear();
        await (agentModeService as any).callLLM(model, CONVERSATION, { humanPaced: true });
        const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
        const ttls = [...input.system, ...input.messages.flatMap((m: any) => m.content)]
          .filter((b: any) => b?.cachePoint)
          .map((b: any) => b.cachePoint.ttl);
        expect(ttls.length).toBeGreaterThan(1);
        expect(new Set(ttls).size).toBe(1);
      }
    });
  });

  describe('longestUserPauseMs — the pause that justifies the surcharge', () => {
    // REGRESSION GUARD. This was first implemented off `session.updatedAt` and
    // it silently disabled the whole feature: the controller saves the incoming
    // user message (bumping updatedAt) and reloads the session BEFORE the loop
    // runs, so the measured gap was always ~0 and the 1-hour TTL was never once
    // requested. Every unit test still passed — only a real browser session
    // caught it. Hence: measure from the message history.
    const at = (iso: string, role: string, extra: any = {}) => ({ role, content: 'x', timestamp: iso, ...extra });

    it('measures from the previous message, not from "now"', () => {
      const gap = AgentModeService.longestUserPauseMs([
        at('2026-08-05T10:00:00.000Z', 'user'),
        at('2026-08-05T10:00:30.000Z', 'assistant'),
        at('2026-08-05T10:12:00.000Z', 'user'), // user paused 11m30s
      ]);
      expect(gap).toBe(11.5 * 60 * 1000);
    });

    it('falls back to the nearest earlier timestamped message', () => {
      // Assistant turns often carry their time on metadata, or not at all.
      const gap = AgentModeService.longestUserPauseMs([
        at('2026-08-05T10:00:00.000Z', 'user'),
        { role: 'assistant', content: 'no timestamp' },
        { role: 'tool', content: 'r', metadata: { timestamp: '2026-08-05T10:01:00.000Z' } },
        at('2026-08-05T10:20:00.000Z', 'user'),
      ]);
      expect(gap).toBe(19 * 60 * 1000);
    });

    it('returns 0 for a first turn — no pause to reward', () => {
      expect(AgentModeService.longestUserPauseMs([at('2026-08-05T10:00:00.000Z', 'user')])).toBe(0);
      expect(AgentModeService.longestUserPauseMs([])).toBe(0);
      expect(AgentModeService.longestUserPauseMs(undefined)).toBe(0);
    });

    it('returns 0 rather than NaN when timestamps are missing or unparseable', () => {
      expect(
        AgentModeService.longestUserPauseMs([
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ])
      ).toBe(0);
      expect(
        AgentModeService.longestUserPauseMs([
          at('nonsense', 'user'),
          at('2026-08-05T10:00:00.000Z', 'user'),
        ])
      ).toBe(0);
    });

    it('is sticky: reports an EARLIER pause even when the latest turn was fast', () => {
      // Without this, a turn following a quick reply writes a 5-minute cache and
      // the user's next pause expires it — half the saving, measured.
      const gap = AgentModeService.longestUserPauseMs([
        at('2026-08-05T10:00:00.000Z', 'user'),
        at('2026-08-05T10:00:10.000Z', 'assistant'),
        at('2026-08-05T10:20:00.000Z', 'user'), // 19m50s pause
        at('2026-08-05T10:20:05.000Z', 'assistant'),
        at('2026-08-05T10:20:30.000Z', 'user'), // fast reply now
      ]);
      expect(gap).toBeGreaterThan(5 * 60 * 1000);
    });

    it('never returns a negative gap if clocks disagree', () => {
      const gap = AgentModeService.longestUserPauseMs([
        at('2026-08-05T10:10:00.000Z', 'user'),
        at('2026-08-05T10:00:00.000Z', 'user'),
      ]);
      expect(gap).toBe(0);
    });
  });

  describe('who actually pays for the 1-hour TTL', () => {
    // The surcharge is only worth paying when the prefix will be re-read AFTER
    // the 5-minute window would have lapsed. These are the four populations.
    const FIVE_MIN_MS = 5 * 60 * 1000;
    const pacedFrom = (updatedAt: string | undefined, isScheduled: boolean) => {
      const ms = updatedAt ? Date.now() - Date.parse(updatedAt) : 0;
      return !isScheduled && Number.isFinite(ms) && ms > FIVE_MIN_MS;
    };

    it('buys it for a user who just paused longer than the default TTL', () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      expect(pacedFrom(tenMinutesAgo, false)).toBe(true);
    });

    it('does NOT buy it for a fast back-and-forth chat', () => {
      // Replying in under five minutes means the prefix is re-read on a free
      // refresh; the extra 0.75x would buy nothing.
      const ninetySecondsAgo = new Date(Date.now() - 90 * 1000).toISOString();
      expect(pacedFrom(ninetySecondsAgo, false)).toBe(false);
    });

    it('does NOT buy it on a session with no prior message', () => {
      // A first (often only) turn writes the cache and may never re-read it.
      expect(pacedFrom(undefined, false)).toBe(false);
    });

    it('does NOT buy it for a scheduled run, however long it has been idle', () => {
      // A scheduled run may start hours after its last message, but its own
      // turns then fire back-to-back — it never spans the window mid-run.
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      expect(pacedFrom(twoHoursAgo, true)).toBe(false);
    });

    it('does NOT buy it when the timestamp is unparseable', () => {
      expect(pacedFrom('not-a-date', false)).toBe(false);
    });
  });

  describe('diffToolSets — does a skill refresh actually cost a re-cache?', () => {
    // `tools` is the first link in Bedrock's cache chain, so only a refresh that
    // MOVES the tool set invalidates the prefix. This is the measurement that
    // decides whether the remaining install cost is worth engineering away.
    const set = (...names: string[]) => new Set(names);

    it('reports a change when a skill adds tools (the expensive case)', () => {
      const diff = AgentModeService.diffToolSets(set('a', 'b'), set('a', 'b', 'c'));
      expect(diff).toEqual({ added: 1, removed: 0, changed: true });
    });

    it('reports NO change when the installed skill adds nothing new', () => {
      // Skills overlap heavily (191 distinct tools across 74 skills), so an
      // install whose tools are already allowed should keep the cache alive.
      const diff = AgentModeService.diffToolSets(set('a', 'b'), set('b', 'a'));
      expect(diff).toEqual({ added: 0, removed: 0, changed: false });
    });

    it('counts removals too — losing a tool invalidates just as hard', () => {
      const diff = AgentModeService.diffToolSets(set('a', 'b', 'c'), set('a'));
      expect(diff).toEqual({ added: 0, removed: 2, changed: true });
    });

    it('handles simultaneous add and remove', () => {
      const diff = AgentModeService.diffToolSets(set('a', 'b'), set('b', 'z'));
      expect(diff).toEqual({ added: 1, removed: 1, changed: true });
    });

    it('treats an empty starting set as a change once tools appear', () => {
      expect(AgentModeService.diffToolSets(set(), set('a')).changed).toBe(true);
      expect(AgentModeService.diffToolSets(set(), set()).changed).toBe(false);
    });
  });

  describe('the price book stays on the DEFAULT-TTL rate', () => {
    it('declares 1.25x for every Bedrock Anthropic model, extended-TTL or not', () => {
      // The 1-hour uplift is applied per RESPONSE (cacheWriteCost), never per
      // model. A model id can be used by one path that requests 1h and another
      // that does not — Sonnet 4.6 is exactly that, shared between agent-mode
      // and codingAgentService — so a per-model 2x rate would over-bill the
      // 5-minute callers by 60%.
      for (const [model, price] of Object.entries(MODEL_PRICING)) {
        if (!model.startsWith('anthropic.')) continue;
        expect(price.cacheWritePerM).toBeCloseTo(price.inPerM * 1.25, 10);
      }
    });

    it('still asks for the 1h TTL on every allowlisted model, and prices it', () => {
      expect(BEDROCK_EXTENDED_CACHE_TTL_MODELS.size).toBeGreaterThan(0);
      for (const model of BEDROCK_EXTENDED_CACHE_TTL_MODELS) {
        expect(bedrockCacheTtl(model)).toBe('1h');
        // …and it must still be a priced model, or the ledger books $0.
        expect(getModelPrice(model)).not.toBeNull();
      }
    });
  });

  describe('cacheWriteCost bills the TTL that was APPLIED, not the one requested', () => {
    // The reason this exists: Bedrock accepts `ttl: '1h'` on models AWS
    // documents as 5-minute-only, so "we asked for 1h" is not evidence we got
    // it. Billing off `usage.cacheDetails` makes a wrong allowlist entry cost
    // missed savings instead of a 60% over-charge.
    const opus5 = getModelPrice('anthropic.claude-opus-5')!;

    it('charges 2x for tokens Bedrock reported at the 1-hour TTL', () => {
      expect(cacheWriteCost(opus5, 1_000_000, { '1h': 1_000_000 })).toBeCloseTo(10_000_000, 6);
    });

    it('charges only 1.25x when Bedrock served a 5-minute cache instead', () => {
      // Same model, same tokens, same request — but a 5m write came back.
      expect(cacheWriteCost(opus5, 1_000_000, { '5m': 1_000_000 })).toBeCloseTo(6_250_000, 6);
    });

    it('bills a mixed-TTL response per bucket', () => {
      const cost = cacheWriteCost(opus5, 300_000, { '1h': 200_000, '5m': 100_000 });
      expect(cost).toBeCloseTo(200_000 * 10 + 100_000 * 6.25, 6);
    });

    it('falls back to the declared rate when no breakdown is present', () => {
      expect(cacheWriteCost(opus5, 1_000_000, undefined)).toBeCloseTo(
        1_000_000 * opus5.cacheWritePerM!,
        6
      );
    });

    it('bills tokens the breakdown does not account for at the declared rate', () => {
      // Never silently drop billable tokens because a bucket went missing.
      const cost = cacheWriteCost(opus5, 500_000, { '1h': 200_000 });
      expect(cost).toBeCloseTo(200_000 * 10 + 300_000 * opus5.cacheWritePerM!, 6);
    });

    it('bills an unknown future TTL tier at the declared rate, never at zero', () => {
      const cost = cacheWriteCost(opus5, 100_000, { '24h': 100_000 });
      expect(cost).toBeCloseTo(100_000 * opus5.cacheWritePerM!, 6);
      expect(cost).toBeGreaterThan(0);
    });

    it('ignores non-positive and non-finite bucket values', () => {
      const cost = cacheWriteCost(opus5, 0, { '1h': 0, '5m': Number.NaN });
      expect(cost).toBe(0);
    });

    it('bills the SAME model differently per path, which is the whole point', () => {
      // Sonnet 4.6 is requested with ttl:'1h' by agent-mode and with no ttl by
      // codingAgentService / rcaEnricher. One model id, two correct answers —
      // only reachable by pricing from the response.
      const sonnet46 = getModelPrice('anthropic.claude-sonnet-4-6')!;
      expect(cacheWriteCost(sonnet46, 100_000, { '1h': 100_000 })).toBeCloseTo(100_000 * 6, 6);
      expect(cacheWriteCost(sonnet46, 100_000, { '5m': 100_000 })).toBeCloseTo(100_000 * 3.75, 6);
    });
  });
});
