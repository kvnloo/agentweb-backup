// ENG-1131: a scheduled prospecting run whose ONLY sourcing path is LinkedIn
// people-search sources zero prospects when that endpoint is down for the account
// (the open Unipile Classic Search incident detected by ENG-975). The run still
// produces a report, so it is recorded as `status: 'success'` and the owner sees a
// healthy green card — indistinguishable from "nobody matched your filters".
//
// The tool ledger is the only place that knows the difference: the ENG-975 guard
// stamps `searchUnavailable: true` on the tool result. These tests pin the two
// steps that carry it to the owner: detecting it off the run's tool calls, and
// exposing it on the schedule's run-health summary the list card renders.

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { createChatSession: jest.fn(), getMessagesFromMessagesTable: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { getMarketingSystemPrompt: jest.fn() },
}));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));
jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateScheduleAfterRun: jest.fn() },
}));

import {
  computeScheduleRunHealth,
  detectRunBlockedReason,
  didSourcingBlockStateChange,
  LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON,
} from '../controllers/agentModeController';

describe('detectRunBlockedReason (ENG-1131)', () => {
  it.each([[undefined], [null], ['not-an-array' as any], [[]]])(
    'is null-safe and returns null for %p',
    (input) => {
      expect(detectRunBlockedReason(input as any)).toBeNull();
    },
  );

  it('returns null for an ordinary run whose searches genuinely matched nobody', () => {
    // A real empty result: the ENG-975 control probe answered `ok`, so no marker is
    // stamped. This MUST stay unflagged or every honest zero becomes a false outage.
    const toolCalls = [
      { name: 'linkedin_outreach', result: {} },
      { name: 'find_leads', result: { imported: 0, total: 0 } },
    ];
    expect(detectRunBlockedReason(toolCalls)).toBeNull();
  });

  it('flags the run when a linkedin_outreach search carried the outage marker', () => {
    // `linkedin_outreach` search-people returns success:false, so the dispatcher
    // downgrades the entry to an error — but it still keeps the minimal result.
    const toolCalls = [
      { name: 'list_connected_accounts', result: {} },
      { name: 'linkedin_outreach', error: 'LinkedIn people search is unavailable', result: { searchUnavailable: true } },
    ];
    expect(detectRunBlockedReason(toolCalls)).toBe(LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON);
  });

  it('flags the run when the find_leads top-up loop carried the outage marker', () => {
    const toolCalls = [{ name: 'find_leads', result: { imported: 0, searchUnavailable: true } }];
    expect(detectRunBlockedReason(toolCalls)).toBe(LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON);
  });

  it('tolerates malformed ledger entries without throwing', () => {
    const toolCalls = [null, undefined, 'nonsense', { name: 'x' }, { name: 'y', result: null }] as any[];
    expect(detectRunBlockedReason(toolCalls)).toBeNull();
  });
});

describe('computeScheduleRunHealth blocked-reason passthrough (ENG-1131)', () => {
  const run = (status: string, createdAt: string, extra: Record<string, any> = {}) => ({
    status,
    createdAt,
    passed: status === 'success',
    ...extra,
  });

  it('reports no block reason when the last run was unblocked', () => {
    const results = [run('success', '2026-08-09T16:30:00.000Z')];
    expect(computeScheduleRunHealth(results).lastRunBlockedBy).toBeNull();
  });

  it('surfaces the block reason of the most recent run even though it "succeeded"', () => {
    // The reported shape: a run that produced a report but sourced 0 prospects
    // because search was down. `status` stays 'success' (the run delivered), so the
    // block reason is the ONLY thing that tells the owner sourcing is down.
    const results = [
      run('success', '2026-08-09T16:30:00.000Z'),
      run('success', '2026-08-11T16:30:22.263Z', { blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON }),
    ];
    expect(computeScheduleRunHealth(results)).toEqual({
      lastRunStatus: 'success',
      lastRunAt: '2026-08-11T16:30:22.263Z',
      consecutiveFailures: 0,
      lastRunBlockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON,
    });
  });

  it('clears the block reason once a later run sourced normally again', () => {
    const results = [
      run('success', '2026-08-11T16:30:22.263Z', { blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON }),
      run('success', '2026-08-13T16:30:00.000Z'),
    ];
    expect(computeScheduleRunHealth(results).lastRunBlockedBy).toBeNull();
  });

  it('stays null-safe with no runs', () => {
    expect(computeScheduleRunHealth([]).lastRunBlockedBy).toBeNull();
  });
});

describe('didSourcingBlockStateChange (ENG-1131 follow-up: proactive transition alert)', () => {
  it('is a transition when a schedule with no prior runs comes back blocked', () => {
    expect(didSourcingBlockStateChange([], LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON)).toBe(true);
  });

  it('is NOT a transition when a schedule with no prior runs comes back healthy', () => {
    expect(didSourcingBlockStateChange([], null)).toBe(false);
    expect(didSourcingBlockStateChange(undefined, null)).toBe(false);
    expect(didSourcingBlockStateChange(null, null)).toBe(false);
  });

  it('is a transition when the previous run was healthy and this one is blocked', () => {
    const prior = [{ status: 'success', blockedBy: undefined }];
    expect(didSourcingBlockStateChange(prior, LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON)).toBe(true);
  });

  it('is a transition when the previous run was blocked and this one recovered', () => {
    const prior = [{ status: 'success', blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON }];
    expect(didSourcingBlockStateChange(prior, null)).toBe(true);
  });

  it('is NOT a transition on the second consecutive blocked run of a multi-day outage (no alert spam)', () => {
    const prior = [
      { status: 'success', blockedBy: undefined },
      { status: 'success', blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON },
    ];
    expect(didSourcingBlockStateChange(prior, LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON)).toBe(false);
  });

  it('is NOT a transition when consecutive runs are both healthy', () => {
    const prior = [{ status: 'success' }, { status: 'success' }];
    expect(didSourcingBlockStateChange(prior, null)).toBe(false);
  });

  it('only looks at the IMMEDIATELY PRECEDING run, not the whole history — a settled recovery re-breaking still alerts', () => {
    // Blocked two runs ago, healthy last run, blocked again now — still a transition
    // (healthy -> blocked), not "already alerted for this outage". No createdAt on
    // these fixtures, so there's no known prior-transition time to cool down against.
    const prior = [
      { status: 'success', blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON },
      { status: 'success', blockedBy: undefined },
    ];
    expect(didSourcingBlockStateChange(prior, LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON)).toBe(true);
  });

  it('tolerates a malformed last entry without throwing', () => {
    expect(didSourcingBlockStateChange([null as any], LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON)).toBe(true);
    expect(didSourcingBlockStateChange(['nonsense' as any], null)).toBe(false);
  });

  describe('anti-flap cooldown (ENG-1131 follow-up: borderline-probe flapping)', () => {
    // Fixed reference point so tests are deterministic regardless of wall-clock time.
    const NOW = '2026-08-18T12:00:00.000Z';
    const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

    it('suppresses a re-alert when the last transition happened moments ago (rapid flap)', () => {
      // healthy -> blocked 5 minutes ago, now flipping back to healthy — too soon,
      // likely probe noise from a burst of manual re-tests rather than a real recovery.
      const prior = [
        { blockedBy: undefined, createdAt: minutesAgo(20) },
        { blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON, createdAt: minutesAgo(5) },
      ];
      expect(
        didSourcingBlockStateChange(prior, null, { now: NOW }),
      ).toBe(false);
    });

    it('still alerts once the cooldown has elapsed since the last transition', () => {
      // Same shape, but the blocked state has held for 2 hours — a real, settled
      // transition, not noise. Must alert on the recovery.
      const prior = [
        { blockedBy: undefined, createdAt: minutesAgo(180) },
        { blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON, createdAt: minutesAgo(120) },
      ];
      expect(
        didSourcingBlockStateChange(prior, null, { now: NOW }),
      ).toBe(true);
    });

    it('a schedule\'s FIRST-EVER transition is never suppressed by the cooldown (nothing to cool down against)', () => {
      expect(
        didSourcingBlockStateChange([], LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON, { now: NOW }),
      ).toBe(true);
    });

    it('a custom cooldown window is respected', () => {
      const prior = [
        { blockedBy: undefined, createdAt: minutesAgo(20) },
        { blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON, createdAt: minutesAgo(10) },
      ];
      // 10 minutes since the transition, 5-minute cooldown -> elapsed, alert fires.
      expect(
        didSourcingBlockStateChange(prior, null, { now: NOW, cooldownMs: 5 * 60_000 }),
      ).toBe(true);
      // Same history, 15-minute cooldown -> not yet elapsed, suppressed.
      expect(
        didSourcingBlockStateChange(prior, null, { now: NOW, cooldownMs: 15 * 60_000 }),
      ).toBe(false);
    });

    it('ignores entries with missing/unparseable createdAt rather than throwing or miscounting', () => {
      const prior = [
        { blockedBy: undefined, createdAt: 'not-a-date' },
        { blockedBy: LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON }, // no createdAt at all
      ];
      expect(() => didSourcingBlockStateChange(prior, null, { now: NOW })).not.toThrow();
      // No usable transition timestamp found -> nothing to cool down against -> alerts.
      expect(didSourcingBlockStateChange(prior, null, { now: NOW })).toBe(true);
    });
  });
});
