/**
 * ENG-529 AC5 — "Retrying an ambiguous or timed-out request must not create duplicate reporter
 * tickets for the same report."
 *
 * WHY THIS LIVES AT THE DESTINATION (ENG-598 option A)
 * ---------------------------------------------------
 * `fileReportOnce` is an IN-PROCESS replay guard. It is bounded (per-scope and total caps) and at
 * aggregate capacity it evicts the oldest settled entry so one tenant cannot consume another's
 * right to file. That eviction is correct for admission and fatal for AC5: once a still-fresh
 * settled entry is evicted, the reporter's retry re-runs the filer and creates a SECOND private
 * card. That is exactly what produced reporter tickets #169, #170 and #171 from one report on
 * 2026-07-26, and it is Greptile's 3/5 finding on PR #2182.
 *
 * No in-process structure can fix this: the guard must be simultaneously exact, finite, and
 * non-starving, and it cannot be all three. Harsha resolved ENG-598 to option A — dedupe where the
 * ticket is actually created — so the durable guarantee belongs to the destination and the
 * in-process map degrades to a pure concurrency coalescer.
 *
 * Featurebase exposes no idempotency key, but `GET /v2/tickets?q=` does exist and genuinely
 * filters (verified against the live API: 10 items unfiltered, 0 for an absent marker). So the
 * mechanism is marker-and-search: stamp the report fingerprint on the ticket at create, and look
 * it up before creating.
 *
 * These assertions are written against the human-written contract on ENG-529 and MUST NOT be
 * relaxed to match the implementation.
 */

const createTicket = jest.fn();
const findTicketByMarker = jest.fn();
const createInternalLinearIssue = jest.fn();
const addIssueComment = jest.fn();
const listOpenBugCanonicals = jest.fn();
const findDuplicate = jest.fn();

jest.mock('../featurebaseService', () => ({
  createTicket: (...a: any[]) => createTicket(...a),
  findTicketByMarker: (...a: any[]) => findTicketByMarker(...a),
}));
jest.mock('../linearService', () => ({
  createInternalLinearIssue: (...a: any[]) => createInternalLinearIssue(...a),
  addIssueComment: (...a: any[]) => addIssueComment(...a),
  listOpenBugCanonicals: (...a: any[]) => listOpenBugCanonicals(...a),
}));
jest.mock('../dedupService', () => ({
  findDuplicate: (...a: any[]) => findDuplicate(...a),
  MAX_CANDIDATES: 25,
}));

const FINGERPRINT = 'fp-deadbeef-same-report';

const baseParams = {
  type: 'bug' as const,
  title: 'Voice mode does not feel natural',
  description: 'Line one\nLine two',
  userEmail: 'harsha@agentcapx.com',
  userName: 'Kevin Rajan',
  sessionId: 'sess-123',
  reportFingerprint: FINGERPRINT,
};

describe('ENG-529 AC5 — bug filing is idempotent at the destination', () => {
  // `fileUserIssue` short-circuits to the pre-migration Notion path unless FEATUREBASE_INTAKE is
  // on. Without this the whole suite goes red for the wrong reason — createTicket is simply never
  // reached — which reads identically to a genuine failure.
  const previousIntakeFlag = process.env.FEATUREBASE_INTAKE;
  beforeAll(() => { process.env.FEATUREBASE_INTAKE = 'true'; });
  afterAll(() => {
    if (previousIntakeFlag === undefined) delete process.env.FEATUREBASE_INTAKE;
    else process.env.FEATUREBASE_INTAKE = previousIntakeFlag;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    createTicket.mockResolvedValue({ id: 't1', number: 169, url: 'https://fb/t/169' });
    findTicketByMarker.mockResolvedValue(null);
    listOpenBugCanonicals.mockResolvedValue([]);
    findDuplicate.mockResolvedValue(null);
    createInternalLinearIssue.mockResolvedValue({ id: 'lin-uuid-1', identifier: 'ENG-525' });
    addIssueComment.mockResolvedValue(undefined);
  });

  it('looks the fingerprint up at the destination BEFORE creating a ticket', async () => {
    const { fileUserIssue } = await import('../intakeService');
    await fileUserIssue(baseParams as any);

    expect(findTicketByMarker).toHaveBeenCalledWith(FINGERPRINT);
    // The lookup is worthless if it happens after the create.
    expect(findTicketByMarker.mock.invocationCallOrder[0])
      .toBeLessThan(createTicket.mock.invocationCallOrder[0]);
  });

  it('stamps the fingerprint on the created ticket so a later retry can find it', async () => {
    const { fileUserIssue } = await import('../intakeService');
    await fileUserIssue(baseParams as any);

    const arg = createTicket.mock.calls[0][0];
    const stamped = JSON.stringify(arg);
    expect(stamped).toContain(FINGERPRINT);
  });

  it('does NOT create a second card when the same report is retried after local state is gone', async () => {
    const { fileUserIssue } = await import('../intakeService');

    // First filing: nothing at the destination yet.
    await fileUserIssue(baseParams as any);
    expect(createTicket).toHaveBeenCalledTimes(1);

    // Retry. The in-process guard is deliberately bypassed here — this models the evicted /
    // restarted / second-instance case, which is precisely where AC5 previously broke.
    findTicketByMarker.mockResolvedValue({ id: 't1', number: 169, url: 'https://fb/t/169' });
    await fileUserIssue(baseParams as any);

    // THE ASSERTION THAT MATTERS: still exactly one card for one report.
    expect(createTicket).toHaveBeenCalledTimes(1);
  });

  it('returns the existing ticket on a retry rather than reporting failure', async () => {
    const { fileUserIssue } = await import('../intakeService');
    findTicketByMarker.mockResolvedValue({ id: 't1', number: 169, url: 'https://fb/t/169' });

    const res: any = await fileUserIssue(baseParams as any);

    expect(res.deduped).toBe(true);
    expect(res.tracker).toBe('Featurebase');
    // AC1: the user still gets a success response carrying their tracking link.
    expect(res.userUrl || res.trackerUrl).toContain('169');
  });

  it('does not duplicate the canonical Linear issue on a retry', async () => {
    const { fileUserIssue } = await import('../intakeService');
    findTicketByMarker.mockResolvedValue({ id: 't1', number: 169, url: 'https://fb/t/169' });

    await fileUserIssue(baseParams as any);

    // A replayed filing already has its canonical; creating another would split one bug across
    // two eng tickets and break the resolve-bridge's one-canonical-per-bug contract.
    expect(createInternalLinearIssue).not.toHaveBeenCalled();
  });

  it('still files normally when no fingerprint is supplied (no silent behaviour change)', async () => {
    const { fileUserIssue } = await import('../intakeService');
    const { reportFingerprint: _drop, ...noFp } = baseParams as any;

    await fileUserIssue(noFp);

    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(findTicketByMarker).not.toHaveBeenCalled();
  });
});
