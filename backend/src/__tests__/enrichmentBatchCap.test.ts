import { runEnrichment, OrchestratorDeps, RunEnrichmentInput } from '../services/crmEnrichmentServiceV3';
import { crmDb } from '../services/db';

jest.mock('../services/db', () => ({ crmDb: {
  createEnrichmentSnapshotItem: jest.fn().mockResolvedValue(undefined),
  createEnrichmentJobMeta: jest.fn().mockResolvedValue(undefined),
} }));
jest.mock('../services/enrichmentSiblingConfigFields', () => ({
  buildSiblingFieldMappingTable: jest.fn().mockResolvedValue({ canonical: new Map(), llm: new Map() }),
  copySiblingConfigFields: jest.fn().mockReturnValue({ fills: [], remainingFields: [] }),
}));

const input: RunEnrichmentInput = {
  listId: 'list', userId: 'owner', mode: 'enrich', config: {
    fields: [{ name: 'company_name', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }], globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1,
    updatedAt: '', updatedBy: 'owner',
  },
};
function deps(checkBudget: jest.Mock): OrchestratorDeps {
  return {
    checkBudget,
    loadLeads: jest.fn().mockResolvedValue(Array.from({ length: 45 }, (_, i) => ({ leadId: `lead-${i}`, customFields: {} }))),
    resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
    runWaterfall: jest.fn().mockResolvedValue({
      fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo', enrichedAt: '2026-10-28T00:00:00Z' } }],
      missing: [], tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
    }), extractUngroupedFieldsViaWeb: jest.fn(),
    runCriticOverWebFills: jest.fn(), setLeadFields: jest.fn(), evaluateSmartField: jest.fn(),
  };
}
beforeEach(() => jest.clearAllMocks());
it('blocks an unaffordable up-front estimate before any paid lead work', async () => {
  const d = deps(jest.fn().mockResolvedValue(false));
  const result = await runEnrichment(input, d);
  expect(result.processed).toBe(0);
  expect(result.budgetStop).toMatchObject({ reason: 'usage_cap', remainingLeads: 45 });
  expect(result.budgetStop?.message).toMatch(/allowance.*Extra Usage cap/);
  expect(d.resolveIdentity).not.toHaveBeenCalled();
  expect(crmDb.createEnrichmentSnapshotItem).not.toHaveBeenCalled();
});
it('halts at the next batch, records partial results, and never starts/bills refused leads', async () => {
  const check = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  const d = deps(check);
  const result = await runEnrichment(input, d);
  expect(d.resolveIdentity).toHaveBeenCalledTimes(20);
  expect(d.runWaterfall).toHaveBeenCalledTimes(20);
  expect(d.setLeadFields).toHaveBeenCalledTimes(20);
  expect(crmDb.createEnrichmentSnapshotItem).toHaveBeenCalledTimes(20);
  expect(result.processed).toBe(20);
  expect(result.budgetStop?.remainingLeads).toBe(25);
  expect(check.mock.calls.map(([arg]) => [arg.leadCount, arg.phase])).toEqual([[45, 'preflight'], [20, 'batch'], [20, 'batch']]);
  expect(crmDb.createEnrichmentJobMeta).toHaveBeenCalledWith(expect.objectContaining({
    processedCount: 20, attemptedLeadIds: Array.from({ length: 20 }, (_, i) => `lead-${i}`),
  }));
});
it('fails closed on an unavailable budget check but retains prior batch results', async () => {
  const d = deps(jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockRejectedValue(new Error('ledger unavailable')));
  const result = await runEnrichment(input, d);
  expect(result.processed).toBe(20);
  expect(result.budgetStop?.reason).toBe('usage_unavailable');
  expect(d.resolveIdentity).toHaveBeenCalledTimes(20);
});
it('guards preview too because it can incur vendor spend', async () => {
  const d = deps(jest.fn().mockResolvedValue(false));
  const result = await runEnrichment({ ...input, mode: 'preview' }, d);
  expect(result.processed).toBe(0);
  expect(d.resolveIdentity).not.toHaveBeenCalled();
});
