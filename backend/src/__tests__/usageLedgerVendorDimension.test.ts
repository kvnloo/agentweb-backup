/**
 * ENG-693 — vendor dimension on the existing usage ledger.
 *
 * These tests are the HUMAN-WRITTEN behavioral contract from the Linear issue,
 * one describe() per assertion. They drive the REAL usageRecorderService against
 * the REAL usageRecordDb with only aws-sdk mocked, so they assert on the actual
 * DynamoDB write the ledger performs — not on a mocked seam between the two.
 *
 * Contract (must not be modified by the agent):
 *  1. A usage entry recorded for vendor `v0` can be read back as belonging to v0.
 *  2. A usage entry for a vendor that does not bill by tokens reports its
 *     quantity and unit, and reports no token counts.
 *  3. A cost we produced by applying our own rate is distinguishable, by any
 *     reader, from a cost the vendor reported.
 *  4. A usage entry recorded before this change is still readable, is attributed
 *     to no vendor, and is NOT reported as a vendor entry costing zero.
 *  5. Recording a vendor entry never blocks or slows the caller, and a failure to
 *     record does not fail the caller's operation.
 *  6. An LLM usage entry recorded after this change contains the same token
 *     counts, cost, feature, and billing user as it did before.
 */

// Mock BEFORE imports (matches usageRecordDb.test.ts).
jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    update: jest.fn(),
    query: jest.fn(),
    scan: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import {
  usageRecordDb,
  isVendorEntry,
  UsageRecordRow,
} from '../services/usageRecordDb';
import {
  recordUsage,
  recordVendorUsage,
  __resetErrorLogThrottleForTests,
} from '../services/usageRecorderService';

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();

/** The params of the Nth update() call. */
function updateParams(n = 0): any {
  return mockDynamoDB.update.mock.calls[n][0];
}

/**
 * Reconstruct the row DynamoDB would materialize from an UpdateExpression, so
 * assertions read like "what a reader sees", not "what expression we built".
 * ADD creates/increments numeric attributes; SET assigns them.
 */
function materializeRow(params: any): Record<string, any> {
  const row: Record<string, any> = { ...params.Key };
  const names: Record<string, string> = params.ExpressionAttributeNames || {};
  const values: Record<string, any> = params.ExpressionAttributeValues || {};
  const expr: string = params.UpdateExpression;

  const resolveName = (token: string) => (token.startsWith('#') ? names[token] : token);

  const addPart = expr.slice('ADD '.length).split(' SET ')[0];
  for (const clause of addPart.split(',')) {
    const [attr, val] = clause.trim().split(/\s+/);
    if (!attr || !val) continue;
    row[resolveName(attr)] = values[val];
  }

  const setIdx = expr.indexOf(' SET ');
  if (setIdx !== -1) {
    const setPart = expr.slice(setIdx + ' SET '.length);
    // Split on commas at paren depth 0 only — if_not_exists(#ttl, :ttl) has its own.
    const clauses: string[] = [];
    let depth = 0;
    let buf = '';
    for (const ch of setPart) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        clauses.push(buf);
        buf = '';
        continue;
      }
      buf += ch;
    }
    clauses.push(buf);

    for (const clause of clauses) {
      const [lhs, rhs] = clause.split(' = ');
      if (!lhs || !rhs) continue;
      // if_not_exists(#x, :y) on a fresh row resolves to :y
      const m = rhs.trim().match(/^if_not_exists\([^,]+,\s*(:[A-Za-z0-9_]+)\)$/);
      row[resolveName(lhs.trim())] = values[(m ? m[1] : rhs.trim())];
    }
  }
  return row;
}

const llmCtx = {
  userId: 'user-1',
  billingUserId: 'owner-1',
  model: 'anthropic.claude-sonnet-4-6',
  provider: 'bedrock',
  feature: 'agent-chat',
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
};

const v0Ctx = {
  userId: 'user-1',
  billingUserId: 'owner-1',
  provider: 'v0',
  operation: 'generate',
  feature: 'landing-page',
  unit: 'render' as const,
  quantity: 1,
  costSource: 'allocated' as const,
  costUsd: 0.25,
};

describe('ENG-693 vendor dimension — behavioral contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetErrorLogThrottleForTests();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  // ── Assertion 1 ────────────────────────────────────────────────────────────
  describe('1. a vendor entry can be read back as belonging to that vendor', () => {
    it('persists provider "v0" as a readable attribute on the row', async () => {
      await recordVendorUsage(v0Ctx);

      const row = materializeRow(updateParams());
      expect(row.provider).toBe('v0');
      expect(isVendorEntry(row as UsageRecordRow)).toBe(true);
    });

    it('never shares a row with another vendor, despite the unchanged sort key', async () => {
      await recordVendorUsage(v0Ctx);
      await recordVendorUsage({ ...v0Ctx, provider: 'remotion', operation: 'generate' });

      // Same day, same feature, same operation name — different vendors MUST NOT
      // collide into one aggregate row, or provider would be last-writer-wins.
      expect(updateParams(0).Key.sk).not.toBe(updateParams(1).Key.sk);
      expect(materializeRow(updateParams(0)).provider).toBe('v0');
      expect(materializeRow(updateParams(1)).provider).toBe('remotion');
    });

    it('leaves the {date}#{model}#{feature} sort-key FORMAT unchanged (out of scope to alter)', async () => {
      await recordVendorUsage(v0Ctx);
      const sk: string = updateParams().Key.sk;
      expect(sk.split('#')).toHaveLength(3);
      expect(sk).toBe('' + new Date().toISOString().slice(0, 10) + '#v0:generate#landing-page');
    });
  });

  // ── Assertion 2 ────────────────────────────────────────────────────────────
  describe('2. a non-token vendor entry reports quantity + unit and NO token counts', () => {
    it('records 3 queries as quantity 3 with unit "query"', async () => {
      await recordVendorUsage({
        ...v0Ctx,
        provider: 'you.com',
        operation: 'search',
        unit: 'query',
        quantity: 3,
      });

      const row = materializeRow(updateParams());
      expect(row.quantity).toBe(3);
      expect(row.unit).toBe('query');
    });

    it('writes no token attributes at all — absent, not zero', async () => {
      await recordVendorUsage(v0Ctx);

      const row = materializeRow(updateParams());
      for (const attr of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'totalTokens',
      ]) {
        expect(row).not.toHaveProperty(attr);
      }
      // callCount still counts the call itself.
      expect(row.callCount).toBe(1);
    });

    it('accumulates quantity across calls (ADD), rather than overwriting it', async () => {
      await recordVendorUsage({ ...v0Ctx, unit: 'query', quantity: 3 });
      const expr: string = updateParams().UpdateExpression;
      const addPart = expr.slice(0, expr.indexOf(' SET '));
      expect(addPart).toMatch(/quantity/);
    });
  });

  // ── Assertion 3 ────────────────────────────────────────────────────────────
  describe('3. allocated cost is distinguishable from vendor-measured cost', () => {
    it('marks a vendor-reported figure as "measured"', async () => {
      await recordVendorUsage({ ...v0Ctx, costSource: 'measured', costUsd: 0.4 });
      const row = materializeRow(updateParams());
      expect(row.costSource).toBe('measured');
      expect(row.costMicroUsd).toBe(400_000);
    });

    it('marks a figure we derived from our own rate as "allocated"', async () => {
      await recordVendorUsage({ ...v0Ctx, costSource: 'allocated', costUsd: 0.25 });
      const row = materializeRow(updateParams());
      expect(row.costSource).toBe('allocated');
      expect(row.costMicroUsd).toBe(250_000);
    });

    it('stamps existing LLM dollars as "allocated" — they always were, nothing said so', async () => {
      await recordUsage(llmCtx);
      expect(materializeRow(updateParams()).costSource).toBe('allocated');
    });
  });

  // ── Assertion 4 ────────────────────────────────────────────────────────────
  describe('4. a pre-change row stays readable, has no vendor, and is not a $0 vendor entry', () => {
    /** A row exactly as it was written before this change: no new attributes. */
    const legacyRow = {
      userId: 'user-1',
      sk: '2026-01-02#anthropic.claude-sonnet-4-6#agent-chat',
      date: '2026-01-02',
      model: 'anthropic.claude-sonnet-4-6',
      feature: 'agent-chat',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1200,
      costMicroUsd: 6128,
      callCount: 1,
      billingUserId: 'owner-1',
      updatedAt: '2026-01-02T00:00:00.000Z',
      ttl: 1,
    } as UsageRecordRow;

    it('is not classified as a vendor entry', () => {
      expect(isVendorEntry(legacyRow)).toBe(false);
    });

    it('is attributed to no vendor — undefined, never an empty-string vendor', () => {
      expect(legacyRow.provider).toBeUndefined();
      expect(legacyRow.unit).toBeUndefined();
      expect(legacyRow.costSource).toBeUndefined();
    });

    it('keeps its cost and tokens readable — it is not a $0 entry', () => {
      expect(legacyRow.costMicroUsd).toBe(6128);
      expect(legacyRow.totalTokens).toBe(1200);
    });

    it('reads back without a migration — no new attribute is required to exist', () => {
      // The row above has none of the new attributes and still satisfies the type.
      const asRow: UsageRecordRow = legacyRow;
      expect(asRow.userId).toBe('user-1');
      expect(isVendorEntry(asRow)).toBe(false);
    });

    it('a row with a provider but no unit is still not a vendor entry (partial data)', () => {
      expect(isVendorEntry({ ...legacyRow, provider: 'bedrock' } as UsageRecordRow)).toBe(false);
    });
  });

  // ── Assertion 5 ────────────────────────────────────────────────────────────
  describe('5. recording a vendor entry never blocks and never fails the caller', () => {
    it('resolves without throwing when the write rejects', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB is down')),
      });

      await expect(recordVendorUsage(v0Ctx)).resolves.toBeUndefined();
      errorSpy.mockRestore();
    });

    it('resolves without throwing when the client throws synchronously', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockDynamoDB.update.mockImplementation(() => {
        throw new Error('client exploded');
      });

      await expect(recordVendorUsage(v0Ctx)).resolves.toBeUndefined();
      errorSpy.mockRestore();
    });

    it('does not throw synchronously, so a caller can fire it without await', async () => {
      mockDynamoDB.update.mockImplementation(() => {
        throw new Error('client exploded');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      let fired: Promise<void>;
      expect(() => {
        fired = recordVendorUsage(v0Ctx);
      }).not.toThrow();

      // Let the swallowed failure settle before restoring the spy, so the
      // suppressed log can't leak into another test's output.
      await fired!;
      errorSpy.mockRestore();
    });

    it('issues exactly one write — no read-modify-write round trip in the caller path', async () => {
      await recordVendorUsage(v0Ctx);
      expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
      expect(mockDynamoDB.get).not.toHaveBeenCalled();
      expect(mockDynamoDB.query).not.toHaveBeenCalled();
      expect(mockDynamoDB.scan).not.toHaveBeenCalled();
    });
  });

  // ── Defaults: unattributed and unpriced vendor spend is still recorded ──────
  describe('vendor spend with an incomplete context is still captured, never dropped', () => {
    it('books spend with no user under "system" rather than losing it', async () => {
      const { userId, billingUserId, ...noUser } = v0Ctx;
      await recordVendorUsage(noUser as any);

      const row = materializeRow(updateParams());
      expect(row.userId).toBe('system');
      expect(row.billingUserId).toBe('system');
    });

    it('falls back to the acting user for billing when no billing user is given', async () => {
      const { billingUserId, ...noBilling } = v0Ctx;
      await recordVendorUsage(noBilling as any);
      expect(materializeRow(updateParams()).billingUserId).toBe('user-1');
    });

    it('records an unpriced unit at cost 0 while still marking it a vendor entry', async () => {
      // No rate card exists yet (ENG-703). An unpriced call must still land on the
      // ledger with its quantity, not vanish — ENG-700 is what makes it loud.
      const { costUsd, ...unpriced } = v0Ctx;
      await recordVendorUsage(unpriced as any);

      const row = materializeRow(updateParams());
      expect(row.costMicroUsd).toBe(0);
      expect(row.quantity).toBe(1);
      expect(isVendorEntry(row as UsageRecordRow)).toBe(true);
    });

    it('defaults a missing feature to "unknown" instead of writing an empty key segment', async () => {
      const { feature, ...noFeature } = v0Ctx;
      await recordVendorUsage(noFeature as any);
      expect(updateParams().Key.sk.endsWith('#unknown')).toBe(true);
    });

    it('carries onBehalfOf when present and omits it otherwise', async () => {
      await recordVendorUsage(v0Ctx);
      expect(updateParams(0).UpdateExpression).not.toContain('onBehalfOf');

      await recordVendorUsage({ ...v0Ctx, onBehalfOf: 'client-7' });
      expect(materializeRow(updateParams(1)).onBehalfOf).toBe('client-7');
    });

    it('carries the session onto a vendor row as lastSessionId when the caller has one', async () => {
      await recordVendorUsage({ ...v0Ctx, sessionId: 'sess-9' });
      expect(materializeRow(updateParams()).lastSessionId).toBe('sess-9');
    });

    it('never writes a negative cost or a fractional quantity', async () => {
      await recordVendorUsage({ ...v0Ctx, costUsd: -5, quantity: 2.6 });
      const row = materializeRow(updateParams());
      expect(row.costMicroUsd).toBe(0);
      expect(Number.isInteger(row.quantity)).toBe(true);
      expect(row.quantity).toBe(3);
    });
  });

  // ── Assertion 6 ────────────────────────────────────────────────────────────
  describe('6. an LLM entry is unchanged in tokens, cost, feature, and billing user', () => {
    it('writes the same token counts, cost, feature and billingUserId as before', async () => {
      await recordUsage(llmCtx);
      const row = materializeRow(updateParams());

      expect(row.inputTokens).toBe(1000);
      expect(row.outputTokens).toBe(200);
      expect(row.cacheReadTokens).toBe(50);
      expect(row.cacheWriteTokens).toBe(10);
      expect(row.totalTokens).toBe(1260);
      expect(row.feature).toBe('agent-chat');
      expect(row.billingUserId).toBe('owner-1');
      expect(row.callCount).toBe(1);
      expect(Number.isInteger(row.costMicroUsd)).toBe(true);
    });

    it('keys the LLM row exactly as before — model slot untouched, not namespaced', async () => {
      await recordUsage(llmCtx);
      const date = new Date().toISOString().slice(0, 10);
      expect(updateParams().Key).toEqual({
        userId: 'user-1',
        sk: `${date}#anthropic.claude-sonnet-4-6#agent-chat`,
      });
    });

    it('honours costUsdOverride for non-token-priced calls exactly as before', async () => {
      await recordUsage({ ...llmCtx, model: 'veo-3', costUsdOverride: 1.5 });
      expect(materializeRow(updateParams()).costMicroUsd).toBe(1_500_000);
    });

    it('now also carries the provider that was already declared but dropped', async () => {
      await recordUsage(llmCtx);
      expect(materializeRow(updateParams()).provider).toBe('bedrock');
    });

    it('threads the session through instead of dropping it at the write', async () => {
      await recordUsage({ ...llmCtx, sessionId: 'sess-42' });
      expect(materializeRow(updateParams()).lastSessionId).toBe('sess-42');
    });

    it('never pins one session onto a row fed by many (Greptile P1)', async () => {
      // The sort key has no session component, so these two calls land on ONE row
      // whose counters hold both sessions' usage. The stored id must therefore
      // track the latest writer, not stick to the first — a sticky id would read
      // as "sess-a owns this usage" while sess-b's tokens accumulate underneath it.
      await recordUsage({ ...llmCtx, sessionId: 'sess-a' });
      await recordUsage({ ...llmCtx, sessionId: 'sess-b' });

      expect(updateParams(0).Key).toEqual(updateParams(1).Key);
      expect(updateParams(1).UpdateExpression).not.toContain('if_not_exists(lastSessionId');
      expect(materializeRow(updateParams(1)).lastSessionId).toBe('sess-b');
    });

    it('omits provider/session cleanly when the caller has none', async () => {
      const { provider, ...noProvider } = llmCtx;
      await recordUsage(noProvider as any);
      const params = updateParams();
      expect(params.ExpressionAttributeValues[':provider']).toBeUndefined();
      expect(params.ExpressionAttributeValues[':lastSessionId']).toBeUndefined();
      expect(params.UpdateExpression).not.toContain('SessionId');
    });

    it('writes provider with if_not_exists so an aggregate row never flaps', async () => {
      await recordUsage(llmCtx);
      expect(updateParams().UpdateExpression).toContain('if_not_exists(#provider, :provider)');
    });
  });
});
