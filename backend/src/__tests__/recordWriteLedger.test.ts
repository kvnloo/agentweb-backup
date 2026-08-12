// ENG-1054 (reopened): the CRM-import half of the ledger-synthesis family.
//
// Two production sessions, one mechanism. Both ran a long `add_leads_to_list`
// batch import, both hit the platform generation timeout, and in both the
// terminal message the user actually read contradicted what the run had done:
//
//   - "Import Sheet Prospects…": five successful add_leads_to_list calls, and the
//     closing automated message said the process could not be completed. The
//     ENG-971 append-only guard stayed silent because its confirmed-work set
//     covers publish/deploy/send only — a CRM record write is not in it.
//   - "Import Lead List to CRM": three successful batches of 25 (75 leads), and
//     the closing message said it had "successfully added the 3 leads". Three is
//     the number of CALLS. The diagnosis agent is handed the session's
//     `calledFunctions` histogram as "Succeeded operations" with no statement of
//     what the numbers count, so it published a call count as a record count.
//
// Re-running either import creates duplicate leads, so both directions of the
// error are harmful: erasing a confirmed write, and misstating its size.
//
// These tests pin the record-write ledger. Like the ENG-971 guard it only ever
// APPENDS, so it can never invent an outcome the ledger does not hold.

import {
  reconcileFalseFailureReport,
  appendConfirmedPublishNotice,
  collectConfirmedPublishActions,
  collectConfirmedRecordWrites,
  reconcileRecordCountReport,
  CONFIRMED_RECORD_WRITE_TOOLS,
} from '../utils/falseFailureReport';

/** The timeout message the controller's error path persisted for 98b90503. */
const TIMEOUT_TEXT =
  'The process could not be completed because the session timed out. Please try your request again.';

describe('ENG-1054 record-write ledger', () => {
  describe('collectConfirmedRecordWrites', () => {
    it('sums the records actually written across every batch call', () => {
      // Three batches of 25 — the "Import Lead List to CRM" shape.
      const writes = collectConfirmedRecordWrites([
        { name: 'create_lead_list', result: { success: true } },
        { name: 'add_leads_to_list', result: { successCount: 25, newCount: 25, mergedCount: 0, errorCount: 0 } },
        { name: 'add_leads_to_list', result: { successCount: 25, newCount: 24, mergedCount: 1, errorCount: 0 } },
        { name: 'add_leads_to_list', result: { successCount: 25, newCount: 25, mergedCount: 0, errorCount: 0 } },
      ]);
      expect(writes.leadsWritten).toBe(75);
      expect(writes.calls).toBe(3);
      expect(writes.listCreated).toBe(true);
      // The label must state records, and must never surface the call count as one.
      expect(writes.actions.join(' ')).toContain('75 leads');
      expect(writes.actions.join(' ')).not.toMatch(/\b3 leads\b/);
    });

    it('ignores a failed batch and a duplicate-suppressed call', () => {
      const writes = collectConfirmedRecordWrites([
        { name: 'add_leads_to_list', result: { successCount: 25 } },
        { name: 'add_leads_to_list', error: 'DynamoDB throttled' },
        // toolDispatch pushes a collapsed duplicate with no result and no error.
        { name: 'add_leads_to_list', duplicateOf: 'call_1' },
      ]);
      expect(writes.leadsWritten).toBe(25);
      expect(writes.calls).toBe(1);
    });

    it('counts a batch that wrote nothing as no records written', () => {
      const writes = collectConfirmedRecordWrites([
        { name: 'add_leads_to_list', result: { successCount: 0, errorCount: 25 } },
      ]);
      expect(writes.leadsWritten).toBe(0);
      expect(writes.actions).toEqual([]);
    });

    it('degrades to an unnumbered action when the ledger carries no counts', () => {
      // The throw path: ledgerFromSucceededFunctions yields name-only entries.
      const writes = collectConfirmedRecordWrites([
        { name: 'add_leads_to_list' },
        { name: 'create_lead_list' },
      ]);
      expect(writes.leadsWritten).toBe(0);
      expect(writes.calls).toBe(1);
      expect(writes.actions.join(' ')).toMatch(/added leads to your CRM list/i);
      // With no count known it must not state a number at all.
      expect(writes.actions.join(' ')).not.toMatch(/\d/);
    });

    it('ignores read-only CRM tools and unrelated tools', () => {
      const writes = collectConfirmedRecordWrites([
        { name: 'get_lead_lists', result: { totalLists: 4 } },
        { name: 'search_leads', result: {} },
        { name: 'read_tool_response', result: {} },
      ]);
      expect(writes.actions).toEqual([]);
    });

    it('returns an empty result for missing or malformed input', () => {
      expect(collectConfirmedRecordWrites(null).actions).toEqual([]);
      expect(collectConfirmedRecordWrites(undefined).actions).toEqual([]);
      expect(collectConfirmedRecordWrites('nope' as any).actions).toEqual([]);
    });
  });

  // The record-write set must stay OUT of collectConfirmedPublishActions: that
  // function also decides whether an abandoned scheduled run may be requeued
  // (agentModeController zero-output path). Treating a lead import as a publish
  // there would silently disable a schedule's auto-recovery.
  describe('separation from the scheduled-retry gate', () => {
    it('does not report a CRM record write as a confirmed publish', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'add_leads_to_list', result: { successCount: 75 } },
          { name: 'create_lead_list', result: { success: true } },
        ]),
      ).toEqual([]);
    });

    it('keeps the two sets disjoint', () => {
      for (const name of CONFIRMED_RECORD_WRITE_TOOLS) {
        expect(collectConfirmedPublishActions([{ name, result: {} }])).toEqual([]);
      }
    });
  });

  describe('appendConfirmedPublishNotice with record writes', () => {
    it('names a confirmed lead import on the timeout fallback text', () => {
      const out = appendConfirmedPublishNotice(TIMEOUT_TEXT, [
        { name: 'create_lead_list', result: { success: true } },
        { name: 'add_leads_to_list', result: { successCount: 25 } },
        { name: 'add_leads_to_list', result: { successCount: 25 } },
      ]);
      expect(out.startsWith(TIMEOUT_TEXT)).toBe(true);
      expect(out).toContain('50 leads');
      expect(out).toMatch(/do NOT re-run/i);
    });

    it('stays silent when the run wrote no records', () => {
      expect(
        appendConfirmedPublishNotice(TIMEOUT_TEXT, [{ name: 'get_lead_lists', result: {} }]),
      ).toBe(TIMEOUT_TEXT);
    });

    it('is idempotent', () => {
      const ledger = [{ name: 'add_leads_to_list', result: { successCount: 75 } }];
      const once = appendConfirmedPublishNotice(TIMEOUT_TEXT, ledger);
      expect(appendConfirmedPublishNotice(once, ledger)).toBe(once);
    });
  });

  describe('reconcileFalseFailureReport with record writes', () => {
    it('corrects a timeout-and-lost-work claim made after a confirmed import', () => {
      const text =
        'The session timed out partway through, so your leads were not saved. Please try again.';
      const out = reconcileFalseFailureReport(text, [
        { name: 'add_leads_to_list', result: { successCount: 75 } },
      ]);
      expect(out.startsWith(text)).toBe(true);
      expect(out).toContain('75 leads');
      expect(out).toMatch(/do NOT re-run/i);
    });

    it('leaves a truthful closing message untouched', () => {
      const text = 'Imported 75 of 97 leads before running out of time; 22 rows remain.';
      expect(
        reconcileFalseFailureReport(text, [{ name: 'add_leads_to_list', result: { successCount: 75 } }]),
      ).toBe(text);
    });
  });

  // The wrong-count half. The ledger holds real record counts, so a contradicting
  // number in the closing prose IS programmatically detectable.
  describe('reconcileRecordCountReport', () => {
    const LEDGER_75 = [
      { name: 'add_leads_to_list', result: { successCount: 25 } },
      { name: 'add_leads_to_list', result: { successCount: 25 } },
      { name: 'add_leads_to_list', result: { successCount: 25 } },
    ];

    it('corrects the batch count reported as a lead count', () => {
      const text =
        'I have successfully added the 3 leads to your CRM list. Please retry the request to finish.';
      const out = reconcileRecordCountReport(text, LEDGER_75);
      expect(out).not.toBe(text);
      expect(out.startsWith(text)).toBe(true);
      expect(out).toContain('75');
      expect(out).toMatch(/run log/i);
    });

    it('stays silent when the stated count is right', () => {
      const text = 'I added 75 leads to your CRM list.';
      expect(reconcileRecordCountReport(text, LEDGER_75)).toBe(text);
    });

    it('stays silent when the true total appears anywhere in the claim', () => {
      // "75 of 97" — the noun-adjacent number is 97, but 75 is stated and true.
      const text = 'I imported 75 of 97 leads before the run ended.';
      expect(reconcileRecordCountReport(text, LEDGER_75)).toBe(text);
    });

    it('does not fire on a count that is not about records written', () => {
      const text = 'Your CSV contained 97 rows and your list now holds 320 leads in total.';
      expect(reconcileRecordCountReport(text, LEDGER_75)).toBe(text);
    });

    it('stays silent when the ledger has no confirmed record count', () => {
      const text = 'I have successfully added the 3 leads to your CRM list.';
      expect(reconcileRecordCountReport(text, [{ name: 'add_leads_to_list' }])).toBe(text);
      expect(reconcileRecordCountReport(text, [])).toBe(text);
    });

    it('leaves empty or non-string content untouched', () => {
      expect(reconcileRecordCountReport('', LEDGER_75)).toBe('');
      expect(reconcileRecordCountReport(undefined as any, LEDGER_75)).toBe(undefined);
    });

    it('is idempotent', () => {
      const text = 'I successfully added the 3 leads to your CRM list.';
      const once = reconcileRecordCountReport(text, LEDGER_75);
      expect(reconcileRecordCountReport(once, LEDGER_75)).toBe(once);
    });
  });
});
