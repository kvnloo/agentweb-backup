/**
 * A lead that received NOTHING must be re-enrollable.
 *
 * getExistingEnrollment deliberately matches regardless of status, so a lead already in
 * a sequence is never enrolled twice. But that also meant a row which skipped every step
 * and exited having sent nothing permanently barred that lead from the sequence — even
 * after the user fixed the data that made it unreachable. Combined with the channel and
 * reachability defects, a loud jam became silent permanent loss.
 *
 * Excluding those rows cannot cause a double send: by definition nothing was sent.
 *
 * Asserted at the QUERY layer rather than through a mocked helper, because the previous
 * round of this work proved that asserting an argument reaching a mock says nothing
 * about what the code does with it.
 */
const mockQuery = jest.fn();
const mockPut = jest.fn();
const mockTransactWrite = jest.fn();
jest.mock('aws-sdk', () => {
  const client = () => ({
    query: mockQuery,
    put: mockPut,
    transactWrite: mockTransactWrite,
    update: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
  });
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) }, config: { update: jest.fn() } },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

import { dripSequenceDb } from '../services/dripSequenceDb';

const rows = (items: any[]) => ({ promise: () => Promise.resolve({ Items: items }) });

/** ENG-2127: enrollLead writes via a transaction (the real enrollment Put plus one
 * claim-item Put per identity candidate), not a bare `put`. Pull the actual enrollment
 * item back out — distinguishable from a claim item by its `enr_` id prefix — so these
 * tests can keep asserting on "what got written" the same way they did before. */
const enrollmentPuts = () =>
  mockTransactWrite.mock.calls
    .map(([params]) => params.TransactItems.find((t: any) => t.Put?.Item?.enrollmentId?.startsWith('enr_')))
    .filter(Boolean)
    .map((t: any) => t.Put.Item);

beforeEach(() => {
  mockQuery.mockReset();
  mockPut.mockReset();
  mockPut.mockImplementation(() => ({ promise: () => Promise.resolve({}) }));
  mockTransactWrite.mockReset();
  mockTransactWrite.mockImplementation(() => ({ promise: () => Promise.resolve({}) }));
});

const enrollment = (over: Record<string, unknown> = {}) => ({
  enrollmentId: 'old-1', sequenceId: 'seq-1', leadEmail: 'ada@acme.io',
  leadId: 'lead-1', listId: 'list-1', userId: 'user-1', status: 'completed',
  exitReason: 'completed', currentStep: 2, ...over,
});

const input = {
  sequenceId: 'seq-1', userId: 'user-1', listId: 'list-1',
  leadId: 'lead-1', leadEmail: 'ada@acme.io',
};

describe('bulkEnroll and a prior enrollment', () => {
  it('re-enrols a lead whose previous run exited completed_no_sends', async () => {
    mockQuery.mockImplementation(() => rows([enrollment({ exitReason: 'completed_no_sends' })]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(enrollmentPuts()).toHaveLength(1);
    expect(result.enrolled).toBe(1);
  });

  it('does NOT re-enrol a lead whose previous run actually delivered', async () => {
    mockQuery.mockImplementation(() => rows([enrollment({ exitReason: 'completed' })]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(mockTransactWrite).not.toHaveBeenCalled();
    expect(result.enrolled).toBe(0);
  });

  it('does NOT re-enrol a lead who is still active', async () => {
    mockQuery.mockImplementation(() => rows([enrollment({ status: 'active', exitReason: undefined })]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(mockTransactWrite).not.toHaveBeenCalled();
    expect(result.enrolled).toBe(0);
  });

  it('enrols a lead with no prior enrollment at all', async () => {
    mockQuery.mockImplementation(() => rows([]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(enrollmentPuts()).toHaveLength(1);
    expect(result.enrolled).toBe(1);
  });
});

/**
 * Review round 2, finding 2. The dedup identity is derived from MUTABLE lead data with
 * email winning over the LinkedIn URL, so it moves under an already-enrolled lead.
 *
 * Enrol an address-less lead and the row is keyed on its canonical profile URL. The day
 * that lead gains an email — a webhook resubmission, a CRM import, an Apollo match —
 * `enrollmentIdentity` returns the address instead, the dedup query looks only under the
 * new key, finds nothing, and the whole sequence is delivered a second time. Three
 * automatic paths do exactly that and then re-run enrolment over the entire list.
 *
 * So the check has to look under every identity the lead could already be stored under.
 */
describe('dedup survives the identity moving under an enrolled lead', () => {
  const profile = 'https://www.linkedin.com/in/ada/';

  it('finds the old LinkedIn-keyed row when the lead has since gained an email', async () => {
    // Stored under the profile URL; today's identity would be the address.
    mockQuery.mockImplementation((params: any) => (
      params.ExpressionAttributeValues[':email'] === profile
        ? rows([enrollment({ leadEmail: profile })])
        : rows([])
    ));

    const result = await dripSequenceDb.bulkEnroll([{
      ...input,
      leadEmail: 'ada@acme.io',
      identityCandidates: ['ada@acme.io', profile],
    } as any]);

    expect(result.skipped).toBe(1);
    expect(result.enrolled).toBe(0);
    expect(mockTransactWrite).not.toHaveBeenCalled();
  });

  it('finds the old email-keyed row when the address was since removed', async () => {
    mockQuery.mockImplementation((params: any) => (
      params.ExpressionAttributeValues[':email'] === 'ada@acme.io'
        ? rows([enrollment({ leadEmail: 'ada@acme.io' })])
        : rows([])
    ));

    const result = await dripSequenceDb.bulkEnroll([{
      ...input,
      leadEmail: profile,
      identityCandidates: [profile, 'ada@acme.io'],
    } as any]);

    expect(result.skipped).toBe(1);
    expect(mockTransactWrite).not.toHaveBeenCalled();
  });

  it('still enrols when NO candidate matches', async () => {
    mockQuery.mockImplementation(() => rows([]));

    const result = await dripSequenceDb.bulkEnroll([{
      ...input, leadEmail: 'ada@acme.io', identityCandidates: ['ada@acme.io', profile],
    } as any]);

    expect(result.enrolled).toBe(1);
    expect(enrollmentPuts()).toHaveLength(1);
  });

  it('writes only leadEmail — identityCandidates is a lookup aid, never persisted', async () => {
    mockQuery.mockImplementation(() => rows([]));

    await dripSequenceDb.bulkEnroll([{
      ...input, leadEmail: 'ada@acme.io', identityCandidates: ['ada@acme.io', profile],
    } as any]);

    const item = enrollmentPuts()[0];
    expect(item.leadEmail).toBe('ada@acme.io');
    expect(item.identityCandidates).toBeUndefined();
  });

  it('a completed_no_sends row under the OLD identity still does not block re-enrol', async () => {
    // The two fixes have to compose: candidate lookup must not resurrect the very rows
    // the exitReason filter exists to ignore.
    mockQuery.mockImplementation((params: any) => (
      params.ExpressionAttributeValues[':email'] === profile
        ? rows([enrollment({ leadEmail: profile, exitReason: 'completed_no_sends' })])
        : rows([])
    ));

    const result = await dripSequenceDb.bulkEnroll([{
      ...input, leadEmail: 'ada@acme.io', identityCandidates: ['ada@acme.io', profile],
    } as any]);

    expect(result.enrolled).toBe(1);
  });

  it('checks leadEmail even when no candidates are supplied (legacy callers)', async () => {
    mockQuery.mockImplementation(() => rows([enrollment()]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(result.skipped).toBe(1);
    expect(mockQuery.mock.calls[0][0].ExpressionAttributeValues[':email']).toBe('ada@acme.io');
  });
});
