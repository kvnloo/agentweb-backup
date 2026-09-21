import {
  LEAD_IMPORT_RESUME_BYTE_BUDGET,
  LEAD_IMPORT_ROW_LIST_CAP,
  LEAD_IMPORT_LEDGER_RESERVE_MS,
  LEAD_IMPORT_WRITE_BUDGET_MS,
  buildLeadImportRowOutcomes,
  leadImportWriteBudgetMs,
  capLeadResumeRows,
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

  describe('capLeadResumeRows', () => {
    const entry = (row: number) => ({ row, identifier: `row${row}@example.com`, reason: 'unprocessed' });

    it('keeps a resume list that fits, however many rows that is', () => {
      // A 200-row shortfall is the case the old flat 100-row cap truncated for
      // no reason: it is a few KB, and truncating it is what stranded rows.
      const rows = Array.from({ length: 200 }, (_, i) => entry(i + 1));
      expect(capLeadResumeRows('unimportedRows', rows)).toEqual({ unimportedRows: rows });
    });

    it('trims only what will not fit, and says how much it left out', () => {
      const rows = Array.from({ length: 400 }, (_, i) => ({
        row: i + 1,
        identifier: `row${i}.${'x'.repeat(120)}@example.com`,
        reason: 'unprocessed',
      }));
      const result = capLeadResumeRows('unimportedRows', rows);
      expect(result.unimportedRows.length).toBeLessThan(400);
      expect(result.unimportedRowsTruncated).toEqual({
        shown: result.unimportedRows.length,
        total: 400,
      });
      expect(JSON.stringify(result.unimportedRows).length).toBeLessThanOrEqual(
        LEAD_IMPORT_RESUME_BYTE_BUDGET,
      );
    });

    it('always names at least one row, even one that alone busts the budget', () => {
      const huge = { row: 1, identifier: 'x'.repeat(LEAD_IMPORT_RESUME_BYTE_BUDGET * 2), reason: 'failed' };
      const result = capLeadResumeRows('unimportedRows', [huge, entry(2)]);
      expect(result.unimportedRows).toEqual([huge]);
      expect(result.unimportedRowsTruncated).toEqual({ shown: 1, total: 2 });
    });

    it('has nothing to trim when there is nothing missing', () => {
      expect(capLeadResumeRows('unimportedRows', [])).toEqual({ unimportedRows: [] });
    });
  });

  it('budgets the writes well inside the agent-mode whole-turn cap', () => {
    expect(LEAD_IMPORT_WRITE_BUDGET_MS).toBeLessThan(600_000);
  });

  describe('leadImportWriteBudgetMs', () => {
    it('spends the full budget when the run has no deadline', () => {
      expect(leadImportWriteBudgetMs(1_000)).toBe(LEAD_IMPORT_WRITE_BUDGET_MS);
      expect(leadImportWriteBudgetMs(1_000, undefined)).toBe(LEAD_IMPORT_WRITE_BUDGET_MS);
      expect(leadImportWriteBudgetMs(1_000, NaN)).toBe(LEAD_IMPORT_WRITE_BUDGET_MS);
    });

    it('spends the full budget when the run has more time than it needs', () => {
      const now = 1_000;
      const deadline = now + LEAD_IMPORT_WRITE_BUDGET_MS + LEAD_IMPORT_LEDGER_RESERVE_MS + 1;
      expect(leadImportWriteBudgetMs(now, deadline)).toBe(LEAD_IMPORT_WRITE_BUDGET_MS);
    });

    it('clamps to the run budget, keeping head-room to return the ledger', () => {
      // Starting a full-length write budget with 30s of turn left is what kills
      // the turn before it can report which rows landed.
      const now = 1_000;
      expect(leadImportWriteBudgetMs(now, now + 30_000)).toBe(30_000 - LEAD_IMPORT_LEDGER_RESERVE_MS);
    });

    it('never returns a non-positive budget, which would read as unbounded', () => {
      const now = 1_000;
      expect(leadImportWriteBudgetMs(now, now + LEAD_IMPORT_LEDGER_RESERVE_MS)).toBe(1);
      expect(leadImportWriteBudgetMs(now, now - 60_000)).toBe(1);
    });
  });
});
