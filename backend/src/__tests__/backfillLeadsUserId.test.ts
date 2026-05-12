// Tests for the CRM-history Tier 0 backfill — drives the pure logic that the
// runtime script wraps around. The script wires DDB scan + per-item UpdateItem;
// these tests cover the transform decisions that determine WHAT gets written.

import {
  shouldBackfillLead,
  computeBackfillPayload,
} from '../scripts/backfillLeadsUserId';

describe('shouldBackfillLead', () => {
  it('returns true when the lead is missing userId entirely', () => {
    expect(shouldBackfillLead({ leadId: 'a' } as any)).toBe(true);
  });

  it('returns true when the lead has userId but lacks nameCompanyKey and could compute one', () => {
    expect(shouldBackfillLead({
      leadId: 'a',
      userId: 'u',
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme',
    } as any)).toBe(true);
  });

  it('returns false when the lead has userId and either nameCompanyKey or no derivable key', () => {
    expect(shouldBackfillLead({
      leadId: 'a',
      userId: 'u',
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme',
      nameCompanyKey: 'jane|doe|acme',
    } as any)).toBe(false);

    expect(shouldBackfillLead({
      leadId: 'a',
      userId: 'u',
      // no first/last/company set → can't compute key, nothing to backfill
    } as any)).toBe(false);
  });
});

describe('computeBackfillPayload', () => {
  const listsByListId = new Map<string, { listId: string; userId: string }>([
    ['list-1', { listId: 'list-1', userId: 'user-42' }],
  ]);

  it('derives userId from the parent list when lead has none', () => {
    const out = computeBackfillPayload(
      { leadId: 'a', listId: 'list-1' } as any,
      listsByListId,
    );
    expect(out.attributesToWrite.userId).toBe('user-42');
  });

  it('computes nameCompanyKey when firstName + lastName + company are all set', () => {
    const out = computeBackfillPayload(
      { leadId: 'a', listId: 'list-1', firstName: 'Jane', lastName: 'Doe', company: 'Acme' } as any,
      listsByListId,
    );
    expect(out.attributesToWrite.nameCompanyKey).toBe('jane|doe|acme');
  });

  it('omits nameCompanyKey when any of firstName/lastName/company is missing', () => {
    const out = computeBackfillPayload(
      { leadId: 'a', listId: 'list-1', firstName: 'Jane', lastName: 'Doe' } as any,
      listsByListId,
    );
    expect(out.attributesToWrite.nameCompanyKey).toBeUndefined();
  });

  it('does not overwrite an existing userId', () => {
    const out = computeBackfillPayload(
      { leadId: 'a', listId: 'list-1', userId: 'user-already-set' } as any,
      listsByListId,
    );
    expect(out.attributesToWrite.userId).toBeUndefined();
  });

  it('marks the lead as orphaned when its parent list is missing', () => {
    const out = computeBackfillPayload(
      { leadId: 'a', listId: 'list-deleted' } as any,
      listsByListId,
    );
    expect(out.orphaned).toBe(true);
    expect(out.attributesToWrite.userId).toBeUndefined();
  });

  it('returns isNoop=true when nothing needs writing', () => {
    const out = computeBackfillPayload(
      {
        leadId: 'a', listId: 'list-1', userId: 'user-42',
        firstName: 'Jane', lastName: 'Doe', company: 'Acme', nameCompanyKey: 'jane|doe|acme',
      } as any,
      listsByListId,
    );
    expect(out.isNoop).toBe(true);
  });
});
