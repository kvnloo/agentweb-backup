/**
 * ENG-1207 AC3 — a run must not finish silently on an unread page.
 *
 * The message fix (AC1/AC2) makes truncation *visible*. It does not make it
 * *noticed*: `has_more: true` and `next_cursor` were ALREADY in the response
 * during the incident, and the model issued the identical unpaged query six
 * times, concluded 20 of 107 leads had answers, wrote 17 records and reported
 * the job complete. Wording alone has one data point, and it lost.
 *
 * So AC3 is deterministic and needs no judge: a tool handed back a cursor, and
 * nothing ever passed it back. That is a fact about the run's ledger, not a
 * judgement about the reply's prose.
 *
 * WHY NOT `finalizeGuard`, which is the established seam for claimed-vs-executed
 * checks: it is gated behind AGENT_FINALIZE_GUARD *and* AGENT_RUNTIME_SPINE_ENABLED,
 * both off in production. Building AC3 there would ship something inert — which is
 * uncomfortably close to the defect being fixed. This is written as a PURE function
 * over the ledger precisely so `finalizeGuard` can absorb it unchanged once those
 * flags flip, rather than leaving two seams forever.
 */

import {
  findUnconsumedCursors,
  unconsumedCursorNotice,
  reconcileUnconsumedCursors,
} from '../services/agentMode/core/unconsumedCursor';

const call = (name: string, args: any, result: any, status = 'success') => ({
  status,
  toolCall: { function: { name } },
  functionArgs: args,
  result,
});

describe('findUnconsumedCursors', () => {
  it('reports a cursor that was handed back and never used', () => {
    const ledger = [
      call('search_leads', { list_id: 'l1' }, {
        success: true, leads: new Array(20), has_more: true, next_cursor: 'CUR-1',
      }),
    ];
    const out = findUnconsumedCursors(ledger);
    expect(out).toHaveLength(1);
    expect(out[0].tool).toBe('search_leads');
    expect(out[0].cursor).toBe('CUR-1');
    expect(out[0].returned).toBe(20);
  });

  it('reports nothing once the cursor is passed back', () => {
    const ledger = [
      call('search_leads', { list_id: 'l1' }, { next_cursor: 'CUR-1', leads: new Array(20) }),
      call('search_leads', { list_id: 'l1', cursor: 'CUR-1' }, { leads: new Array(7) }),
    ];
    expect(findUnconsumedCursors(ledger)).toHaveLength(0);
  });

  it('is indifferent to how the cursor argument is spelled', () => {
    // Tools spell it `cursor`, `next_cursor`, `start_cursor`. Nothing here reads
    // the argument at all: a consumed cursor produces a further call for the same
    // tool, and THAT call's result closes or advances the chain. So a tool
    // adopting a fourth spelling cannot break the check, which is a stronger
    // guarantee than matching a list of key names would have given.
    const ledger = [
      call('get_leads', { list_id: 'l1' }, { next_cursor: 'CUR-9', leads: new Array(20) }),
      call('get_leads', { list_id: 'l1', start_cursor: 'CUR-9' }, { leads: new Array(3) }),
    ];
    expect(findUnconsumedCursors(ledger)).toHaveLength(0);
  });

  it('follows a chain and reports only the last unread page', () => {
    // Paging three deep and stopping is ONE unread remainder, not three. Listing
    // every cursor ever issued would bury the actionable one.
    const ledger = [
      call('search_leads', { list_id: 'l1' }, { next_cursor: 'C1', leads: new Array(20) }),
      call('search_leads', { list_id: 'l1', cursor: 'C1' }, { next_cursor: 'C2', leads: new Array(20) }),
      call('search_leads', { list_id: 'l1', cursor: 'C2' }, { next_cursor: 'C3', leads: new Array(20) }),
    ];
    const out = findUnconsumedCursors(ledger);
    expect(out).toHaveLength(1);
    expect(out[0].cursor).toBe('C3');
    expect(out[0].returned).toBe(60); // the whole chain's rows, not just the last page
  });

  it('an INDEPENDENT later call to the same tool does not close an unread chain', () => {
    // The case that proves cursor-VALUE tracking is load-bearing (CodeRabbit,
    // #2493). Page 1 of list A leaves C1 unread; the model then runs a fresh,
    // unrelated query against list B which happens to use the same tool and
    // returns everything. Closing the chain on "same tool, no cursor" silently
    // marks list A complete when its page 2 was never fetched.
    const ledger = [
      call('search_leads', { list_id: 'A' }, { leads: new Array(20), next_cursor: 'C1' }),
      call('search_leads', { list_id: 'B' }, { leads: new Array(3) }),
    ];
    const out = findUnconsumedCursors(ledger);
    expect(out).toHaveLength(1);
    expect(out[0].cursor).toBe('C1');
  });

  it('two INDEPENDENT unread chains on one tool are both reported, with their own row counts', () => {
    // Per-TOOL state was wrong (CodeRabbit, #2493). Two unrelated searches each
    // leave a page unread; collapsing them to one entry drops a real remainder,
    // and summing their rows invents a chain length that never existed — a 23-row
    // chain when the chains are 20 and 3.
    const ledger = [
      call('search_leads', { list_id: 'A' }, { leads: new Array(20), next_cursor: 'C1' }),
      call('search_leads', { list_id: 'B' }, { leads: new Array(3), next_cursor: 'C2' }),
    ];
    const out = findUnconsumedCursors(ledger).sort((a, b) => a.cursor.localeCompare(b.cursor));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ cursor: 'C1', returned: 20 });
    expect(out[1]).toMatchObject({ cursor: 'C2', returned: 3 });
  });

  it('a continued chain still counts its whole length, and reports once', () => {
    // The other side of the same rule: pages that genuinely belong to one chain do
    // accumulate, and only the deepest cursor is outstanding.
    const ledger = [
      call('search_leads', { list_id: 'A' }, { leads: new Array(20), next_cursor: 'C1' }),
      call('search_leads', { list_id: 'A', cursor: 'C1' }, { leads: new Array(20), next_cursor: 'C2' }),
    ];
    const out = findUnconsumedCursors(ledger);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cursor: 'C2', returned: 40 });
  });

  it('a DIFFERENT tool passing the same value has not consumed the cursor', () => {
    // Cursor strings are opaque and could collide across tools; consumption means
    // "this tool fetched its own next page", not "that string appeared somewhere".
    const ledger = [
      call('search_leads', { list_id: 'A' }, { leads: new Array(20), next_cursor: 'C1' }),
      call('get_leads', { list_id: 'A', cursor: 'C1' }, { leads: new Array(5) }),
    ];
    expect(findUnconsumedCursors(ledger)).toHaveLength(1);
  });

  it('a CANCELLED later call has not consumed the cursor either', () => {
    // The emit side only accepts `success`; the consume side must agree, or a
    // deferred or cancelled entry silently closes a page that was never read.
    const ledger = [
      call('search_leads', { list_id: 'A' }, { leads: new Array(20), next_cursor: 'C1' }),
      call('search_leads', { list_id: 'A', cursor: 'C1' }, {}, 'deferred'),
    ];
    expect(findUnconsumedCursors(ledger)).toHaveLength(1);
  });

  it('a later call that FAILED while carrying the cursor has not consumed it', () => {
    // Attempting to read page 2 is not reading it. If the retry errored, the page
    // is still unread and the notice must still fire — otherwise a transient
    // failure silently converts an incomplete run into a complete-looking one,
    // which is this ticket's entire failure mode.
    const ledger = [
      call('search_leads', { list_id: 'A' }, { leads: new Array(20), next_cursor: 'C1' }),
      call('search_leads', { list_id: 'A', cursor: 'C1' }, { error: 'timeout' }, 'error'),
    ];
    const out = findUnconsumedCursors(ledger);
    expect(out).toHaveLength(1);
    expect(out[0].cursor).toBe('C1');
  });

  it('INVALID INPUT: an entry with no tool name is skipped, not reported as "a tool"', () => {
    // A notice naming "a tool" cannot be acted on — the user has nothing to resume
    // (CodeRabbit, #2493). An unnameable entry is malformed input, and the file's
    // contract for malformed input is to ignore it.
    const ledger = [
      { status: 'success', result: { next_cursor: 'C1', leads: new Array(20) } } as any,
    ];
    expect(findUnconsumedCursors(ledger)).toHaveLength(0);
  });

  it('ERROR PATH: a failed call carrying a cursor is not an unread page', () => {
    // Nothing was read, so nothing is unread. Warning here would tell the user to
    // resume a query that never ran, which is a different and worse claim.
    const ledger = [
      call('search_leads', { list_id: 'l1' }, { next_cursor: 'CUR-1' }, 'error'),
    ];
    expect(findUnconsumedCursors(ledger)).toHaveLength(0);
  });

  it('BOUNDARY: a cursor issued by the LAST call for a tool is outstanding', () => {
    // The tool's final result is what decides. Here an earlier call happens to
    // carry the same value in its arguments, which is a coincidence and must not
    // read as consumption — the last call still handed back a page nobody took.
    const ledger = [
      call('search_leads', { list_id: 'l1', cursor: 'CUR-1' }, { leads: new Array(5) }),
      call('search_leads', { list_id: 'l1' }, { next_cursor: 'CUR-1', leads: new Array(20) }),
    ];
    expect(findUnconsumedCursors(ledger)).toHaveLength(1);
  });

  it('INVALID INPUT: malformed results and cursors are ignored, not crashed on', () => {
    const ledger = [
      call('a', {}, null),
      call('b', {}, undefined),
      call('c', {}, 'a string, not an object'),
      call('d', {}, { next_cursor: '' }),
      call('e', {}, { next_cursor: null }),
      call('f', {}, { next_cursor: 42 }),
      { status: 'success' } as any,           // no toolCall, no result at all
      call('g', null, { next_cursor: 'REAL' }),
    ];
    const out = findUnconsumedCursors(ledger);
    expect(out).toHaveLength(1);
    expect(out[0].cursor).toBe('REAL');
  });

  it('reports each distinct tool separately', () => {
    const ledger = [
      call('search_leads', {}, { next_cursor: 'A', leads: new Array(20) }),
      call('get_lead_engagements', {}, { next_cursor: 'B', engagements: new Array(20) }),
    ];
    expect(findUnconsumedCursors(ledger).map((u) => u.tool).sort())
      .toEqual(['get_lead_engagements', 'search_leads']);
  });
});

describe('unconsumedCursorNotice', () => {
  it('says which portion is unprocessed, and names the resume path', () => {
    const notice = unconsumedCursorNotice([
      { tool: 'search_leads', cursor: 'CUR-1', returned: 20 },
    ]);
    expect(notice).toContain('search_leads');
    expect(notice).toContain('20');
    // AC3's own words: state plainly which portion is unprocessed.
    expect(notice).toMatch(/not.*complete|more results|remain/i);
    expect(notice).toMatch(/next_cursor|cursor/i);
  });

  it('returns null when there is nothing outstanding', () => {
    // The guard must be silent on a complete run. A permanent caveat is noise, and
    // noise is what taught the model to ignore has_more in the first place.
    expect(unconsumedCursorNotice([])).toBeNull();
  });

  it('never invents a total it does not have', () => {
    // We know how many rows were read. We do NOT know how many remain — the whole
    // point is that nobody looked. Saying "20 of 143" here would be the AC1 defect
    // wearing a different hat.
    const notice = unconsumedCursorNotice([
      { tool: 'search_leads', cursor: 'CUR-1', returned: 20 },
    ])!;
    expect(notice).not.toMatch(/\bof \d+\b/);
    expect(notice).not.toMatch(/undefined|NaN/);
  });
});

/**
 * The adapter, tested because it is the glue that can silently mis-wire the whole
 * check. The loop's ledger entries are `{ name, arguments, result, error }` — a
 * different shape from `CursorLedgerEntry` — and mapping them at the call site
 * would have left the one piece able to quietly break as the only untested part.
 */
describe('reconcileUnconsumedCursors — the seam adapter', () => {
  /** A ledger entry in the LOOP's shape, not the detector's. */
  const loopCall = (name: string, args: any, result: any, extra: any = {}) =>
    ({ id: `t-${name}`, name, arguments: args, result, duration: 1, ...extra });

  it('appends the notice for an unread page, leaving the original text intact', () => {
    const out = reconcileUnconsumedCursors('All 20 leads updated.', [
      loopCall('search_leads', { list_id: 'l1' }, { leads: new Array(20), next_cursor: 'C1' }),
    ]);
    expect(out).toContain('All 20 leads updated.');
    expect(out).toContain('search_leads');
    expect(out).toMatch(/did not cover all the data/i);
  });

  it('returns the content UNCHANGED when nothing is outstanding', () => {
    const content = 'All 3 leads updated.';
    expect(reconcileUnconsumedCursors(content, [
      loopCall('search_leads', { list_id: 'l1' }, { leads: new Array(3) }),
    ])).toBe(content);
  });

  it('a completed paging chain through the adapter produces no notice', () => {
    // Deliberately NOT a claim about argument field names. An earlier draft matched
    // later call arguments to detect consumption, and this test was written to pin
    // that mapping — but mutating the adapter to read the wrong key failed nothing,
    // because the chain's own final result already decides the outcome. The
    // matching was removed as dead; this now pins the behaviour that actually
    // holds, which is that a chain ending in a cursor-free page is complete.
    const out = reconcileUnconsumedCursors('done', [
      loopCall('search_leads', {}, { leads: new Array(20), next_cursor: 'C1' }),
      loopCall('search_leads', { cursor: 'C1' }, { leads: new Array(4) }),
    ]);
    expect(out).toBe('done');
  });

  it('an errored loop entry is not an unread page', () => {
    expect(reconcileUnconsumedCursors('done', [
      loopCall('search_leads', {}, { next_cursor: 'C1' }, { error: 'boom' }),
    ])).toBe('done');
  });

  it('honours the injected neverExecuted predicate', () => {
    // A suppressed duplicate or budget-deferred call never ran, so it cannot have
    // left a page unread. The predicate is injected so this module stays pure and
    // agrees with the finalize ledger by construction.
    const entry = loopCall('search_leads', {}, { leads: new Array(20), next_cursor: 'C1' }, { duplicateOf: 'x' });
    expect(reconcileUnconsumedCursors('done', [entry], (tc) => !!tc.duplicateOf)).toBe('done');
    // ...and without the predicate it WOULD warn, so the test proves the predicate
    // is what made the difference rather than something else.
    expect(reconcileUnconsumedCursors('done', [entry])).not.toBe('done');
  });

  it('INVALID INPUT: empty content, empty ledger, and junk entries are all no-ops', () => {
    expect(reconcileUnconsumedCursors('', [])).toBe('');
    expect(reconcileUnconsumedCursors('x', [])).toBe('x');
    expect(reconcileUnconsumedCursors('x', null as any)).toBe('x');
    expect(reconcileUnconsumedCursors('x', [null, undefined, 42] as any)).toBe('x');
  });
});
