/**
 * ENG-2123: the phoneKey backfill. Dry-run by default; conditional, paced, never touches updatedAt.
 */
import { decidePhoneKeyBackfill, runPhoneKeyBackfill } from '../scripts/backfill-lead-phone-key';

describe('decidePhoneKeyBackfill', () => {
  const row = (over: any = {}) => ({ listId: 'L1', leadId: 'l1', phone: '(212) 456-7890', ...over });

  it('writes the key for an email-less row with a specific number', () => {
    expect(decidePhoneKeyBackfill(row())).toEqual({ action: 'write', key: '2124567890', phone: '(212) 456-7890', removeEmpty: [] });
  });
  it.each([
    ['already keyed', { phoneKey: '2124567890' }, 'has-key'],
    ['has an email', { email: 'a@b.com' }, 'has-email'],
    ['has a linkedin url', { linkedin: 'https://www.linkedin.com/in/x' }, 'has-linkedin'],
    ['has sync metadata', { syncMetadata: { hubspot_contact_id: '9' } }, 'has-sync'],
    ['no phone', { phone: '' }, 'no-phone'],
    ['phone absent', { phone: undefined }, 'no-phone'],
    ['junk number', { phone: '1234567890' }, 'not-dedupable'],
    ['too short', { phone: '456-7890' }, 'not-dedupable'],
  ])('skips a row that is %s', (_n, over, reason) => {
    expect(decidePhoneKeyBackfill(row(over))).toEqual({ action: 'skip', reason });
  });
  it('empty sync metadata is not sync metadata', () => {
    expect(decidePhoneKeyBackfill(row({ syncMetadata: {} })).action).toBe('write');
  });
  it('flags legacy empty-string index-key attributes for removal', () => {
    expect(decidePhoneKeyBackfill(row({ email: '', linkedin: '', nameCompanyKey: '' }))).toMatchObject({ action: 'write', removeEmpty: ['email', 'linkedin', 'nameCompanyKey'] });
    expect(decidePhoneKeyBackfill(row({ email: '' }))).toMatchObject({ removeEmpty: ['email'] });
  });
});

describe('runPhoneKeyBackfill', () => {
  const items = [
    { listId: 'L1', leadId: 'a', phone: '(212) 456-7890' },
    { listId: 'L1', leadId: 'b', phone: '(212) 456-7891', email: '' },
    { listId: 'L2', leadId: 'c', phone: '(303) 456-7890' },
    { listId: 'L2', leadId: 'd', phone: '1234567890' },
    { listId: 'L2', leadId: 'e', phone: '(212) 456-7890', email: 'x@y.com' },
    { listId: 'L2', leadId: 'f', phone: '(212) 456-7899', phoneKey: '2124567899' },
  ];
  const fake = (over: { failOn?: Record<string, any> } = {}) => {
    const scans: any[] = [];
    const updates: any[] = [];
    const ddb = {
      scan: jest.fn((p: any) => ({ promise: async () => {
        scans.push(p);
        const page2 = !!p.ExclusiveStartKey;
        return page2 ? { Items: items.slice(3) } : { Items: items.slice(0, 3), LastEvaluatedKey: { listId: 'L1', leadId: 'c' } };
      } })),
      update: jest.fn((p: any) => ({ promise: async () => {
        updates.push(p);
        const err = over.failOn?.[p.Key.leadId];
        if (err) throw err;
        return {};
      } })),
    };
    return { ddb, scans, updates };
  };
  const sleep = jest.fn(async () => undefined);
  const base = { tableName: 'AW-Leads', rate: 20, sleep };

  it('DRY RUN by default: counts everything, writes nothing', async () => {
    const { ddb, updates } = fake();
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: false });
    expect(updates).toHaveLength(0);
    expect(s).toMatchObject({ scanned: 6, eligible: 3, written: 0, errors: 0 });
    expect(s.skipped).toMatchObject({ 'not-dedupable': 1, 'has-email': 1, 'has-key': 1 });
    expect(s.topLists).toEqual([{ listId: 'L1', eligible: 2 }, { listId: 'L2', eligible: 1 }]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('follows pagination across scan pages', async () => {
    const { ddb, scans } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: false });
    expect(scans).toHaveLength(2);
    expect(scans[1].ExclusiveStartKey).toEqual({ listId: 'L1', leadId: 'c' });
  });

  it('APPLY: a conditional SET phoneKey only - never updatedAt - guarded by the observed phone', async () => {
    const { ddb, updates } = fake();
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    expect(s.written).toBe(3);
    const a = updates.find((u) => u.Key.leadId === 'a');
    expect(a.UpdateExpression).toBe('SET phoneKey = :k');
    expect(a.ConditionExpression).toContain('attribute_not_exists(phoneKey)');
    expect(a.ConditionExpression).toContain('phone = :p');
    expect(a.ExpressionAttributeValues).toEqual({ ':k': '2124567890', ':p': '(212) 456-7890' });
    for (const u of updates) expect(JSON.stringify(u)).not.toContain('updatedAt');
  });

  it('APPLY: a legacy email:"" row also REMOVEs the empty attribute, and its condition allows exactly that', async () => {
    const { ddb, updates } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    const b = updates.find((u) => u.Key.leadId === 'b');
    expect(b.UpdateExpression).toBe('SET phoneKey = :k REMOVE email');
    expect(b.ConditionExpression).toContain('(attribute_not_exists(email) OR email = :empty)');
    expect(b.ExpressionAttributeValues[':empty']).toBe('');
  });

  it('APPLY: never writes a skipped row (junk number, has email, already keyed)', async () => {
    const { ddb, updates } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    expect(updates.map((u) => u.Key.leadId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('APPLY: a row edited since the scan (conditional failure) is counted as raced, not an error', async () => {
    const { ddb } = fake({ failOn: { a: Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' }) } });
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    expect(s).toMatchObject({ raced: 1, written: 2, errors: 0 });
  });

  it('APPLY: another failure is counted and the run continues', async () => {
    const { ddb } = fake({ failOn: { c: Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' }) } });
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: true, log: () => undefined });
    expect(s).toMatchObject({ errors: 1, written: 2 });
  });

  it('APPLY: paces its writes', async () => {
    const { ddb } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    expect(sleep).toHaveBeenCalledWith(50); // 1000 / 20 per second
  });

  it('--list narrows the scan to one list', async () => {
    const { ddb, scans } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: false, listId: 'L2' });
    expect(scans[0]).toMatchObject({ FilterExpression: 'listId = :l', ExpressionAttributeValues: { ':l': 'L2' } });
  });
});
