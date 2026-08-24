/**
 * Tests for the CRM lead auto-enrichment cron (ENG-88).
 *
 * Ray used to manually POST the "renew" (enrich) action against a managed
 * campaign's lead list a few times by hand. With Ray leaving, this scans
 * lists that have opted into `enrichmentConfig.autoEnrich` and enriches
 * their un-enriched leads automatically — no click required.
 *
 * Opt-in, default OFF: a list with no saved config, or a saved config with
 * `autoEnrich` unset/false, is never touched. This is deliberate — which
 * specific managed-account lists should run this is a scope/spend decision
 * left to a human (see ENG-88 comment), not something this cron guesses.
 */

import {
  runCrmAutoEnrichmentCron,
  type CrmAutoEnrichmentCronDeps,
} from '../cron/crmAutoEnrichmentCron';
import type { EnrichmentConfig } from '../services/crmEnrichmentServiceV3';

function baseConfig(overrides: Partial<EnrichmentConfig> = {}): EnrichmentConfig {
  return {
    fields: [
      { name: 'company_url', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
    ],
    globalOverwriteDefault: 'fill_if_empty',
    schemaVersion: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedBy: 'u1',
    ...overrides,
  } as EnrichmentConfig;
}

function lead(leadId: string, overrides: Record<string, any> = {}) {
  return { leadId, listId: 'list-1', ...overrides };
}

function makeDeps(overrides: Partial<CrmAutoEnrichmentCronDeps> = {}): CrmAutoEnrichmentCronDeps {
  return {
    getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([]),
    getEnrichmentConfig: jest.fn().mockResolvedValue({ config: baseConfig({ autoEnrich: true }), isDefault: false }),
    getAllLeadsByListId: jest.fn().mockResolvedValue([]),
    runEnrichment: jest.fn().mockResolvedValue({
      runId: 'run-1',
      processed: 0,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: { total: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } },
      durationMs: 5,
    }),
    buildOrchestratorDeps: jest.fn().mockReturnValue({} as any),
    sendAlert: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('runCrmAutoEnrichmentCron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enriches un-enriched leads on a list that has opted in (autoEnrich: true)', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockResolvedValue([
        lead('lead-1'), // no enrichmentMetadata → un-enriched
        lead('lead-2', { enrichmentMetadata: {} }), // empty → still un-enriched
      ]),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.runEnrichment).toHaveBeenCalledTimes(1);
    const [runInput] = (deps.runEnrichment as jest.Mock).mock.calls[0];
    expect(runInput.listId).toBe('list-1');
    expect(runInput.userId).toBe('u1');
    expect(runInput.mode).toBe('enrich');
    expect(new Set(runInput.leadIds)).toEqual(new Set(['lead-1', 'lead-2']));
    expect(summary.processedLeads).toBe(0); // from the mocked runEnrichment result
    expect(summary.eligibleLists).toBe(1);
  });

  it('a freshly-created (un-enriched) lead on an opted-in list reaches the automated enrichment call within one cron cycle — no manual action', async () => {
    // AC1: "assert via test that a freshly-created lead reaches `enriched`
    // state through the automated path within {WINDOW}, no manual action."
    // WINDOW = one cron cycle: the lead is picked up and passed to the
    // enrichment engine on the very first run that sees it as un-enriched.
    const freshLead = lead('fresh-lead');
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockResolvedValue([freshLead]),
      runEnrichment: jest.fn().mockResolvedValue({
        runId: 'run-1',
        processed: 1,
        failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
        tierFillBreakdown: { total: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } },
        durationMs: 5,
      }),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.runEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({ leadIds: ['fresh-lead'], mode: 'enrich' }),
      expect.anything(),
    );
    expect(summary.processedLeads).toBe(1);
    // No manual action anywhere in this path — the whole call chain is cron → deps.
  });

  it('never touches a list with no saved config (isDefault: true) even if listed as a candidate', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getEnrichmentConfig: jest.fn().mockResolvedValue({ config: baseConfig(), isDefault: true }),
      getAllLeadsByListId: jest.fn().mockResolvedValue([lead('lead-1')]),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.runEnrichment).not.toHaveBeenCalled();
    expect(summary.processedLeads).toBe(0);
  });

  it('never touches a list whose saved config has autoEnrich unset (default OFF) — proves zero blast radius for every existing list', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getEnrichmentConfig: jest.fn().mockResolvedValue({ config: baseConfig(), isDefault: false }), // autoEnrich omitted
      getAllLeadsByListId: jest.fn().mockResolvedValue([lead('lead-1')]),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.getAllLeadsByListId).not.toHaveBeenCalled();
    expect(deps.runEnrichment).not.toHaveBeenCalled();
    expect(summary.processedLeads).toBe(0);
  });

  it('never touches a list whose saved config has autoEnrich: false explicitly', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getEnrichmentConfig: jest.fn().mockResolvedValue({ config: baseConfig({ autoEnrich: false }), isDefault: false }),
      getAllLeadsByListId: jest.fn().mockResolvedValue([lead('lead-1')]),
    });

    await runCrmAutoEnrichmentCron(deps);

    expect(deps.runEnrichment).not.toHaveBeenCalled();
  });

  it('skips a list with nothing left to enrich (all leads already have enrichmentMetadata) — idempotent, no re-charge', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockResolvedValue([
        lead('lead-1', { enrichmentMetadata: { company_url: { enrichedAt: '2026-08-01T00:00:00.000Z', source: 'apollo' } } }),
      ]),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.runEnrichment).not.toHaveBeenCalled();
    expect(summary.processedLeads).toBe(0);
  });

  it('still treats a lead as un-enriched when its only enrichmentMetadata entry is for a field the config never enabled (e.g. email_validation)', async () => {
    // Regression: crmDb.setLeadEmailValidation writes
    // enrichmentMetadata.email_validation without ever running the
    // configured enrichment fields. "any metadata key present" would
    // wrongly mark this lead permanently done even though the enabled
    // field (company_url) was never populated.
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getEnrichmentConfig: jest.fn().mockResolvedValue({
        config: baseConfig({ autoEnrich: true }), // enabled field: company_url
        isDefault: false,
      }),
      getAllLeadsByListId: jest.fn().mockResolvedValue([
        lead('lead-1', { enrichmentMetadata: { email_validation: { enrichedAt: '2026-08-01T00:00:00.000Z', source: 'validator' } } }),
      ]),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.runEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({ leadIds: ['lead-1'] }),
      expect.anything(),
    );
    expect(summary.eligibleLists).toBe(1);
  });

  it('is idempotent across two consecutive runs — the second run only re-processes leads still un-enriched after the first', async () => {
    // Simulates: run 1 enriches lead-1; DB now reflects it as enriched;
    // run 2 must not re-select lead-1 (no double Apollo/LLM charge).
    let leadIsEnriched = false;
    const runEnrichment = jest.fn().mockImplementation(async () => {
      leadIsEnriched = true;
      return {
        runId: 'run-x',
        processed: 1,
        failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
        tierFillBreakdown: { total: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } },
        durationMs: 5,
      };
    });
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockImplementation(async () => [
        lead('lead-1', leadIsEnriched ? { enrichmentMetadata: { company_url: { enrichedAt: 'now', source: 'apollo' } } } : {}),
      ]),
      runEnrichment,
    });

    await runCrmAutoEnrichmentCron(deps);
    await runCrmAutoEnrichmentCron(deps);

    expect(runEnrichment).toHaveBeenCalledTimes(1);
  });

  it('caps the number of leads processed per list per run (rate-limit-safe bound)', async () => {
    const manyLeads = Array.from({ length: 500 }, (_, i) => lead(`lead-${i}`));
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockResolvedValue(manyLeads),
    });

    await runCrmAutoEnrichmentCron(deps);

    const [runInput] = (deps.runEnrichment as jest.Mock).mock.calls[0];
    expect(runInput.leadIds.length).toBeLessThanOrEqual(50);
  });

  it('surfaces a failed enrichment run via the oncall alert — not silently swallowed', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockResolvedValue([lead('lead-1')]),
      runEnrichment: jest.fn().mockResolvedValue({
        runId: 'run-2',
        processed: 0,
        failed: { identityResolutionFailed: 1, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
        tierFillBreakdown: { total: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } },
        durationMs: 5,
      }),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: expect.stringContaining('list-1'),
        context: expect.objectContaining({ listId: 'list-1' }),
      }),
    );
    expect(summary.failedLists).toBe(1);
  });

  it('surfaces a hard crash (e.g. runEnrichment throws) via the oncall alert and continues to the next list — never silently swallowed', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([
        { listId: 'list-1', userId: 'u1' },
        { listId: 'list-2', userId: 'u2' },
      ]),
      getEnrichmentConfig: jest.fn().mockResolvedValue({ config: baseConfig({ autoEnrich: true }), isDefault: false }),
      getAllLeadsByListId: jest.fn().mockResolvedValue([lead('lead-1')]),
      runEnrichment: jest
        .fn()
        .mockRejectedValueOnce(new Error('Apollo quota exceeded'))
        .mockResolvedValueOnce({
          runId: 'run-3',
          processed: 1,
          failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
          tierFillBreakdown: { total: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } },
          durationMs: 5,
        }),
    });

    const summary = await runCrmAutoEnrichmentCron(deps);

    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: expect.stringContaining('list-1') }),
    );
    // The crash on list-1 must not stop list-2 from being processed.
    expect(deps.runEnrichment).toHaveBeenCalledTimes(2);
    expect(summary.failedLists).toBe(1);
    expect(summary.processedLeads).toBe(1);
  });

  it('never lets an alert-send failure crash the run — logs and continues', async () => {
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockResolvedValue([lead('lead-1')]),
      runEnrichment: jest.fn().mockRejectedValue(new Error('boom')),
      sendAlert: jest.fn().mockRejectedValue(new Error('slack is down')),
    });

    await expect(runCrmAutoEnrichmentCron(deps)).resolves.toBeDefined();
  });

  it('does not let a run still in progress overlap with a new invocation on the same list (no double-charge from overlapping ticks)', async () => {
    let resolveFirst!: (v: any) => void;
    const firstRunPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const runEnrichment = jest.fn().mockImplementation(() => firstRunPromise);
    const deps = makeDeps({
      getAutoEnrichEnabledLists: jest.fn().mockResolvedValue([{ listId: 'list-1', userId: 'u1' }]),
      getAllLeadsByListId: jest.fn().mockResolvedValue([lead('lead-1')]),
      runEnrichment,
    });

    const run1 = runCrmAutoEnrichmentCron(deps);
    // Second invocation starts before the first has resolved its in-flight enrichment call.
    const run2 = runCrmAutoEnrichmentCron(deps);

    resolveFirst({
      runId: 'run-1',
      processed: 1,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: { total: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } },
      durationMs: 5,
    });

    const [summary1, summary2] = await Promise.all([run1, run2]);

    // Only one of the two overlapping runs actually calls runEnrichment for list-1.
    expect(runEnrichment).toHaveBeenCalledTimes(1);
    const skippedCount = [summary1, summary2].filter((s) => s.skippedOverlapping > 0).length;
    expect(skippedCount).toBe(1);
  });
});
