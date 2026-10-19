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

  it('reports the REAL row count, not zero, after minimization', () => {
    // Found in production, not here. The first version of this test asserted only
    // "no undefined/NaN", so `0` sailed through — and prod produced exactly that:
    //
    //   "search_leads returned 0 row(s) and more remain unread"
    //
    // ...on a call that returned 20. `leads` is stripped by the minimizer, so the
    // count has to survive alongside the cursor or it cannot be stated truthfully.
    // Saying 0 is worse than saying nothing: it reads as "this found nothing",
    // which is the opposite of what happened.
    const toolCalls = [ledgerEntry('search_leads', { list_id: 'l1' }, searchLeadsPage)];

    // Prove WHICH path produced the number (CodeRabbit, #2520). Asserting only the
    // notice cannot tell `rowCount` from the array fallback: if the minimizer ever
    // stopped stripping `leads`, `rowsFrom` would count the array, still print
    // "20 row(s)", and this test would pass while the fix under test did nothing.
    // Pin the minimized payload itself.
    expect(toolCalls[0].result.rowCount).toBe(20);
    expect(toolCalls[0].result.leads).toBeUndefined();

    const out = reconcileUnconsumedCursors('Summarised.', toolCalls);
    expect(out).not.toMatch(/undefined|NaN/);
    expect(out).not.toMatch(/returned 0 row/);
    expect(out).toContain('20 row(s)');
  });
});

// ENG-2338: luma_get_guests / luma_list_events return their rows under `guests` / `events`. The row-key list
// lives in unconsumedCursor.ts but the minimizer kept its own copy, so the notice said "0 row(s)" for a page
// that had 35 — found in the branch preview, and "fixed" once in the wrong list.
describe('Luma tools through the REAL minimizer', () => {
  const lumaPage = (key: 'guests' | 'events', n: number) => ({
    success: true,
    count: n,
    has_more: true,
    next_cursor: 'c2',
    [key]: Array.from({ length: n }, (_, i) => ({ id: `r-${i}` })),
  });

  it.each([
    ['luma_get_guests', 'guests', 35],
    ['luma_list_events', 'events', 12],
  ] as const)('%s keeps its row count (not 0) when a cursor is left unread', (name, key, n) => {
    const out = reconcileUnconsumedCursors('Here are the guests.', [ledgerEntry(name, {}, lumaPage(key, n))]);
    expect(out).toContain(name);
    expect(out).toContain(`${n} row(s)`);
    expect(out).not.toContain('0 row(s)');
  });
});

describe('the ledger can tell "no key" from "pulled zero guests" (ENG-2338)', () => {
  it('keeps connected/reason/count, drops the rows', () => {
    const noKey = minimize({ success: true, connected: false, nothing_pulled: true, reason: 'no_key', message: 'long text' }, 'luma_get_guests');
    expect(noKey).toEqual({ success: true, connected: false, nothing_pulled: true, reason: 'no_key' });
    const empty = minimize({ success: true, count: 0, has_more: false, guests: [] }, 'luma_get_guests');
    expect(empty).toEqual({ success: true, count: 0, has_more: false, rowCount: 0 });
    expect(empty).not.toEqual(noKey);
    expect(JSON.stringify(minimize({ success: true, count: 2, guests: [{ email: 'a@b.c' }, { email: 'd@e.f' }] }, 'luma_get_guests'))).not.toContain('a@b.c');
  });
});
