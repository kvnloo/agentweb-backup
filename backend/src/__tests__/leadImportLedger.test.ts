import {
  LEAD_IMPORT_ROW_LIST_CAP,
  LEAD_IMPORT_WRITE_BUDGET_MS,
  buildLeadImportRowOutcomes,
  capLeadRowList,
  describeLeadRow,
  summarizeLeadRowNumbers,
} from '../utils/leadImportLedger';

// ENG-1133. These helpers are the resumable-import contract, but every caller
// of them lives behind agentModeService — which CI runs in the agentMode shard,
// where coverage is not collected. Exercising them directly keeps the contract
// pinned in the shard that does.
describe('leadImportLedger', () => {
  describe('buildLeadImportRowOutcomes', () => {
    it('uses the per-row ledger when it lines up with the rows attempted', () => {
      const result = buildLeadImportRowOutcomes(
        { rowOutcomes: ['created', 'merged', 'failed'] },
        3,
      );
      expect(result.rowAligned).toBe(true);
      expect(result.outcomes).toEqual(['created', 'merged', 'failed']);
    });

    it('falls back to the aggregate counts when there is no ledger at all', () => {
      const result = buildLeadImportRowOutcomes(
        { newCount: 2, mergedCount: 1, alreadyPresentCount: 1, anonymizedSkipped: 1, errorCount: 1 },
        6,
      );
      expect(result.rowAligned).toBe(false);
      expect(result.outcomes).toEqual([
        'created', 'created', 'merged', 'already_present', 'anonymized_skipped', 'failed',
      ]);
    });

    it('refuses a ledger whose length disagrees with the rows attempted', () => {
      // A short ledger cannot be trusted to be in input order, so naming a
      // specific row from it would be a guess.
      const result = buildLeadImportRowOutcomes({ rowOutcomes: ['created'], newCount: 1 }, 3);
      expect(result.rowAligned).toBe(false);
      expect(result.outcomes).toEqual(['created', 'unprocessed', 'unprocessed']);
    });

    it('pads rows the aggregate counts never account for as unprocessed', () => {
      const result = buildLeadImportRowOutcomes({ newCount: 1 }, 4);
      expect(result.outcomes).toEqual(['created', 'unprocessed', 'unprocessed', 'unprocessed']);
    });

    it('never reports more outcomes than rows attempted', () => {
      const result = buildLeadImportRowOutcomes({ newCount: 5 }, 2);
      expect(result.outcomes).toEqual(['created', 'created']);
    });
  });

  describe('describeLeadRow', () => {
    it('prefers email, then linkedin, then name and company', () => {
      expect(describeLeadRow({ email: ' a@b.com ', linkedin: 'x', firstName: 'Ada' }, 0)).toBe('a@b.com');
      expect(describeLeadRow({ email: '  ', linkedin: 'in/ada', company: 'Acme' }, 0)).toBe('in/ada');
      expect(describeLeadRow({ firstName: 'Ada', lastName: 'Lovelace', company: 'Acme' }, 0)).toBe('Ada Lovelace @ Acme');
    });

    it('falls back through name, company, then the row position', () => {
      expect(describeLeadRow({ lastName: 'Lovelace' }, 0)).toBe('Lovelace');
      expect(describeLeadRow({ company: 'Acme' }, 0)).toBe('Acme');
      expect(describeLeadRow({}, 6)).toBe('row 7');
    });

    it('ignores non-string field values rather than stringifying them', () => {
      expect(describeLeadRow({ email: 42, company: { name: 'Acme' }, firstName: null }, 2)).toBe('row 3');
    });

    it('names a row even when the row itself is missing', () => {
      expect(describeLeadRow(undefined, 0)).toBe('row 1');
    });
  });

  describe('summarizeLeadRowNumbers', () => {
    it('is empty when nothing is missing', () => {
      expect(summarizeLeadRowNumbers([])).toBe('');
    });

    it('collapses a contiguous run — the shape a cut-off import produces', () => {
      expect(summarizeLeadRowNumbers([101, 102, 103])).toBe('101-103');
    });

    it('keeps isolated rows as single positions', () => {
      expect(summarizeLeadRowNumbers([7])).toBe('7');
      expect(summarizeLeadRowNumbers([7, 19, 101, 102, 103, 200])).toBe('7,19,101-103,200');
    });

    it('sorts and de-duplicates positions', () => {
      expect(summarizeLeadRowNumbers([3, 1, 2, 2, 9])).toBe('1-3,9');
    });

    it('stays complete past the detail cap, so a truncated list cannot strand rows', () => {
      const missing = Array.from({ length: LEAD_IMPORT_ROW_LIST_CAP + 120 }, (_, i) => i + 1);
      expect(summarizeLeadRowNumbers(missing)).toBe(`1-${LEAD_IMPORT_ROW_LIST_CAP + 120}`);
    });
  });

  describe('capLeadRowList', () => {
    it('echoes a list that fits under the cap unchanged', () => {
      expect(capLeadRowList('importedIdentifiers', ['a', 'b'])).toEqual({ importedIdentifiers: ['a', 'b'] });
    });

    it('echoes a list exactly at the cap unchanged', () => {
      const rows = Array.from({ length: LEAD_IMPORT_ROW_LIST_CAP }, (_, i) => `row ${i}`);
      expect(capLeadRowList('importedIdentifiers', rows)).toEqual({ importedIdentifiers: rows });
    });

    it('says so when it truncates, rather than reading as the whole list', () => {
      const rows = Array.from({ length: LEAD_IMPORT_ROW_LIST_CAP + 5 }, (_, i) => `row ${i}`);
      expect(capLeadRowList('unimportedRows', rows)).toEqual({
        unimportedRows: rows.slice(0, LEAD_IMPORT_ROW_LIST_CAP),
        unimportedRowsTruncated: { shown: LEAD_IMPORT_ROW_LIST_CAP, total: LEAD_IMPORT_ROW_LIST_CAP + 5 },
      });
    });
  });

  it('budgets the writes well inside the agent-mode whole-turn cap', () => {
    expect(LEAD_IMPORT_WRITE_BUDGET_MS).toBeLessThan(600_000);
  });
});
