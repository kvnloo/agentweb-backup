/**
 * ENG-1207 AC3 — the reconciler must survive the ledger MINIMIZER.
 *
 * Found by live verification on the chat-14 preview, not by any unit test.
 *
 * `unconsumedCursor.test.ts` builds ledger entries by hand with full tool results,
 * so it proves the detection logic and nothing about the data the detection
 * actually receives. In the real loop the dispatcher writes
 * `extractMinimalToolResult(result, toolName)` into `toolCalls[].result`, and that
 * function's default branch returns `{}` — its own call site says so:
 *
 *     // FULL result here — extractMinimalToolResult below trims search results
 *     // to {} for storage
 *
 * `search_leads` has no special case, so by the time `reconcileUnconsumedCursors`
 * runs at the finalize seam every result is `{}`, `cursorFrom()` finds nothing, and
 * the notice never fires. Live: a 2,527-lead list returned `has_more: true` with a
 * cursor, the model made one call and stopped, and no notice appeared.
 *
 * The feature was inert in production while its unit tests passed — the exact
 * failure this file's own header criticises `finalizeGuard` for.
 *
 * These tests therefore compose the REAL minimizer with the reconciler, so the two
 * cannot drift apart again.
 */

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
  searchPlatformKnowledgeBase: jest.fn(),
}));
jest.mock('../services/skillService', () => ({ skillService: {} }));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn((t: any) => t),
}));
jest.mock('../mcp/client/mcpClientService', () => ({ McpClientService: jest.fn() }));

import { AgentModeService } from '../services/agentModeService';
import { reconcileUnconsumedCursors } from '../services/agentMode/core/unconsumedCursor';

const service = new AgentModeService();
/** The real minimizer the dispatcher uses — not a stand-in. */
const minimize = (result: any, toolName: string) =>
  (service as any).extractMinimalToolResult(result, toolName);

/** A realistic first page: 20 rows, more available, cursor handed back. */
const searchLeadsPage = {
  success: true,
  message: 'Showing the first 20 matching lead(s); more remain — pass next_cursor to continue.',
  leads: Array.from({ length: 20 }, (_, i) => ({ leadId: `l-${i}`, email: `u${i}@x.com` })),
  has_more: true,
  next_cursor: 'eyJsaXN0SWQiOiJsMSIsImxlYWRJZCI6ImwtMjAifQ==',
};

/** A ledger entry exactly as the dispatcher builds it: minimized result. */
const ledgerEntry = (name: string, args: any, result: any) => ({
  id: `t-${name}`,
  name,
  arguments: args,
  result: minimize(result, name),
  duration: 1,
});

describe('the minimizer must not strip what the reconciler reads', () => {
  it('search_leads keeps its pagination markers through minimization', () => {
    const minimal = minimize(searchLeadsPage, 'search_leads');
    expect(minimal.next_cursor).toBe(searchLeadsPage.next_cursor);
    expect(minimal.has_more).toBe(true);
  });

  it('the heavy payload is still dropped — this is not a licence to store everything', () => {
    // The minimizer exists to bound stored size. Preserving a cursor and a boolean
    // is proportionate; preserving the rows would defeat its purpose.
    const minimal = minimize(searchLeadsPage, 'search_leads');
    expect(minimal.leads).toBeUndefined();
    expect(JSON.stringify(minimal).length).toBeLessThan(300);
  });

  it('a tool with no pagination still minimizes to nothing', () => {
    const minimal = minimize({ success: true, blob: 'x'.repeat(5000) }, 'some_other_tool');
    expect(minimal).toEqual({});
  });
});

describe('reconciler over a MINIMIZED ledger — the live failure', () => {
  it('fires the notice for an unread page (this returned nothing before the fix)', () => {
    const toolCalls = [ledgerEntry('search_leads', { list_id: 'l1' }, searchLeadsPage)];

    const out = reconcileUnconsumedCursors('Summarised the leads.', toolCalls);

    expect(out).not.toBe('Summarised the leads.');
    expect(out).toContain('search_leads');
    expect(out).toMatch(/did not cover all the data/i);
    // The model's own text survives above the note.
    expect(out).toContain('Summarised the leads.');
  });

  it('stays silent when the chain was completed, through the minimizer', () => {
    // The negative case matters more: a false positive tells every user their
    // complete answer was incomplete.
    const toolCalls = [
      ledgerEntry('search_leads', { list_id: 'l1' }, searchLeadsPage),
      ledgerEntry(
        'search_leads',
        { list_id: 'l1', cursor: searchLeadsPage.next_cursor },
        { success: true, leads: [{ leadId: 'l-21' }], has_more: false },
      ),
    ];

    expect(reconcileUnconsumedCursors('Done.', toolCalls)).toBe('Done.');
  });

  it('counts rows the minimizer removed without inventing them', () => {
    // `leads` is gone after minimization, so the row count cannot come from there.
    // Reporting a fabricated number would be worse than reporting none.
    const toolCalls = [ledgerEntry('search_leads', { list_id: 'l1' }, searchLeadsPage)];
    const out = reconcileUnconsumedCursors('Summarised.', toolCalls);
    expect(out).not.toMatch(/undefined|NaN/);
  });
});
