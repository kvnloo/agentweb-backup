/**
 * Tests for the ENG-1250 §8 internal reconciliation.
 *
 * The load-bearing claims: fidelity and basis divergence stay separate (they
 * have opposite expected answers), per-vendor drift cannot cancel out in a
 * total, missing and orphaned mirrors are distinguished from ordinary drift,
 * and a divergence figure is never presented as trustworthy when the mirror
 * behind it is broken.
 */
import {
  DRIFT_TOLERANCE_MICRO_USD,
  measureBasisDivergence,
  reconcileMonth,
  reconcileVendorFidelity,
  selectReconcilableSubjects,
  splitVendorModel,
  measureLlmLedgerCoverage,
} from '../services/spendReconciliation';
import { SpendEvent } from '../services/spendEventDb';
import { UsageRecordRow } from '../services/usageRecordDb';

const anEvent = (over: Partial<SpendEvent> = {}): SpendEvent => ({
  billingUserId: 'owner-1',
  eventId: 'e1',
  occurredAt: '2026-09-07T10:00:00.000Z',
  billingMonth: '2026-09',
  actingUserId: 'user-1',
  provider: 'you.com',
  operation: 'query',
  unit: 'query',
  quantity: 1,
  costMicroUsd: 12500,
  costSource: 'allocated',
  rateCardVersion: '2026-09-02',
  lifecycle: 'settled',
  ...over,
});

const aVendorRow = (over: Partial<UsageRecordRow> = {}): UsageRecordRow => ({
  userId: 'user-1',
  sk: '2026-09-07#you.com:query#agent-search',
  date: '2026-09-07',
  model: 'you.com:query',
  feature: 'agent-search',
  costMicroUsd: 12500,
  callCount: 1,
  billingUserId: 'owner-1',
  updatedAt: '2026-09-07T10:00:00.000Z',
  ttl: 0,
  provider: 'you.com',
  unit: 'query',
  quantity: 1,
  costSource: 'allocated',
  ...over,
});

/** An LLM row: provider present, unit absent — deliberately NOT a vendor entry. */
const anLlmRow = (over: Partial<UsageRecordRow> = {}): UsageRecordRow => ({
  userId: 'user-1',
  sk: '2026-09-07#anthropic.claude-opus-4-8#agent_task',
  date: '2026-09-07',
  model: 'anthropic.claude-opus-4-8',
  feature: 'agent_task',
  costMicroUsd: 3_954_436,
  callCount: 30,
  billingUserId: 'owner-1',
  updatedAt: '2026-09-07T10:00:00.000Z',
  ttl: 0,
  provider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 200,
  ...over,
});

describe('splitVendorModel', () => {
  it('splits on the FIRST colon, so an operation may contain one', () => {
    expect(splitVendorModel('you.com:query')).toEqual({ provider: 'you.com', operation: 'query' });
    expect(splitVendorModel('placid:render:pdf')).toEqual({ provider: 'placid', operation: 'render:pdf' });
  });

  it('handles a model with no colon at all', () => {
    expect(splitVendorModel('mystery')).toEqual({ provider: 'mystery', operation: '' });
  });
});

describe('reconcileVendorFidelity', () => {
  it('reports a faithful mirror as clean', () => {
    const report = reconcileVendorFidelity([anEvent()], [aVendorRow()]);

    expect(report.ok).toBe(true);
    expect(report.driftMicroUsd).toBe(0);
    expect(report.driftingGroups).toEqual([]);
  });

  it('ignores LLM rows — they were never mirrored', () => {
    // Counting them would manufacture drift equal to the whole LLM bill.
    const report = reconcileVendorFidelity([anEvent()], [aVendorRow(), anLlmRow()]);

    expect(report.ok).toBe(true);
    expect(report.liveMicroUsd).toBe(12500);
  });

  it('does NOT let per-vendor drift cancel out in the total', () => {
    // you.com over by $5, apollo under by $5. A single total reports zero —
    // the one answer that would wrongly clear this rail for enforcement.
    const events = [
      anEvent({ eventId: 'a', provider: 'you.com', operation: 'query', costMicroUsd: 5_012_500 }),
      anEvent({ eventId: 'b', provider: 'apollo', operation: 'email_reveal', costMicroUsd: 0 }),
    ];
    const rows = [
      aVendorRow({ provider: 'you.com', model: 'you.com:query', costMicroUsd: 12500 }),
      aVendorRow({
        provider: 'apollo',
        model: 'apollo:email_reveal',
        sk: 'x',
        costMicroUsd: 5_000_000,
      }),
    ];

    const report = reconcileVendorFidelity(events, rows);

    expect(report.driftMicroUsd).toBe(0); // the deceptive total
    expect(report.ok).toBe(false); // but the verdict is not fooled
    expect(report.driftingGroups).toHaveLength(2);
  });

  it('tolerates drift up to one cent and fails just past it', () => {
    const within = reconcileVendorFidelity(
      [anEvent({ costMicroUsd: 12500 + DRIFT_TOLERANCE_MICRO_USD })],
      [aVendorRow()],
    );
    const beyond = reconcileVendorFidelity(
      [anEvent({ costMicroUsd: 12500 + DRIFT_TOLERANCE_MICRO_USD + 1 })],
      [aVendorRow()],
    );

    expect(within.ok).toBe(true);
    expect(beyond.ok).toBe(false);
  });

  it('flags live vendor spend that was never mirrored, separately from drift', () => {
    // §8: a successful vendor call with no event is an operational error. It
    // means the mirror did not run, which is not the same as disagreeing.
    const report = reconcileVendorFidelity([], [aVendorRow()]);

    expect(report.ok).toBe(false);
    expect(report.unmirroredGroups).toHaveLength(1);
    expect(report.driftingGroups).toEqual([]);
  });

  it('flags shadow events with no live row behind them', () => {
    // The inverse error, and the more alarming one: the shadow leading the live
    // rail is what the ENG-1804 ordering fix exists to prevent.
    const report = reconcileVendorFidelity([anEvent()], []);

    expect(report.ok).toBe(false);
    expect(report.orphanGroups).toHaveLength(1);
    expect(report.unmirroredGroups).toEqual([]);
  });

  it('counts settled events only', () => {
    const report = reconcileVendorFidelity(
      [
        anEvent({ eventId: 'a', costMicroUsd: 12500 }),
        anEvent({ eventId: 'b', costMicroUsd: 999_999, lifecycle: 'reserved' }),
        anEvent({ eventId: 'c', costMicroUsd: 0, lifecycle: 'voided' }),
      ],
      [aVendorRow()],
    );

    expect(report.ok).toBe(true);
    expect(report.ledgerMicroUsd).toBe(12500);
  });

  it('separates the same vendor on different days', () => {
    const report = reconcileVendorFidelity(
      [
        anEvent({ eventId: 'a', occurredAt: '2026-09-06T10:00:00.000Z' }),
        anEvent({ eventId: 'b', occurredAt: '2026-09-07T10:00:00.000Z' }),
      ],
      [aVendorRow({ date: '2026-09-06' }), aVendorRow({ date: '2026-09-07' })],
    );

    expect(report.groupCount).toBe(2);
    expect(report.ok).toBe(true);
  });

  it('prefers the row\'s provider attribute over the parsed model slot', () => {
    // The slot is a naming convention; the attribute is the data.
    const report = reconcileVendorFidelity(
      [anEvent({ provider: 'you.com', operation: 'query' })],
      [aVendorRow({ provider: 'you.com', model: 'MISNAMED:query' })],
    );

    expect(report.groupCount).toBe(1);
    expect(report.ok).toBe(true);
  });
});

describe('mirrorStartedAt — scoping fidelity to the period the mirror existed', () => {
  const MIRROR_START = '2026-09-07T15:09:00.000Z';

  it('without the bound, history the mirror never saw reads as failure forever', () => {
    // This is the state the first live run was in: every pre-deploy row
    // unmirrored by construction, so fidelity could never go green.
    const report = reconcileVendorFidelity([], [aVendorRow({ date: '2026-09-01' })]);

    expect(report.ok).toBe(false);
    expect(report.unmirroredGroups).toHaveLength(1);
  });

  it('drops whole days before the mirror started', () => {
    const report = reconcileVendorFidelity([], [aVendorRow({ date: '2026-09-01' })], {
      mirrorStartedAt: MIRROR_START,
    });

    expect(report.preMirrorGroups).toHaveLength(1);
    expect(report.unmirroredGroups).toEqual([]);
    expect(report.assessedGroupCount).toBe(0);
  });

  it('treats the changeover day as partial, not as a failure', () => {
    // The live rail aggregates per DAY, so that row legitimately holds calls
    // from both sides of the deploy and cannot be split.
    const report = reconcileVendorFidelity(
      [anEvent({ occurredAt: '2026-09-07T16:00:00.000Z' })],
      [aVendorRow({ date: '2026-09-07', costMicroUsd: 62500, callCount: 5 })],
      { mirrorStartedAt: MIRROR_START },
    );

    expect(report.partialGroups).toHaveLength(1);
    expect(report.driftingGroups).toEqual([]);
    expect(report.assessedGroupCount).toBe(0);
  });

  it('assesses days fully after the mirror started', () => {
    const report = reconcileVendorFidelity(
      [anEvent({ occurredAt: '2026-09-08T10:00:00.000Z' })],
      [aVendorRow({ date: '2026-09-08' })],
      { mirrorStartedAt: MIRROR_START },
    );

    expect(report.assessedGroupCount).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.driftMicroUsd).toBe(0);
  });

  it('totals cover assessed groups only, so they cannot contradict the verdict', () => {
    // A huge pre-mirror drift printed beside ok:true would make a reader
    // trusting the number conclude the ledger is broken when it is just young.
    const report = reconcileVendorFidelity(
      [anEvent({ occurredAt: '2026-09-08T10:00:00.000Z' })],
      [aVendorRow({ date: '2026-09-01', costMicroUsd: 9_000_000 }), aVendorRow({ date: '2026-09-08' })],
      { mirrorStartedAt: MIRROR_START },
    );

    expect(report.ok).toBe(true);
    expect(report.liveMicroUsd).toBe(12500);
    expect(report.driftMicroUsd).toBe(0);
  });

  it('a run that assessed nothing is NOT evidence, even though ok is true', () => {
    // The worst failure this module could have: a green light produced by
    // having no data at all.
    const report = reconcileMonth('owner-1', '2026-09', [], [aVendorRow({ date: '2026-09-01' })], {
      mirrorStartedAt: MIRROR_START,
    });

    expect(report.fidelity.ok).toBe(true);
    expect(report.fidelity.assessedGroupCount).toBe(0);
    expect(report.readyForCutoverEvidence).toBe(false);
  });
});

describe('measureBasisDivergence', () => {
  const clean = reconcileVendorFidelity([anEvent()], [aVendorRow()]);

  it('separates LLM-only spend from all-vendor spend', () => {
    const d = measureBasisDivergence([anLlmRow({ costMicroUsd: 1_000_000 }), aVendorRow({ costMicroUsd: 250_000 })], clean);

    expect(d.llmOnlyMicroUsd).toBe(1_000_000);
    expect(d.vendorMicroUsd).toBe(250_000);
    expect(d.allVendorMicroUsd).toBe(1_250_000);
    expect(d.increasePercent).toBe(25);
  });

  it('reports 0% rather than Infinity when there is no LLM baseline', () => {
    const d = measureBasisDivergence([aVendorRow({ costMicroUsd: 250_000 })], clean);

    expect(Number.isFinite(d.increasePercent)).toBe(true);
    expect(d.increasePercent).toBe(0);
  });

  it('marks the measurement untrustworthy when the mirror is broken', () => {
    // A divergence computed over a mirror that loses events UNDERSTATES the
    // answer, which would argue for a cutover on false evidence.
    const broken = reconcileVendorFidelity([], [aVendorRow()]);

    expect(measureBasisDivergence([anLlmRow(), aVendorRow()], broken).trustworthy).toBe(false);
  });

  it('is NOT trustworthy when nothing was assessed, even though ok is vacuously true', () => {
    // Found by running the report against production: every group was
    // pre-mirror, fidelity reported ok, and the divergence printed as clean
    // while resting on no comparison at all.
    const vacuous = reconcileVendorFidelity([], [aVendorRow({ date: '2026-09-01' })], {
      mirrorStartedAt: '2026-09-07T15:09:00.000Z',
    });

    expect(vacuous.ok).toBe(true);
    expect(vacuous.assessedGroupCount).toBe(0);
    expect(measureBasisDivergence([anLlmRow(), aVendorRow()], vacuous).trustworthy).toBe(false);
  });

  it('marks it trustworthy when the mirror is faithful', () => {
    expect(measureBasisDivergence([anLlmRow(), aVendorRow()], clean).trustworthy).toBe(true);
  });
});

describe('selectReconcilableSubjects', () => {
  it('includes a subject whose mirror failed COMPLETELY — the worst case', () => {
    // No events at all, only live vendor rows. Deriving subjects from events
    // would skip it entirely and the run would print clean precisely when the
    // mirror had failed hardest.
    const { reconcilable } = selectReconcilableSubjects([], [aVendorRow({ billingUserId: 'all-failed' })]);

    expect(reconcilable).toEqual(['all-failed']);
  });

  it('includes a subject known only from the ledger', () => {
    const { reconcilable } = selectReconcilableSubjects([anEvent({ billingUserId: 'ledger-only' })], []);

    expect(reconcilable).toEqual(['ledger-only']);
  });

  it('separates LLM-only subjects instead of dropping them silently', () => {
    const { reconcilable, llmOnly } = selectReconcilableSubjects(
      [],
      [anLlmRow({ billingUserId: 'llm-guy' }), aVendorRow({ billingUserId: 'vendor-guy' })],
    );

    expect(reconcilable).toEqual(['vendor-guy']);
    expect(llmOnly).toEqual(['llm-guy']);
  });

  it('does not list a subject as LLM-only when it also has vendor spend', () => {
    const { reconcilable, llmOnly } = selectReconcilableSubjects(
      [],
      [anLlmRow({ billingUserId: 'both' }), aVendorRow({ billingUserId: 'both' })],
    );

    expect(reconcilable).toEqual(['both']);
    expect(llmOnly).toEqual([]);
  });

  it('deduplicates and sorts', () => {
    const { reconcilable } = selectReconcilableSubjects(
      [anEvent({ billingUserId: 'b' }), anEvent({ billingUserId: 'a' })],
      [aVendorRow({ billingUserId: 'b' })],
    );

    expect(reconcilable).toEqual(['a', 'b']);
  });
});

describe('reconcileMonth', () => {
  it('scopes both rails to the subject and month', () => {
    const report = reconcileMonth(
      'owner-1',
      '2026-09',
      [
        anEvent({ eventId: 'mine' }),
        anEvent({ eventId: 'theirs', billingUserId: 'owner-2', costMicroUsd: 999_999 }),
        anEvent({ eventId: 'august', billingMonth: '2026-08', costMicroUsd: 888_888 }),
      ],
      [
        aVendorRow(),
        aVendorRow({ billingUserId: 'owner-2', costMicroUsd: 999_999 }),
        aVendorRow({ date: '2026-08-31', costMicroUsd: 888_888 }),
      ],
    );

    expect(report.fidelity.ledgerMicroUsd).toBe(12500);
    expect(report.fidelity.liveMicroUsd).toBe(12500);
    expect(report.fidelity.ok).toBe(true);
  });

  it('readyForCutoverEvidence tracks fidelity, not the size of the divergence', () => {
    // A large divergence is the EXPECTED finding, not a failure.
    const report = reconcileMonth(
      'owner-1',
      '2026-09',
      [anEvent()],
      [aVendorRow(), anLlmRow({ costMicroUsd: 100 })],
    );

    expect(report.divergence.increasePercent).toBeGreaterThan(100);
    expect(report.readyForCutoverEvidence).toBe(true);
  });

  it('is not ready when the mirror missed a vendor', () => {
    const report = reconcileMonth('owner-1', '2026-09', [], [aVendorRow()]);

    expect(report.readyForCutoverEvidence).toBe(false);
  });
});

// ── ENG-1934: LLM events on the ledger ──────────────────────────────────────

const anLlmEvent = (over: Partial<SpendEvent> = {}): SpendEvent =>
  anEvent({
    eventId: 'llm:msg-1',
    provider: 'bedrock',
    operation: 'anthropic.claude-opus-4-8',
    feature: 'agent_task',
    unit: 'llm_token',
    quantity: 1200,
    costMicroUsd: 3_954_436,
    rateCardVersion: 'llm-price-book:2026-09-10',
    ...over,
  });

describe('LLM fidelity (ENG-1934)', () => {
  const llmMirrorStartedAt = '2026-09-05T00:00:00.000Z';

  it('without an LLM start, LLM events are ignored — never reported as orphans on the vendor rail', () => {
    const report = reconcileVendorFidelity([anLlmEvent()], [anLlmRow()]);

    expect(report.orphanGroups).toEqual([]);
    expect(report.groupCount).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('with an LLM start, a matching event and aggregate row reconcile clean', () => {
    const report = reconcileVendorFidelity([anLlmEvent()], [anLlmRow()], { llmMirrorStartedAt });

    expect(report.assessedGroupCount).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.ledgerMicroUsd).toBe(report.liveMicroUsd);
  });

  it('keys LLM groups on model, not provider — a pre-ENG-693 row with no provider still matches', () => {
    const report = reconcileVendorFidelity([anLlmEvent({ provider: 'bedrock' })], [anLlmRow({ provider: undefined })], {
      llmMirrorStartedAt,
    });

    expect(report.ok).toBe(true);
    expect(report.unmirroredGroups).toEqual([]);
    expect(report.orphanGroups).toEqual([]);
  });

  it('an LLM aggregate row with no event after the start is UNMIRRORED — the failure this check exists for', () => {
    const report = reconcileVendorFidelity([], [anLlmRow()], { llmMirrorStartedAt });

    expect(report.ok).toBe(false);
    expect(report.unmirroredGroups).toHaveLength(1);
    expect(report.unmirroredGroups[0]).toMatchObject({ rail: 'llm', provider: 'llm', operation: 'anthropic.claude-opus-4-8' });
  });

  it('LLM drift beyond a cent is reported per model', () => {
    const report = reconcileVendorFidelity(
      [anLlmEvent({ costMicroUsd: 3_954_436 - DRIFT_TOLERANCE_MICRO_USD - 1 })],
      [anLlmRow()],
      { llmMirrorStartedAt },
    );

    expect(report.driftingGroups).toHaveLength(1);
  });

  it('uses the LLM start for LLM groups and the vendor start for vendor groups, independently', () => {
    const report = reconcileVendorFidelity(
      [],
      [anLlmRow({ date: '2026-09-04' }), aVendorRow({ date: '2026-09-04' })],
      { mirrorStartedAt: '2026-09-01T00:00:00.000Z', llmMirrorStartedAt },
    );

    // Same day: before the LLM mirror (not a finding), after the vendor mirror (a finding).
    expect(report.preMirrorGroups.map((g) => g.rail)).toEqual(['llm']);
    expect(report.unmirroredGroups.map((g) => g.rail)).toEqual(['vendor']);
  });

  it('the LLM changeover day is partial, not a failure', () => {
    const report = reconcileVendorFidelity([], [anLlmRow({ date: '2026-09-05' })], { llmMirrorStartedAt });

    expect(report.partialGroups).toHaveLength(1);
    expect(report.ok).toBe(true);
  });

  it('an aggregate row labelled unpriced is not counted as unmirrored spend', () => {
    const report = reconcileVendorFidelity(
      [],
      [anLlmRow({ model: 'model-nobody-priced', costSource: 'unpriced', costMicroUsd: 0 })],
      { llmMirrorStartedAt },
    );

    expect(report.unmirroredGroups).toEqual([]);
    expect(report.groupCount).toBe(0);
  });

  it('trusts an ALLOCATED $0 row for an unknown model — its $0 event is matched, not orphaned (CodeRabbit, PR #2904)', () => {
    const report = reconcileVendorFidelity(
      [anLlmEvent({ operation: 'model-nobody-priced', costMicroUsd: 0 })],
      [anLlmRow({ model: 'model-nobody-priced', costSource: 'allocated', costMicroUsd: 0 })],
      { llmMirrorStartedAt },
    );

    expect(report.orphanGroups).toEqual([]);
    expect(report.assessedGroupCount).toBe(1);
    expect(report.ok).toBe(true);
  });

  it('a vendor and an LLM group can never collide into one', () => {
    const report = reconcileVendorFidelity(
      [anLlmEvent(), anEvent()],
      [anLlmRow(), aVendorRow()],
      { mirrorStartedAt: '2026-09-01T00:00:00.000Z', llmMirrorStartedAt },
    );

    expect(report.groupCount).toBe(2);
    expect(report.ok).toBe(true);
  });

  describe('selectReconcilableSubjects with includeLlm', () => {
    it('without it, an LLM-only subject stays llmOnly even when it has LLM events', () => {
      const { reconcilable, llmOnly } = selectReconcilableSubjects([anLlmEvent()], [anLlmRow()]);

      expect(reconcilable).toEqual([]);
      expect(llmOnly).toEqual(['owner-1']);
    });

    it('with it, LLM activity on the live rail alone makes a subject reconcilable — so a total mirror failure is examined', () => {
      const { reconcilable, llmOnly } = selectReconcilableSubjects([], [anLlmRow({ billingUserId: 'all-llm-failed' })], {
        includeLlm: true,
      });

      expect(reconcilable).toEqual(['all-llm-failed']);
      expect(llmOnly).toEqual([]);
    });
  });
});

describe('measureLlmLedgerCoverage (ENG-1934)', () => {
  const original = process.env.SPEND_LEDGER_LLM_DUAL_WRITE;
  afterEach(() => {
    if (original === undefined) delete process.env.SPEND_LEDGER_LLM_DUAL_WRITE;
    else process.env.SPEND_LEDGER_LLM_DUAL_WRITE = original;
  });

  it('a month that ended before LLM events existed is "none", and is not measured', () => {
    const c = measureLlmLedgerCoverage('2026-08', [], [anLlmRow({ date: '2026-08-20' })]);

    expect(c).toMatchObject({ month: 'none', aggregateLlmMicroUsd: null, missingLlmMicroUsd: null });
  });

  it('is "full" when the ledger holds the aggregate rail\'s LLM spend within a cent', () => {
    const c = measureLlmLedgerCoverage('2026-09', [anLlmEvent()], [anLlmRow(), aVendorRow()]);

    // The vendor row is not LLM spend and must not count against coverage.
    expect(c).toMatchObject({ month: 'full', ledgerLlmMicroUsd: 3_954_436, aggregateLlmMicroUsd: 3_954_436, missingLlmMicroUsd: 0 });
  });

  it('is "partial" with the missing amount when LLM spend has no events — a switch-off week, a fallback write, or the days before recording began', () => {
    const c = measureLlmLedgerCoverage(
      '2026-09',
      [anLlmEvent()],
      [anLlmRow(), anLlmRow({ date: '2026-09-02', costMicroUsd: 2_000_000 })],
    );

    expect(c).toMatchObject({ month: 'partial', missingLlmMicroUsd: 2_000_000 });
  });

  it('an unmeasurable month is "partial", never assumed complete', () => {
    const c = measureLlmLedgerCoverage('2026-09', [anLlmEvent()], null);

    expect(c).toMatchObject({ month: 'partial', missingLlmMicroUsd: null });
  });

  it('ignores vendor events, unsettled events and unpriced rows on either side', () => {
    const c = measureLlmLedgerCoverage(
      '2026-09',
      [anLlmEvent(), anEvent({ costMicroUsd: 9_999_999 }), anLlmEvent({ eventId: 'r', lifecycle: 'reserved' })],
      [anLlmRow(), anLlmRow({ model: 'x', costSource: 'unpriced', costMicroUsd: 0 })],
    );

    expect(c).toMatchObject({ month: 'full', ledgerLlmMicroUsd: 3_954_436 });
  });

  it('reports the kill switch as it is right now', () => {
    process.env.SPEND_LEDGER_LLM_DUAL_WRITE = 'false';
    expect(measureLlmLedgerCoverage('2026-10', [], []).recording).toBe(false);
  });
});
