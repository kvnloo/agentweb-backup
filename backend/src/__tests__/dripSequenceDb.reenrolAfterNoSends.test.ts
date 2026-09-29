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
jest.mock('aws-sdk', () => {
  const client = () => ({ query: mockQuery, put: mockPut, update: jest.fn(() => ({ promise: () => Promise.resolve({}) })) });
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) }, config: { update: jest.fn() } },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

import { dripSequenceDb } from '../services/dripSequenceDb';

const rows = (items: any[]) => ({ promise: () => Promise.resolve({ Items: items }) });

beforeEach(() => {
  mockQuery.mockReset();
  mockPut.mockReset();
  mockPut.mockImplementation(() => ({ promise: () => Promise.resolve({}) }));
});

const enrollment = (over: Record<string, unknown> = {}) => ({
  enrollmentId: 'old-1', sequenceId: 'seq-1', leadEmail: 'ada@example.org',
  leadId: 'lead-1', listId: 'list-1', userId: 'user-1', status: 'completed',
  exitReason: 'completed', currentStep: 2, ...over,
});

const input = {
  sequenceId: 'seq-1', userId: 'user-1', listId: 'list-1',
  leadId: 'lead-1', leadEmail: 'ada@example.org',
};

describe('bulkEnroll and a prior enrollment', () => {
  it('re-enrols a lead whose previous run exited completed_no_sends', async () => {
    mockQuery.mockImplementation(() => rows([enrollment({ exitReason: 'completed_no_sends' })]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(mockPut).toHaveBeenCalled();
    expect(result.enrolled).toBe(1);
  });

  it('does NOT re-enrol a lead whose previous run actually delivered', async () => {
    mockQuery.mockImplementation(() => rows([enrollment({ exitReason: 'completed' })]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(mockPut).not.toHaveBeenCalled();
    expect(result.enrolled).toBe(0);
  });

  it('does NOT re-enrol a lead who is still active', async () => {
    mockQuery.mockImplementation(() => rows([enrollment({ status: 'active', exitReason: undefined })]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(mockPut).not.toHaveBeenCalled();
    expect(result.enrolled).toBe(0);
  });

  it('enrols a lead with no prior enrollment at all', async () => {
    mockQuery.mockImplementation(() => rows([]));

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(mockPut).toHaveBeenCalled();
    expect(result.enrolled).toBe(1);
  });
});
