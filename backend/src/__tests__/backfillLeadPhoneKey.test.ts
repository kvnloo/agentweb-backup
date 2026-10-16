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
    ['a synthetic smoke-test number', { phone: '(415) 555-0142' }, 'not-dedupable'],
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

/**
 * A DynamoDB stand-in that actually EVALUATES the ConditionExpression and applies SET/REMOVE, and throws on
 * any condition syntax it does not understand, so a script bug in the expressions cannot pass vacuously
 * (an earlier version required nameCompanyKey to be absent and silently skipped every such lead).
 */
function splitTop(expr: string, sep: string): string[] {
  const out: string[] = []; let depth = 0; let last = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') depth--;
    else if (depth === 0 && expr.startsWith(sep, i)) { out.push(expr.slice(last, i)); i += sep.length - 1; last = i + 1; }
  }
  out.push(expr.slice(last));
  return out;
}
function evalCond(expr: string, item: any, vals: any): boolean {
  expr = expr.trim();
  const ands = splitTop(expr, ' AND ');
  if (ands.length > 1) return ands.every((p) => evalCond(p, item, vals));
  const ors = splitTop(expr, ' OR ');
  if (ors.length > 1) return ors.some((p) => evalCond(p, item, vals));
  if (expr.startsWith('(') && expr.endsWith(')')) return evalCond(expr.slice(1, -1), item, vals);
  let m = expr.match(/^attribute_not_exists\((\w+)\)$/);
  if (m) return !(m[1] in item);
  m = expr.match(/^(\w+) = (:\w+)$/);
  if (m) { if (!(m[2] in vals)) throw new Error(`condition references undefined value ${m[2]}`); return item[m[1]] === vals[m[2]]; }
  throw new Error(`fake DynamoDB: unsupported condition "${expr}"`);
}

describe('runPhoneKeyBackfill', () => {
  const rows = () => [
    { listId: 'L1', leadId: 'a', phone: '(212) 456-7890' },
    { listId: 'L1', leadId: 'b', phone: '(212) 456-7891', email: '' },
    { listId: 'L2', leadId: 'c', phone: '(303) 456-7890' },
    { listId: 'L2', leadId: 'd', phone: '1234567890' },
    { listId: 'L2', leadId: 'e', phone: '(212) 456-7890', email: 'x@y.com' },
    { listId: 'L2', leadId: 'f', phone: '(212) 456-7899', phoneKey: '2124567899' },
    // a normal captured lead: createLead stores a REAL nameCompanyKey for first+last+company
    { listId: 'L3', leadId: 'g', phone: '(404) 456-7890', firstName: 'Ana', nameCompanyKey: 'ana|lee|acme' },
    // legacy rows holding "" for every empty-string-hazard attribute
    { listId: 'L3', leadId: 'h', phone: '(404) 456-7891', email: '', linkedin: '', nameCompanyKey: '' },
    { listId: 'L3', leadId: 'i', phone: '(415) 555-0142' }, // synthetic smoke number
  ];
  const fake = (over: { failOn?: Record<string, any>; mutate?: Record<string, (item: any) => void> } = {}) => {
    const store = new Map<string, any>(rows().map((r) => [`${r.listId}|${r.leadId}`, { ...r }]));
    const scans: any[] = [];
    const updates: any[] = [];
    const ddb = {
      scan: jest.fn((p: any) => ({ promise: async () => {
        scans.push(p);
        const all = [...store.values()].filter((r) => !p.FilterExpression || r.listId === p.ExpressionAttributeValues[':l']).map((r) => ({ ...r }));
        return p.ExclusiveStartKey ? { Items: all.slice(3) } : { Items: all.slice(0, 3), LastEvaluatedKey: { listId: 'L1', leadId: 'c' } };
      } })),
      update: jest.fn((p: any) => ({ promise: async () => {
        updates.push(p);
        const err = over.failOn?.[p.Key.leadId];
        if (err) throw err;
        const item = store.get(`${p.Key.listId}|${p.Key.leadId}`);
        over.mutate?.[p.Key.leadId]?.(item); // a concurrent edit between the scan and the write
        if (!evalCond(p.ConditionExpression, item, p.ExpressionAttributeValues)) {
          throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
        }
        const m = String(p.UpdateExpression).match(/^SET phoneKey = :k(?: REMOVE (.+))?$/);
        if (!m) throw new Error(`fake DynamoDB: unsupported update "${p.UpdateExpression}"`);
        item.phoneKey = p.ExpressionAttributeValues[':k'];
        for (const a of (m[1] ? m[1].split(',').map((x: string) => x.trim()) : [])) delete item[a];
        return {};
      } })),
    };
    return { ddb, scans, updates, store };
  };
  const sleep = jest.fn(async () => undefined);
  const base = { tableName: 'AW-Leads', rate: 20, sleep };
  beforeEach(() => sleep.mockClear());

  it('DRY RUN by default: counts everything, writes nothing', async () => {
    const { ddb, updates } = fake();
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: false });
    expect(updates).toHaveLength(0);
    expect(s).toMatchObject({ scanned: 9, eligible: 5, written: 0, errors: 0 });
    expect(s.skipped).toMatchObject({ 'not-dedupable': 2, 'has-email': 1, 'has-key': 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('follows pagination across scan pages', async () => {
    const { ddb, scans } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: false });
    expect(scans).toHaveLength(2);
    expect(scans[1].ExclusiveStartKey).toEqual({ listId: 'L1', leadId: 'c' });
  });

  it('pauses between scan pages when pageDelayMs is set (and not after the last page)', async () => {
    const { ddb, scans } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: false, pageDelayMs: 250 });
    expect(scans).toHaveLength(2);
    expect(sleep.mock.calls).toEqual([[250]]);
  });

  it('APPLY writes every eligible row for real - INCLUDING a lead with a real nameCompanyKey (the earlier bug)', async () => {
    const { ddb, store } = fake();
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    expect(s).toMatchObject({ eligible: 5, written: 5, raced: 0, errors: 0 });
    expect(store.get('L3|g').phoneKey).toBe('4044567890');
    expect(store.get('L3|g').nameCompanyKey).toBe('ana|lee|acme'); // untouched
    expect(store.get('L1|a').phoneKey).toBe('2124567890');
    expect(store.get('L2|c').phoneKey).toBe('3034567890');
  });

  it('APPLY: legacy "" email/linkedin/nameCompanyKey are REMOVEd in the same write', async () => {
    const { ddb, store } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    const h = store.get('L3|h');
    expect(h.phoneKey).toBe('4044567891');
    expect('email' in h || 'linkedin' in h || 'nameCompanyKey' in h).toBe(false);
    expect('email' in store.get('L1|b')).toBe(false);
  });

  it('APPLY: sets phoneKey ONLY - never updatedAt - and is guarded by the observed phone', async () => {
    const { ddb, updates } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    const a = updates.find((u) => u.Key.leadId === 'a');
    expect(a.UpdateExpression).toBe('SET phoneKey = :k');
    expect(a.ConditionExpression).toContain('phone = :p');
    for (const u of updates) expect(JSON.stringify(u)).not.toContain('updatedAt');
  });

  it('APPLY: never writes a skipped row (junk, has email, already keyed, smoke number)', async () => {
    const { ddb, updates } = fake();
    await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    expect(updates.map((u) => u.Key.leadId).sort()).toEqual(['a', 'b', 'c', 'g', 'h']);
  });

  it.each([
    ['the phone was edited after the scan', (i: any) => { i.phone = '(212) 999-0000'; }, undefined],
    ['an email was added after the scan', (i: any) => { i.email = 'ana@example.com'; }, undefined],
    ['a linkedin url was added after the scan', (i: any) => { i.linkedin = 'https://www.linkedin.com/in/ana'; }, undefined],
    ['another run already keyed it', (i: any) => { i.phoneKey = 'KEYED-BY-OTHER'; }, 'KEYED-BY-OTHER'],
  ])('APPLY: a row where %s is left alone and counted as raced', async (_n, edit, expectedKey) => {
    const { ddb, store } = fake({ mutate: { a: edit } });
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: true });
    expect(s).toMatchObject({ raced: 1, written: 4, errors: 0 });
    expect(store.get('L1|a').phoneKey).toBe(expectedKey); // never overwritten, never set on an edited row
  });

  it('APPLY: another failure is counted and the run continues', async () => {
    const { ddb } = fake({ failOn: { c: Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' }) } });
    const s = await runPhoneKeyBackfill(ddb, { ...base, apply: true, log: () => undefined });
    expect(s).toMatchObject({ errors: 1, written: 4 });
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
