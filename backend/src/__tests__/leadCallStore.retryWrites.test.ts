/**
 * The press-2 retry's three writes on the lead row (ENG-2783), through the REAL crmDb.updateLeadSystemRecordIf with only the
 * AWS client mocked, so the generated UpdateItem is what is asserted: the exact expression, no overlapping document paths, and
 * every placeholder declared and used.
 */
const mockDocumentClientMethods = {
  put: jest.fn(), get: jest.fn(), query: jest.fn(), scan: jest.fn(), update: jest.fn(), delete: jest.fn(), batchWrite: jest.fn(),
};
jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(() => mockDocumentClientMethods) },
  S3: jest.fn(() => ({ upload: jest.fn(), getObject: jest.fn(), deleteObject: jest.fn() })),
}));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { getEventsByEmailDomainAndLeadEmail: jest.fn(), updateEmailEventContent: jest.fn() } }));
jest.mock('../services/resendService', () => ({ resendService: { getReceivedEmailContent: jest.fn(), getDeliveredEmailContent: jest.fn() } }));
jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn().mockResolvedValue({ event: {}, deduplicated: false }) },
  normalizeContactId: (raw: string) => raw.trim().toLowerCase(),
}));

import { getLeadCallStore, setLeadCallStoreForTests } from '../services/voice/leadCallStore';

type UpdateCall = {
  Key: Record<string, string>;
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
};
const lastUpdate = (): UpdateCall => mockDocumentClientMethods.update.mock.calls[0][0];
/** Document paths named by the SET and REMOVE actions (what DynamoDB refuses to see twice). */
const touchedPaths = (call: UpdateCall): string[] => {
  const [setPart, removePart = ''] = call.UpdateExpression.replace(/^SET /, '').split(' REMOVE ');
  const targets = setPart.split(/, (?=[#\w.]+ = )/).map((a) => a.split(' = ')[0].trim());
  return [...targets, ...removePart.split(', ').filter(Boolean)].map((p) => p.replace(/#\w+/g, (n) => call.ExpressionAttributeNames[n] ?? n));
};
const placeholdersMatch = (call: UpdateCall) => {
  const text = `${call.UpdateExpression} ${call.ConditionExpression}`;
  expect(new Set(text.match(/#[A-Za-z]\w*/g))).toEqual(new Set(Object.keys(call.ExpressionAttributeNames)));
  expect(new Set(text.match(/:[A-Za-z]\w*/g))).toEqual(new Set(Object.keys(call.ExpressionAttributeValues)));
};

beforeEach(() => {
  jest.clearAllMocks();
  setLeadCallStoreForTests(null);
  Object.values(mockDocumentClientMethods).forEach((m) => m.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }));
});

describe('LeadCallStore.claimRetry', () => {
  it('writes the claim only on a finished lead_deferred record of that call while no claim is there', async () => {
    expect(await getLeadCallStore().claimRetry('list-a', 'lead-a', 'job-1', 'tok')).toBe(true);
    const call = lastUpdate();
    expect(call.Key).toEqual({ listId: 'list-a', leadId: 'lead-a' });
    expect(call.UpdateExpression).toBe('SET updatedAt = :ts, #system.#k.#f0 = :v0, #system.#k.#f1 = :v1');
    expect(call.ConditionExpression).toBe(
      '#system.#k.#state IN (:from0) AND #system.#k.#f2 = :v2 AND #system.#k.#f3 = :v3 AND attribute_not_exists(#system.#k.#f4)',
    );
    expect(call.ExpressionAttributeNames).toEqual({
      '#system': 'system', '#k': 'hot_lead_call', '#state': 'state',
      '#f0': 'retryClaimToken', '#f1': 'retryClaimedAt', '#f2': 'jobKey', '#f3': 'outcome', '#f4': 'retryClaimToken',
    });
    expect(call.ExpressionAttributeValues).toMatchObject({ ':from0': 'finished', ':v0': 'tok', ':v2': 'job-1', ':v3': 'lead_deferred' });
    placeholdersMatch(call);
  });

  it('reports a lost claim as false (the conditional check failed)', async () => {
    mockDocumentClientMethods.update.mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' })) });
    expect(await getLeadCallStore().claimRetry('list-a', 'lead-a', 'job-1', 'tok')).toBe(false);
  });
});

describe('LeadCallStore.rescheduleRetry', () => {
  it('replaces the deferral only while the retry is unclaimed', async () => {
    await getLeadCallStore().rescheduleRetry('list-a', 'lead-a', 'job-1', { dueAt: '2026-10-20T17:00:00.000Z' });
    const call = lastUpdate();
    expect(call.UpdateExpression).toBe('SET updatedAt = :ts, #system.#k.#f0 = :v0');
    expect(call.ConditionExpression).toBe(
      '#system.#k.#state IN (:from0) AND #system.#k.#f1 = :v1 AND #system.#k.#f2 = :v2 AND attribute_not_exists(#system.#k.#f3)',
    );
    expect(call.ExpressionAttributeNames).toMatchObject({ '#f0': 'deferral', '#f3': 'retryClaimToken' });
    expect(call.ExpressionAttributeValues[':v0']).toEqual({ dueAt: '2026-10-20T17:00:00.000Z', count: 1 });
    placeholdersMatch(call);
    mockDocumentClientMethods.update.mockClear();
    await getLeadCallStore().rescheduleRetry('list-a', 'lead-a', 'job-1', { dueAt: '2026-10-20T17:00:00.000Z', firstDueAt: '2026-10-19T18:00:00.000Z' });
    expect(lastUpdate().ExpressionAttributeValues[':v0']).toEqual({ dueAt: '2026-10-20T17:00:00.000Z', count: 1, firstDueAt: '2026-10-19T18:00:00.000Z' });
  });
});

describe('LeadCallStore.releaseRetryClaim', () => {
  it('gives the claim back only to the token that holds it: REMOVE the two claim fields, SET the deferral whole, never one path twice', async () => {
    await getLeadCallStore().releaseRetryClaim('list-a', 'lead-a', 'tok', { dueAt: '2026-10-19T18:15:00.000Z', firstDueAt: '2026-10-19T18:00:00.000Z' });
    const call = lastUpdate();
    expect(call.UpdateExpression).toBe('SET updatedAt = :ts, #system.#k.#f0 = :v0 REMOVE #system.#k.#f1, #system.#k.#f2');
    expect(call.ConditionExpression).toBe('#system.#k.#state IN (:from0) AND #system.#k.#f3 = :v3 AND #system.#k.#f4 = :v4');
    expect(call.ExpressionAttributeNames).toMatchObject({ '#f0': 'deferral', '#f1': 'retryClaimToken', '#f2': 'retryClaimedAt', '#f3': 'retryClaimToken', '#f4': 'outcome' });
    expect(call.ExpressionAttributeValues).toMatchObject({ ':from0': 'finished', ':v3': 'tok', ':v4': 'lead_deferred' });
    expect(call.ExpressionAttributeValues[':v0']).toEqual({ dueAt: '2026-10-19T18:15:00.000Z', count: 1, firstDueAt: '2026-10-19T18:00:00.000Z' });
    const paths = touchedPaths(call);
    expect(new Set(paths).size).toBe(paths.length);
    placeholdersMatch(call);
  });
});

describe('LeadCallStore.restartForRetry', () => {
  const fresh = { jobKey: 'job-2', startedAt: '2026-10-19T18:00:00.000Z', memberId: 'mem-1', claimToken: 'claim-2', leadPhoneMac: 'mac-1' };

  it('revives only the finished record that holds this claim: one SET (empty map and list values included) and one REMOVE', async () => {
    expect(await getLeadCallStore().restartForRetry('list-a', 'lead-a', { jobKey: 'job-1', token: 'tok' }, fresh)).toBe(true);
    const call = lastUpdate();
    expect(call.ConditionExpression).toBe('#system.#k.#state IN (:from0) AND #system.#k.#f14 = :v14 AND #system.#k.#f15 = :v15');
    expect(call.ExpressionAttributeValues).toMatchObject({ ':from0': 'finished', ':v14': 'job-1', ':v15': 'tok' });
    const values = Object.values(call.ExpressionAttributeValues);
    expect(values).toEqual(expect.arrayContaining([{}, [], ['mem-1'], 'dialing', 1, 'job-2', 'claim-2', 'mac-1']));
    expect(call.UpdateExpression).toMatch(/ REMOVE #system\.#k\.#f11, #system\.#k\.#f12, #system\.#k\.#f13$/);
    expect(['memberCallSid', 'leadCallSid', 'outcome'].map((n) => Object.values(call.ExpressionAttributeNames).includes(n))).toEqual([true, true, true]);
    placeholdersMatch(call);
  });

  it('touches no document path twice (DynamoDB rejects overlapping SET/REMOVE paths), and sets no path nested under another', async () => {
    await getLeadCallStore().restartForRetry('list-a', 'lead-a', { jobKey: 'job-1', token: 'tok' }, fresh);
    const paths = touchedPaths(lastUpdate());
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(expect.arrayContaining([
      'system.hot_lead_call.state', 'system.hot_lead_call.lastSequence', 'system.hot_lead_call.meteredLegs', 'system.hot_lead_call.triedMemberIds',
      'system.hot_lead_call.memberCallSid', 'system.hot_lead_call.leadCallSid', 'system.hot_lead_call.outcome',
    ]));
    for (const a of paths) for (const b of paths) if (a !== b) expect(b.startsWith(`${a}.`)).toBe(false);
    // lastSequence and meteredLegs are replaced whole, never entry by entry.
    expect(paths.filter((p) => p.startsWith('system.hot_lead_call.lastSequence'))).toEqual(['system.hot_lead_call.lastSequence']);
  });
});
