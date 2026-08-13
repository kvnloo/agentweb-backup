import {
  collectLeadImportTotals,
  describeLeadImportTotals,
} from '../utils/leadImportLedger';
import { stripUnfoundedEntityCounts } from '../utils/falseFailureReport';

/**
 * ENG-1174. ENG-1173 strips every entity count from diagnosis prose because that path
 * had nothing to check a number against. ENG-1133 then started recording the real
 * numbers and — deliberately, so the next turn can resume — keeps them on the persisted
 * tool message, where a thrown turn's diagnosis can still read them.
 *
 * Canonical definitions come from ENG-1133 and are reused rather than reinvented:
 *   landed  = reconciliation.created + merged + alreadyPresent
 *   missing = reconciliation.failed + unprocessed
 */

/** A persisted add_leads_to_list tool message, as ENG-1133 stores it. */
const toolMsg = (result: Record<string, any>, ts = '2026-08-11T13:47:05.310Z') => ({
  role: 'tool',
  name: 'add_leads_to_list',
  content: JSON.stringify(result),
  metadata: { timestamp: ts },
});

const batch = (created: number, opts: Partial<Record<string, any>> = {}) => ({
  success: true,
  complete: opts.complete ?? true,
  attempted: opts.attempted ?? created,
  reconciliation: {
    created,
    merged: opts.merged ?? 0,
    alreadyPresent: opts.alreadyPresent ?? 0,
    duplicateInRequest: 0,
    anonymizedSkipped: 0,
    failed: opts.failed ?? 0,
    unprocessed: opts.unprocessed ?? 0,
  },
  ...(opts.resumable ? { resumable: true } : {}),
});

describe('collectLeadImportTotals (ENG-1174)', () => {
  const SINCE = Date.parse('2026-08-11T13:41:00.000Z');

  it('sums landed and attempted across the three batches of session 39eb5663', () => {
    const messages = [
      toolMsg(batch(25), '2026-08-11T13:47:05.310Z'),
      toolMsg(batch(25), '2026-08-11T13:48:41.814Z'),
      toolMsg(batch(25), '2026-08-11T13:50:19.952Z'),
    ];

    expect(collectLeadImportTotals(messages, SINCE)).toEqual({
      landed: 75,
      attempted: 75,
      known: true,
    });
  });

  it('counts merged and already-present rows as landed, per ENG-1133', () => {
    const messages = [toolMsg(batch(48, { merged: 1, alreadyPresent: 1, attempted: 50 }))];

    expect(collectLeadImportTotals(messages, SINCE)).toMatchObject({ landed: 50, attempted: 50 });
  });

  it('does not count failed or unprocessed rows as landed', () => {
    const messages = [toolMsg(batch(20, { failed: 3, unprocessed: 2, attempted: 25 }))];

    expect(collectLeadImportTotals(messages, SINCE)).toMatchObject({ landed: 20, attempted: 25 });
  });

  it('ignores results from before this turn', () => {
    const messages = [
      toolMsg(batch(25), '2026-08-11T10:00:00.000Z'), // earlier turn
      toolMsg(batch(25), '2026-08-11T13:47:05.310Z'),
    ];

    expect(collectLeadImportTotals(messages, SINCE)).toMatchObject({ landed: 25, attempted: 25 });
  });

  /**
   * "Could not read it" and "nothing landed" must never collapse into the same
   * answer — reporting 0 written for an import that actually wrote rows is the
   * ENG-1173 defect all over again, just with a different wrong number.
   */
  it('reports UNKNOWN rather than zero when a result cannot be parsed', () => {
    const messages = [
      { role: 'tool', name: 'add_leads_to_list', content: '{not json', metadata: { timestamp: '2026-08-11T13:47:05.310Z' } },
      toolMsg(batch(25), '2026-08-11T13:48:41.814Z'),
    ];

    expect(collectLeadImportTotals(messages, SINCE).known).toBe(false);
  });

  it('reports UNKNOWN when a result predates the ENG-1133 contract', () => {
    const legacy = toolMsg({ success: true, successCount: 25, newCount: 25 } as any);

    expect(collectLeadImportTotals([legacy], SINCE).known).toBe(false);
  });

  it('returns UNKNOWN for no import messages at all', () => {
    expect(collectLeadImportTotals([], SINCE).known).toBe(false);
    expect(collectLeadImportTotals(undefined, SINCE).known).toBe(false);
    expect(collectLeadImportTotals([{ role: 'tool', name: 'get_lead_lists', content: '{}' }], SINCE).known)
      .toBe(false);
  });

  it('ignores a tool message carrying the error envelope', () => {
    const errored = {
      role: 'tool',
      name: 'add_leads_to_list',
      content: '⚠️ Tool Error: something broke',
      metadata: { timestamp: '2026-08-11T13:47:05.310Z' },
    };

    expect(collectLeadImportTotals([errored], SINCE).known).toBe(false);
  });
});

/**
 * ENG-1174 self-review. Both of these shipped-looking behaviours are the SAME class of
 * defect the whole line of work exists to remove: a confident, wrong number.
 */
/**
 * Greptile P1 on this PR. `attempted` and the shortfall are measured too, but the
 * guard can only test numeric membership — not what the sentence claims. Admitting
 * them lets "I added 97 leads" pass as a successful-write claim when 75 landed.
 */
describe('only the landed total is founded (ENG-1174)', () => {
  const founded = [75]; // landed, for a 75-of-97 partial

  it.each(['I added 97 leads.', 'I added 22 leads.'])(
    'rejects a measured figure that is not the landed count: %s',
    (text) => {
      expect(stripUnfoundedEntityCounts(text, founded)).toBe('I added the leads.');
    },
  );

  it('permits the landed count itself', () => {
    expect(stripUnfoundedEntityCounts('I added 75 leads.', founded)).toBe('I added 75 leads.');
  });

  it('leaves the N-of-M partial phrasing whole, so nothing useful is lost', () => {
    const partial = 'I added 75 of 97 leads before the run stopped.';
    expect(stripUnfoundedEntityCounts(partial, founded)).toBe(partial);
  });
});

describe('founded counts must not leak across entity types (ENG-1174)', () => {
  // Row totals for a LEAD import — never a count of emails, posts or campaigns.
  const founded = [75, 97, 22];

  it.each([
    ['I sent 75 emails before the run stopped.', /75\s+emails/],
    ['I published 22 posts.', /22\s+posts/],
    ['I created 97 campaigns.', /97\s+campaigns/],
  ])('does not let a row total authorise a different noun: %s', (text, forbidden) => {
    expect(stripUnfoundedEntityCounts(text, founded)).not.toMatch(forbidden);
  });

  it.each(['leads', 'rows', 'records', 'contacts', 'prospects'])(
    'still permits the founded figure on the noun it was measured for: %s',
    (noun) => {
      const text = `I added 75 ${noun} before the run stopped.`;
      expect(stripUnfoundedEntityCounts(text, founded)).toBe(text);
    },
  );
});

describe('a batch that cannot be attributed to this turn (ENG-1174)', () => {
  const SINCE = Date.parse('2026-08-11T13:41:00.000Z');

  it('degrades to UNKNOWN rather than silently under-reporting', () => {
    const stamped = toolMsg(batch(25), '2026-08-11T13:47:05.310Z');
    const unstamped = { role: 'tool', name: 'add_leads_to_list', content: JSON.stringify(batch(25)) };

    // Silently skipping the unstamped batch would report 50 of 75 as authoritative.
    expect(collectLeadImportTotals([stamped, unstamped as any, stamped], SINCE).known).toBe(false);
  });

  it('still ignores a batch that genuinely belongs to an earlier turn', () => {
    const earlier = toolMsg(batch(25), '2026-08-11T10:00:00.000Z');
    const thisTurn = toolMsg(batch(25), '2026-08-11T13:47:05.310Z');

    expect(collectLeadImportTotals([earlier, thisTurn], SINCE))
      .toEqual({ landed: 25, attempted: 25, known: true });
  });
});

describe('describeLeadImportTotals (ENG-1174)', () => {
  it('states landed of attempted when the import is short', () => {
    const line = describeLeadImportTotals({ landed: 75, attempted: 97, known: true });

    expect(line).toMatch(/75/);
    expect(line).toMatch(/97/);
    // Must read as ROWS, so it cannot be confused with the run-count ledger.
    expect(line).toMatch(/row/i);
  });

  it('says nothing at all when the totals are unknown', () => {
    expect(describeLeadImportTotals({ landed: 0, attempted: 0, known: false })).toBeNull();
  });
});

describe('stripUnfoundedEntityCounts with founded totals (ENG-1174)', () => {
  it('still strips a count that no total supports', () => {
    expect(stripUnfoundedEntityCounts('I added 3 leads.', [75, 97]))
      .toBe('I added the leads.');
  });

  it('lets a count that reconciles against the run stand', () => {
    const truthful = 'I added 75 leads before the run hit its limit.';
    expect(stripUnfoundedEntityCounts(truthful, [75, 97])).toBe(truthful);
  });

  it('permits every founded figure in one sentence', () => {
    const truthful = 'I wrote 75 leads of the 97 attempted.';
    expect(stripUnfoundedEntityCounts(truthful, [75, 97])).toBe(truthful);
  });

  it('behaves exactly as before when no totals are supplied', () => {
    expect(stripUnfoundedEntityCounts('I added 75 leads.')).toBe('I added the leads.');
    expect(stripUnfoundedEntityCounts('I added 75 leads.', [])).toBe('I added the leads.');
  });

  it('is not fooled by a number that merely appears in the ledger of CALL counts', () => {
    // 3 was the add_leads_to_list CALL count in session 39eb5663 — never a row count.
    expect(stripUnfoundedEntityCounts('I added 3 leads.', [75, 97]))
      .not.toMatch(/3 leads/);
  });
});

/**
 * End to end over the real production shape: session 39eb5663 wrote 75 rows across
 * three batches of 25 and told the user "the 3 leads". This is what the same run
 * should now be able to say.
 */
describe('39eb5663 replayed end to end (ENG-1174)', () => {
  const SINCE = Date.parse('2026-08-11T13:41:00.000Z');
  const messages = [
    toolMsg(batch(25), '2026-08-11T13:47:05.310Z'),
    toolMsg(batch(25), '2026-08-11T13:48:41.814Z'),
    toolMsg(batch(25), '2026-08-11T13:50:19.952Z'),
  ];

  it('turns the run into a founded set that permits 75 and rejects 3', () => {
    const totals = collectLeadImportTotals(messages, SINCE);
    const founded = [totals.landed];

    expect(describeLeadImportTotals(totals)).toMatch(/75/);

    // The number the production message actually printed.
    expect(stripUnfoundedEntityCounts('I have successfully added the 3 leads to your CRM list.', founded))
      .toBe('I have successfully added the leads to your CRM list.');

    // The number it should have printed.
    const truthful = 'I added 75 leads to your CRM list before the run hit its time limit.';
    expect(stripUnfoundedEntityCounts(truthful, founded)).toBe(truthful);
  });

  it('falls back to stripping everything when the transcript is unreadable', () => {
    const totals = collectLeadImportTotals([], SINCE);
    const founded = totals.known ? [totals.landed, totals.attempted] : [];

    expect(describeLeadImportTotals(totals)).toBeNull();
    expect(stripUnfoundedEntityCounts('I added 75 leads.', founded)).toBe('I added the leads.');
  });
});
