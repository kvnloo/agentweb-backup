/**
 * ENG-1590 — Delegated-Filed label on the direct-bug intake path.
 *
 * Contract (human-written AC on ENG-1590, scoped by the ENG-1592 decision):
 * 1. A bug Linear issue filed via intakeService with reportedByAdmin set (delegated session)
 *    carries the `Delegated-Filed` label.
 * 2. With reportedByAdmin unset (direct customer filing), no Delegated-Filed label — absence is
 *    the queryable self-filed signal (same convention as the `Auto` label).
 * 3. The prose (`Affected user: ... (via X acting on their behalf)` / `(self-reported)`) is
 *    untouched — additive only.
 * 4. Feature-request path creates no Linear issue (posts to Featurebase only) — asserted as
 *    documentation of the verified scope, not silently skipped.
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
  listOpenPosts: jest.fn().mockResolvedValue([]),
  createPost: jest.fn().mockResolvedValue({ id: 'p1' }),
  addComment: jest.fn().mockResolvedValue(undefined),
  addVoter: jest.fn().mockResolvedValue(undefined),
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

const baseParams = {
  type: 'bug' as const,
  title: 'Delegated filing label check',
  description: 'Delegated vs self filing must be queryable',
  userEmail: 'customer@example.com',
  userName: 'Customer User',
  sessionId: 'sess-1590',
};

describe('ENG-1590 — Delegated-Filed label on direct-bug intake', () => {
  const previousIntakeFlag = process.env.FEATUREBASE_INTAKE;
  beforeAll(() => { process.env.FEATUREBASE_INTAKE = 'true'; });
  afterAll(() => {
    if (previousIntakeFlag === undefined) delete process.env.FEATUREBASE_INTAKE;
    else process.env.FEATUREBASE_INTAKE = previousIntakeFlag;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    createTicket.mockResolvedValue({ id: 't1', number: 201, url: 'https://fb/t/201' });
    findTicketByMarker.mockResolvedValue(null);
    listOpenBugCanonicals.mockResolvedValue([]);
    findDuplicate.mockResolvedValue(null);
    createInternalLinearIssue.mockResolvedValue({ id: 'lin-uuid-1', identifier: 'ENG-X' });
    addIssueComment.mockResolvedValue(undefined);
  });

  it('applies Delegated-Filed when reportedByAdmin is set (delegated session)', async () => {
    const { fileUserIssue } = await import('../intakeService');
    await fileUserIssue({ ...baseParams, reportedByAdmin: 'admin@example.com' } as any);

    expect(createInternalLinearIssue).toHaveBeenCalledTimes(1);
    const labelNames = createInternalLinearIssue.mock.calls[0][0].labelNames as string[];
    expect(labelNames).toContain('Delegated-Filed');
    expect(labelNames).toContain('Bug');
    expect(labelNames).toContain('Customer Reported');
  });

  it('omits Delegated-Filed when reportedByAdmin is unset (self-filed)', async () => {
    const { fileUserIssue } = await import('../intakeService');
    await fileUserIssue({ ...baseParams } as any);

    expect(createInternalLinearIssue).toHaveBeenCalledTimes(1);
    const labelNames = createInternalLinearIssue.mock.calls[0][0].labelNames as string[];
    expect(labelNames).not.toContain('Delegated-Filed');
    expect(labelNames).toContain('Bug');
    expect(labelNames).toContain('Customer Reported');
  });

  it('keeps the human-readable delegation prose exactly as-is', async () => {
    const { fileUserIssue } = await import('../intakeService');
    await fileUserIssue({ ...baseParams, reportedByAdmin: 'admin@example.com' } as any);

    const description = createInternalLinearIssue.mock.calls[0][0].description as string;
    expect(description).toContain('via admin@example.com acting on their behalf (delegated session)');

    jest.clearAllMocks();
    await fileUserIssue({ ...baseParams } as any);
    const selfDescription = createInternalLinearIssue.mock.calls[0][0].description as string;
    expect(selfDescription).toContain('(self-reported)');
  });

  it('documents that the feature-request path files no Linear issue (Featurebase only)', async () => {
    const { fileUserIssue } = await import('../intakeService');
    await fileUserIssue({ ...baseParams, type: 'feature' } as any);

    // Direct-bug scope only per the ENG-1592 decision: feature requests post to Featurebase,
    // no Linear issue is created on this path, so no label treatment applies.
    expect(createInternalLinearIssue).not.toHaveBeenCalled();
  });
});
