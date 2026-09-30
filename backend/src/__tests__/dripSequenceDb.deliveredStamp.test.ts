/**
 * The `delivered` flag, asserted where it becomes a RECORD.
 *
 * Review 6 caught this: the worker test asserts `delivered === false` reaching a MOCKED
 * advanceEnrollment/completeEnrollment, which proves the argument is passed and nothing
 * about what it does. Deleting the conditional in the UpdateExpression failed zero tests
 * in the whole repo — the fix the commit led with had no coverage at any layer.
 *
 * These tests read the UpdateExpression that DynamoDB would actually receive.
 */
const mockUpdate = jest.fn();
jest.mock('aws-sdk', () => {
  const client = () => ({ update: mockUpdate });
  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
      config: { update: jest.fn() },
    },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

import { dripSequenceDb } from '../services/dripSequenceDb';

const ok = () => ({ promise: () => Promise.resolve({}) });
const lastCall = () => mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1][0];

beforeEach(() => {
  mockUpdate.mockReset();
  mockUpdate.mockImplementation(ok);
});

describe('advanceEnrollment — the sent-timestamp is a record of a real send', () => {
  it('STAMPS the channel timestamp when the step was delivered', async () => {
    await dripSequenceDb.advanceEnrollment('e1', 1, '2026-01-02T00:00:00Z', 'email', true);
    const p = lastCall();
    expect(p.UpdateExpression).toContain('lastEmailSentAt = :sent');
    expect(p.ExpressionAttributeValues[':sent']).toEqual(expect.any(String));
  });

  it('does NOT stamp it when the step was SKIPPED', async () => {
    await dripSequenceDb.advanceEnrollment('e1', 1, '2026-01-02T00:00:00Z', 'email', false);
    const p = lastCall();
    expect(p.UpdateExpression).not.toContain('lastEmailSentAt');
    // DynamoDB rejects an ExpressionAttributeValues entry the expression never uses.
    expect(p.ExpressionAttributeValues).not.toHaveProperty(':sent');
    // and the rest of the update still happens
    expect(p.UpdateExpression).toContain('currentStep = :step');
    expect(p.UpdateExpression).toContain('REMOVE claimedAt');
  });

  it('names the LinkedIn field for a LinkedIn step', async () => {
    await dripSequenceDb.advanceEnrollment('e1', 1, '2026-01-02T00:00:00Z', 'linkedin', true);
    expect(lastCall().UpdateExpression).toContain('lastLinkedInSentAt = :sent');
  });
});

describe('completeEnrollment — same contract on the terminal write', () => {
  it('STAMPS on a delivered final step', async () => {
    await dripSequenceDb.completeEnrollment('e1', 'completed', 'completed', 'linkedin', true);
    const p = lastCall();
    expect(p.UpdateExpression).toContain('lastLinkedInSentAt = :sent');
    expect(p.ExpressionAttributeValues[':sent']).toEqual(expect.any(String));
  });

  it('does NOT stamp when the final step was skipped', async () => {
    await dripSequenceDb.completeEnrollment('e1', 'completed', 'completed', 'linkedin', false);
    const p = lastCall();
    expect(p.UpdateExpression).not.toContain('SentAt = :sent');
    expect(p.ExpressionAttributeValues).not.toHaveProperty(':sent');
    expect(p.UpdateExpression).toContain('exitReason = :reason');
    expect(p.ExpressionAttributeNames['#s']).toBe('status');
  });
});

describe('exitEnrollment — an exit sends nothing', () => {
  it.each([
    ['unsubscribed', 'unsubscribed'],
    ['converted', 'exited'],
    ['engagement', 'exited'],
  ])('%s never records a send', async (reason, expectedStatus) => {
    await dripSequenceDb.exitEnrollment('e1', reason as any);
    const p = lastCall();
    // This is the highest-volume caller. It defaulted to delivered=true, so every
    // unsubscribe stamped lastEmailSentAt for a message that never existed.
    expect(p.UpdateExpression).not.toContain('SentAt = :sent');
    expect(p.ExpressionAttributeValues).not.toHaveProperty(':sent');
    expect(p.ExpressionAttributeValues[':status']).toBe(expectedStatus);
  });
});
