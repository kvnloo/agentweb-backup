/**
 * ENG-694 — v0 landing-page generation records vendor usage.
 *
 * The highest per-unit product action in the system recorded nothing: greps for
 * `recordUsage|recordVendorUsage|meterUserUsage|usageRecordDb` across
 * `v0Service.ts`, `v0UsageGuard.ts`, `v0BillingService.ts` and
 * `routes/landingPageGeneration.ts` returned zero matches.
 *
 * The two decisions these tests pin, because both are easy to get quietly wrong:
 *
 *  - Metering wraps the INNERMOST call, not the guard. Every site is
 *    `guardedV0X({ send: () => withRetry(() => v0.chats.Y(...)) })`. The contract
 *    counts what the VENDOR was asked to do, and retries happen inside
 *    `withRetry` — so the guard can only ever see one logical request.
 *  - A failed call is recorded only when v0 ANSWERED. An error carrying an HTTP
 *    status means the request landed and may be billed (the 300s-timeout case
 *    ENG-287 was about); a transport error with no status means it never got
 *    there. Recording everything invents spend; recording only successes misses
 *    the case that motivated this row.
 */

const mockRecordVendorUsage = jest.fn();
const mockGetAllocatedRate = jest.fn();
jest.mock('../utils/vendorRateCard', () => {
  const actual = jest.requireActual('../utils/vendorRateCard');
  return { ...actual, getAllocatedRate: (...a: any[]) => mockGetAllocatedRate(...a) };
});
jest.mock('../services/usageRecorderService', () => ({
  ...jest.requireActual('../services/usageRecorderService'),
  recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
}));

import { meteredV0, recordV0Call, reachedVendor } from '../services/v0Metering';
import { getAllocatedRate } from '../utils/vendorRateCard';

// mockReset, not mockClear: one case installs a throwing implementation and
// clearAllMocks leaves it in place for every case after it.
beforeEach(() => {
  mockRecordVendorUsage.mockReset();
  // Default to the real card so every other case exercises the approved rate.
  mockGetAllocatedRate.mockReset();
  mockGetAllocatedRate.mockImplementation(
    jest.requireActual('../utils/vendorRateCard').getAllocatedRate
  );
});

describe('reachedVendor — did v0 actually answer?', () => {
  it('true when the error carries an HTTP status, in any of its shapes', () => {
    expect(reachedVendor({ status: 500 })).toBe(true);
    expect(reachedVendor({ statusCode: 429 })).toBe(true);
    expect(reachedVendor({ response: { status: 502 } })).toBe(true);
    expect(reachedVendor({ response: { statusCode: 400 } })).toBe(true);
  });
  it('false for a transport failure that never reached v0', () => {
    expect(reachedVendor(new Error('ECONNRESET'))).toBe(false);
    expect(reachedVendor({ code: 'ETIMEDOUT' })).toBe(false);
    expect(reachedVendor(null)).toBe(false);
    expect(reachedVendor(undefined)).toBe(false);
    expect(reachedVendor('boom')).toBe(false);
    expect(reachedVendor({ status: 0 })).toBe(false);
  });
});

describe('meteredV0 — one record per attempt that reached v0', () => {
  it('records once on success and returns the response untouched', async () => {
    const res = await meteredV0({ userId: 'u1', operation: 'chat_create' },
      async () => ({ id: 'chat_123' }))();
    expect(res).toEqual({ id: 'chat_123' });
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('records a failure that v0 answered, and still rethrows', async () => {
    const boom = Object.assign(new Error('v0 500'), { status: 500 });
    await expect(meteredV0({ userId: 'u1', operation: 'chat_create' },
      async () => { throw boom; })()).rejects.toBe(boom);
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('does NOT record a transport error that never reached v0', async () => {
    const boom = new Error('ECONNREFUSED');
    await expect(meteredV0({ userId: 'u1', operation: 'chat_create' },
      async () => { throw boom; })()).rejects.toBe(boom);
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('AC2 — two rounds v0 accepted produce two entries, not one', async () => {
    const thunk = meteredV0({ userId: 'u1', operation: 'correction_message' },
      async () => ({ ok: true }));
    await thunk();
    await thunk();
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(2);
  });

  it('never lets a metering failure break generation', async () => {
    mockRecordVendorUsage.mockImplementation(() => { throw new Error('ledger down'); });
    await expect(meteredV0({ userId: 'u1', operation: 'chat_create' },
      async () => ({ id: 'x' }))()).resolves.toEqual({ id: 'x' });
  });
});

describe('the recorded entry', () => {
  it('AC6 — allocated, carrying the APPROVED rate rather than nothing', () => {
    // This assertion was inverted in the first version of this file: it asserted
    // costUsd was undefined, which pinned the bug in place. `allocated` means
    // "0 or more real dollars from a KNOWN rate" (ENG-700); recording it with no
    // figure books every generation as confirmed-free spend. The rate exists and
    // is approved — vendorRateCard.ts, v0.landing_page_generation, ENG-703.
    recordV0Call({ userId: 'u1', operation: 'chat_create' });
    const row = mockRecordVendorUsage.mock.calls[0][0];
    expect(row.provider).toBe('v0');
    expect(row.costSource).toBe('allocated');
    expect(row.costUsd).toBe(getAllocatedRate('v0', 'landing_page_generation'));
    expect(row.costUsd).toBeGreaterThan(0);
    expect(row.unit).toBe('generation');
    expect(row.quantity).toBe(1);
  });

  it('reads the rate from the card instead of embedding a literal', () => {
    // The card is explicit: "No adapter may embed its own independent dollar
    // literal for a vendor/unit covered here." A hardcoded 2.0 would pass the
    // assertion above today and silently diverge the next time the rate moves.
    const src = require('fs').readFileSync('src/services/v0Metering.ts', 'utf8');
    expect(src).toContain('getAllocatedRate("v0"');
    expect(src).not.toMatch(/costUsd:\s*[0-9]/);
  });

  it('degrades to unpriced — not a silent $0 — if the card loses the entry', () => {
    mockGetAllocatedRate.mockReturnValueOnce(null);
    recordV0Call({ userId: 'u1', operation: 'chat_create' });
    const row = mockRecordVendorUsage.mock.calls[0][0];
    expect(row.costSource).toBe('unpriced');
    expect(row.costUsd).toBeUndefined();
  });

  it('AC1 — attributed to the user who triggered it', () => {
    recordV0Call({ userId: 'actor-1', operation: 'chat_create' });
    expect(mockRecordVendorUsage.mock.calls[0][0].userId).toBe('actor-1');
  });

  it('AC5 — names both the member who acted and the owner who is accountable', () => {
    recordV0Call({ userId: 'member-9', billingUserId: 'owner-1', onBehalfOf: 'member-9', operation: 'iterate_message' });
    const row = mockRecordVendorUsage.mock.calls[0][0];
    expect(row.userId).toBe('member-9');
    expect(row.billingUserId).toBe('owner-1');
    expect(row.onBehalfOf).toBe('member-9');
  });

  it('omits onBehalfOf entirely when actor and owner are the same', () => {
    recordV0Call({ userId: 'u1', billingUserId: 'u1', operation: 'iterate_message' });
    expect(mockRecordVendorUsage.mock.calls[0][0]).not.toHaveProperty('onBehalfOf');
  });

  it('distinguishes the three billable operations', () => {
    for (const op of ['chat_create', 'correction_message', 'iterate_message'] as const) {
      mockRecordVendorUsage.mockClear();
      recordV0Call({ userId: 'u1', operation: op });
      expect(mockRecordVendorUsage.mock.calls[0][0].operation).toBe(op);
    }
  });
});

describe('AC4 — cleanup cannot destroy usage history', () => {
  it('writes to the ledger, never to the guard table the cleanup deletes from', () => {
    // `clearV0UsageForPage` hard-deletes from AW-V0Usage. The meter goes through
    // recordVendorUsage into AW-UsageRecords, so a page delete or a failed-generation
    // cleanup leaves the spend record standing.
    const guard = require('fs').readFileSync('src/services/v0UsageGuard.ts', 'utf8');
    const ledger = require('fs').readFileSync('src/services/usageRecordDb.ts', 'utf8');
    expect(guard).toContain('AW-V0Usage');
    expect(ledger).toContain('AW-UsageRecords');
    expect(guard).not.toContain('AW-UsageRecords');
  });
});

describe('coverage is derived, not a hardcoded list (ENG-701)', () => {
  it('every v0.chats call site in v0Service is wrapped', () => {
    const src = require('fs').readFileSync('src/services/v0Service.ts', 'utf8');
    const calls = src.match(/\(\)\s*=>\s*v0\.chats\.(create|sendMessage)\(/g) || [];
    // Non-greedy across newlines, not [^}]*: the iterate site's context object
    // contains a nested `}` (a conditional spread for onBehalfOf), which made the
    // simpler pattern stop early and under-count by exactly that one site.
    const wrapped = src.match(/meteredV0\(\{[\s\S]*?\},\s*\(\)\s*=>\s*v0\.chats\./g) || [];
    // The row's inventory said 9, then main had 11; a later consolidation (unrelated to
    // this change) brought it down to 7 real call sites, all still metered. Asserting
    // equality rather than a count means a new call site fails this test instead of
    // silently going unmetered.
    expect(calls.length).toBeGreaterThanOrEqual(7);
    expect(wrapped.length).toBe(calls.length);
  });
});

describe('AC5 — delegated iteration is genuinely reachable (CodeRabbit, #2721)', () => {
  /**
   * The first implementation derived the actor from the loaded record. It could
   * never differ from the owner: `getLandingPage(id, userId)` returns null unless
   * `item.userId === userId`, so the onBehalfOf branch was unreachable and AC5
   * was a no-op that read as satisfied.
   *
   * The actor has to arrive from the route, which is the only place that still
   * knows it — `authorizeLandingPageAccess(id, actor, "edit")` proves permission,
   * and then the call passed `auth.page.userId` (the OWNER), discarding the actor.
   */
  const fs = require('fs');

  it('the route hands the acting member through as its own argument', () => {
    const route = fs.readFileSync('src/routes/landingPageGeneration.ts', 'utf8');
    expect(route).toMatch(
      /iterateLandingPage\(\s*auth\.page\.id,\s*auth\.page\.userId,\s*message,\s*userId\s*\)/
    );
  });

  it('the service takes it as a parameter, not from the record', () => {
    const svc = fs.readFileSync('src/services/v0Service.ts', 'utf8');
    expect(svc).toMatch(/actingUserId\?:\s*string/);
    // The owner still comes from the record; only the ACTOR is injected.
    expect(svc).toContain('const iterateActorUserId = actingUserId || iterateOwnerUserId;');
    // The ownership check that made the old derivation impossible must remain —
    // CodeRabbit was explicit that it must not be removed to make this reachable.
    expect(svc).toContain('if (!item || item.userId !== userId) {');
  });

  it('a delegated edit names both parties; a self-service edit names one', () => {
    mockRecordVendorUsage.mockReset();
    recordV0Call({ userId: 'member-9', billingUserId: 'owner-1', onBehalfOf: 'member-9', operation: 'iterate_message' });
    expect(mockRecordVendorUsage.mock.calls[0][0]).toMatchObject({
      userId: 'member-9', billingUserId: 'owner-1', onBehalfOf: 'member-9',
    });
    mockRecordVendorUsage.mockReset();
    recordV0Call({ userId: 'owner-1', billingUserId: 'owner-1', operation: 'iterate_message' });
    expect(mockRecordVendorUsage.mock.calls[0][0]).not.toHaveProperty('onBehalfOf');
  });
});
