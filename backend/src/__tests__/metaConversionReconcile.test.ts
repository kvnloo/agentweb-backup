/**
 * ENG-926 §C — reconciliation sweep for owed Meta conversions.
 *
 * When the async job queue is unreachable, an owed conversion is recorded on the lead as
 * `metaConversionPending`. Until now its only consumer ran from crmDb.updateLead, so a lead
 * nobody touched again kept its owed conversion forever — the marker preserved the fact and
 * nothing ever acted on it (Greptile on #2412).
 *
 * This sweep is that independent consumer. It rides the existing 12-hourly Meta cron rather
 * than adding a scheduler, and it is gated on the relay being enabled for the owner, so it
 * costs nothing at all for the customers who have not opted in — which today is all of them.
 */

const dispatchLeadStatusConversion = jest.fn().mockResolvedValue('sent');
jest.mock('../services/metaConversionRelay', () => {
  const actual = jest.requireActual('../services/metaConversionRelay');
  return {
    ...actual,
    dispatchLeadStatusConversion: (...a: any[]) => dispatchLeadStatusConversion(...a),
  };
});

const getLeadListsByUserId = jest.fn();
const getLeadsByListId = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: (...a: any[]) => getLeadListsByUserId(...a),
    getLeadsByListId: (...a: any[]) => getLeadsByListId(...a),
  },
}));

import { reconcilePendingConversionsForUser } from '../services/metaConversionReconcile';

const OPTED_IN = {
  userId: 'user-1',
  connected_accounts: [
    {
      platform: 'meta',
      account_id: 'acct1',
      config: { account_type: 'ad_account', access_token: 'tok', crmConversionRelayEnabled: true },
    },
  ],
};

const NOT_OPTED_IN = {
  userId: 'user-2',
  connected_accounts: [
    { platform: 'meta', account_id: 'acct1', config: { account_type: 'ad_account', access_token: 'tok' } },
  ],
};

const LIST = { listId: 'list-1', userId: 'user-1', statusConfig: [] };

const leadWithPending = (leadId: string, pending: any) => ({
  leadId,
  listId: 'list-1',
  status: 'lost',
  metaConversionPending: pending,
});

beforeEach(() => {
  jest.clearAllMocks();
  getLeadListsByUserId.mockResolvedValue([LIST]);
  getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: undefined });
});

describe('reconcilePendingConversionsForUser — the cheap gate', () => {
  it('does no work at all for an owner who has not opted in', async () => {
    // The sweep rides a cron that already walks every user. If it queried leads for
    // everyone it would be a real cost for zero benefit, since a lead can only owe a
    // conversion when its owner had the relay enabled.
    const summary = await reconcilePendingConversionsForUser(NOT_OPTED_IN as any);

    expect(getLeadListsByUserId).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scannedLists: 0, pendingFound: 0, dispatched: 0 });
  });

  it('does no work for a user with no Meta connection at all', async () => {
    await reconcilePendingConversionsForUser({ userId: 'u', connected_accounts: [] } as any);
    expect(getLeadListsByUserId).not.toHaveBeenCalled();
  });
});

describe('reconcilePendingConversionsForUser — finding owed conversions', () => {
  it('dispatches each owed conversion with its RECORDED kind', async () => {
    getLeadsByListId.mockResolvedValue({
      items: [leadWithPending('lead-1', { values: ['won'] })],
      lastEvaluatedKey: undefined,
    });

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(dispatchLeadStatusConversion).toHaveBeenCalledTimes(1);
    const ctx = dispatchLeadStatusConversion.mock.calls[0][0];
    expect(ctx).toMatchObject({ listId: 'list-1', userId: 'user-1', conversionKind: 'won' });
    expect(summary).toMatchObject({ pendingFound: 1, dispatched: 1 });
  });

  it('dispatches BOTH kinds when a lead owes two', async () => {
    getLeadsByListId.mockResolvedValue({
      items: [leadWithPending('lead-1', { values: ['qualified', 'won'] })],
      lastEvaluatedKey: undefined,
    });

    await reconcilePendingConversionsForUser(OPTED_IN as any);

    const kinds = dispatchLeadStatusConversion.mock.calls.map((c) => c[0].conversionKind);
    expect(kinds).toEqual(expect.arrayContaining(['qualified', 'won']));
    expect(kinds).toHaveLength(2);
  });

  it('reads the legacy scalar marker too, so rows written earlier are not stranded', async () => {
    getLeadsByListId.mockResolvedValue({
      items: [leadWithPending('lead-1', 'won')],
      lastEvaluatedKey: undefined,
    });

    await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(dispatchLeadStatusConversion.mock.calls[0][0].conversionKind).toBe('won');
  });

  it('ignores leads with no marker', async () => {
    getLeadsByListId.mockResolvedValue({
      items: [{ leadId: 'lead-1', listId: 'list-1', status: 'won' }],
      lastEvaluatedKey: undefined,
    });

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(dispatchLeadStatusConversion).not.toHaveBeenCalled();
    expect(summary.pendingFound).toBe(0);
  });

  it('follows pagination — an owed conversion on page two is not missed', async () => {
    getLeadsByListId
      .mockResolvedValueOnce({ items: [], lastEvaluatedKey: { leadId: 'x' } })
      .mockResolvedValueOnce({
        items: [leadWithPending('lead-2', { values: ['won'] })],
        lastEvaluatedKey: undefined,
      });

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(getLeadsByListId).toHaveBeenCalledTimes(2);
    expect(summary.dispatched).toBe(1);
  });

  it('passes the list statusConfig through so a renamed won status still resolves', async () => {
    const renamed = [{ value: 'deal_closed', label: 'Closed', color: 'green', type: 'won' }];
    getLeadListsByUserId.mockResolvedValue([{ ...LIST, statusConfig: renamed }]);
    getLeadsByListId.mockResolvedValue({
      items: [leadWithPending('lead-1', { values: ['won'] })],
      lastEvaluatedKey: undefined,
    });

    await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(dispatchLeadStatusConversion.mock.calls[0][0].statusConfig).toEqual(renamed);
  });
});

describe('reconcilePendingConversionsForUser — never lets one bad row kill the sweep', () => {
  it('keeps going when one dispatch throws', async () => {
    getLeadsByListId.mockResolvedValue({
      items: [
        leadWithPending('lead-1', { values: ['won'] }),
        leadWithPending('lead-2', { values: ['won'] }),
      ],
      lastEvaluatedKey: undefined,
    });
    dispatchLeadStatusConversion.mockRejectedValueOnce(new Error('Meta down'));

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(dispatchLeadStatusConversion).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ dispatched: 1, failed: 1 });
  });

  it('keeps going when one list cannot be read', async () => {
    getLeadListsByUserId.mockResolvedValue([LIST, { ...LIST, listId: 'list-2' }]);
    getLeadsByListId
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({
        items: [leadWithPending('lead-9', { values: ['won'] })],
        lastEvaluatedKey: undefined,
      });

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.dispatched).toBe(1);
  });

  it('does not throw when the owner has no lead lists', async () => {
    getLeadListsByUserId.mockResolvedValue([]);
    await expect(reconcilePendingConversionsForUser(OPTED_IN as any)).resolves.toMatchObject({
      scannedLists: 0,
    });
  });

  it('stops after the per-sweep dispatch cap rather than running unbounded', async () => {
    // A backlog must not turn one cron tick into thousands of Meta calls; the remainder is
    // picked up by the next sweep.
    const many = Array.from({ length: 500 }, (_, i) => leadWithPending(`lead-${i}`, { values: ['won'] }));
    getLeadsByListId.mockResolvedValue({ items: many, lastEvaluatedKey: undefined });

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.dispatched).toBeLessThan(500);
    expect(summary.cappedOut).toBe(true);
  });

  it('failures do NOT consume the dispatch budget — later leads still get their turn', async () => {
    // The starvation shape: a cluster of persistently failing leads sits at the front of the
    // scan. If failures counted against the cap they would eat it every sweep, stop
    // pagination, and the leads behind them would never be attempted at all — permanently,
    // since each sweep restarts from the beginning and re-hits the same failures.
    const failing = Array.from({ length: 300 }, (_, i) => leadWithPending(`bad-${i}`, { values: ['won'] }));
    const good = leadWithPending('good-1', { values: ['won'] });
    getLeadsByListId.mockResolvedValue({ items: [...failing, good], lastEvaluatedKey: undefined });

    // Every 'bad-' lead fails; the one behind them succeeds.
    dispatchLeadStatusConversion.mockImplementation(async (ctx: any) =>
      String(ctx.lead.leadId).startsWith('bad-') ? Promise.reject(new Error('Meta rejected')) : 'sent',
    );

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.failed).toBe(300);
    // The lead behind 300 failures was still reached and sent.
    expect(summary.dispatched).toBe(1);
    const attempted = dispatchLeadStatusConversion.mock.calls.map((c) => c[0].lead.leadId);
    expect(attempted).toContain('good-1');
  });

  it('a marker already owned by a live job costs no budget — later leads still get through', async () => {
    // dispatch returns 'already-queued' when another worker owns that conversion: nothing is
    // sent and the marker stays put to be re-found. Counting those as work let a cluster of
    // them exhaust the sweep every tick and starve everything behind them.
    const owned = Array.from({ length: 300 }, (_, i) => leadWithPending(`owned-${i}`, { values: ['won'] }));
    const good = leadWithPending('good-1', { values: ['won'] });
    getLeadsByListId.mockResolvedValue({ items: [...owned, good], lastEvaluatedKey: undefined });
    dispatchLeadStatusConversion.mockImplementation(async (ctx: any) =>
      String(ctx.lead.leadId).startsWith('owned-') ? 'already-queued' : 'sent',
    );

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.noops).toBe(300);
    expect(summary.dispatched).toBe(1);
    expect(summary.cappedOut).toBe(false);
    const attempted = dispatchLeadStatusConversion.mock.calls.map((c) => c[0].lead.leadId);
    expect(attempted).toContain('good-1');
  });

  it('counts an inline fallback as real work — it did attempt the send', async () => {
    getLeadsByListId.mockResolvedValue({
      items: [leadWithPending('lead-1', { values: ['won'] })],
      lastEvaluatedKey: undefined,
    });
    dispatchLeadStatusConversion.mockResolvedValue('fallback');

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.dispatched).toBe(1);
    expect(summary.noops).toBe(0);
  });

  it('a long failing PREFIX never blocks the leads behind it', async () => {
    // The starvation shape in full: 800 persistently failing leads ahead of a good one. Any
    // ceiling failures alone can reach would stop here every sweep — and since the sweep has
    // no persistent cursor it restarts at the same prefix each tick, so the good lead would
    // never be attempted at all.
    const failing = Array.from({ length: 800 }, (_, i) => leadWithPending(`bad-${i}`, { values: ['won'] }));
    const good = leadWithPending('good-1', { values: ['won'] });
    getLeadsByListId.mockResolvedValue({ items: [...failing, good], lastEvaluatedKey: undefined });
    dispatchLeadStatusConversion.mockImplementation(async (ctx: any) =>
      String(ctx.lead.leadId).startsWith('bad-') ? Promise.reject(new Error('Meta down')) : 'sent',
    );

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.failed).toBe(800);
    expect(summary.dispatched).toBe(1);
    const attempted = dispatchLeadStatusConversion.mock.calls.map((c) => c[0].lead.leadId);
    expect(attempted).toContain('good-1');
  });

  it('steps over ANY number of failures to reach the lead behind them', async () => {
    // No ceiling failures can reach, at any size. Every finite one was starvation with a
    // different number on it, because the sweep restarts from the beginning each tick.
    const failing = Array.from({ length: 2500 }, (_, i) => leadWithPending(`bad-${i}`, { values: ['won'] }));
    const good = leadWithPending('good-1', { values: ['won'] });
    getLeadsByListId.mockResolvedValue({ items: [...failing, good], lastEvaluatedKey: undefined });
    dispatchLeadStatusConversion.mockImplementation(async (ctx: any) =>
      String(ctx.lead.leadId).startsWith('bad-') ? Promise.reject(new Error('Meta down')) : 'sent',
    );

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.failed).toBe(2500);
    expect(summary.dispatched).toBe(1);
    expect(summary.cappedOut).toBe(false);
  });

  it('a prefix of leads that never SEND does not exhaust the budget', async () => {
    // e.g. leads that opted out after their markers were written: dispatch processes them
    // but nothing reaches Meta. Counting those as sends let them block every sweep.
    const nonSending = Array.from({ length: 400 }, (_, i) => leadWithPending(`settled-${i}`, { values: ['won'] }));
    const good = leadWithPending('good-1', { values: ['won'] });
    getLeadsByListId.mockResolvedValue({ items: [...nonSending, good], lastEvaluatedKey: undefined });
    dispatchLeadStatusConversion.mockImplementation(async (ctx: any) =>
      String(ctx.lead.leadId).startsWith('settled-') ? 'processed' : 'sent',
    );

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.dispatched).toBe(1);
    expect(summary.noops).toBe(400);
    expect(summary.cappedOut).toBe(false);
  });

  it('still budgets SUCCESSFUL sends per sweep', async () => {
    const many = Array.from({ length: 500 }, (_, i) => leadWithPending(`ok-${i}`, { values: ['won'] }));
    getLeadsByListId.mockResolvedValue({ items: many, lastEvaluatedKey: undefined });
    dispatchLeadStatusConversion.mockResolvedValue('sent');

    const summary = await reconcilePendingConversionsForUser(OPTED_IN as any);

    expect(summary.dispatched).toBeLessThan(500);
    expect(summary.cappedOut).toBe(true);
  });
});
