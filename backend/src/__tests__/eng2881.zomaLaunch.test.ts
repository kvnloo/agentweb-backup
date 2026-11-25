/**
 * ENG-2881 launch wiring: Slack approval ping, admin Invite/Reject as the admission decision,
 * and the capacity counter never surfacing as (or being edited like) an applicant.
 */
const rows = new Map<string, any>();
const conditional = () => Object.assign(new Error('condition'), { code: 'ConditionalCheckFailedException' });
const mockGet = jest.fn((p: any) => ({ promise: async () => ({ Item: rows.get(p.Key.email) }) }));
const mockUpdate = jest.fn((p: any) => ({ promise: async () => {
  const old = rows.get(p.Key.email) ?? {};
  const v = p.ExpressionAttributeValues ?? {};
  if (p.ConditionExpression === 'attribute_not_exists(zomaStatus)') {
    if (old.zomaStatus) throw conditional();
    rows.set(p.Key.email, { email: p.Key.email, ...old, zomaStatus: v[':pending'] });
    return;
  }
  if (p.ConditionExpression === 'zomaStatus = :pending') {
    if (old.zomaStatus !== 'waitlisted') throw conditional();
    rows.set(p.Key.email, { ...old, zomaStatus: v[':rejected'], rejectedBy: v[':actor'] });
    return;
  }
  // legacy CRUD (updateDetails / updateStatus): record the SET attribute names
  const names = p.ExpressionAttributeNames ?? {};
  const next = { ...old };
  for (const [k, name] of Object.entries(names)) next[name as string] = v[(k as string).replace('#', ':')];
  rows.set(p.Key.email, next);
  return { Attributes: next };
} }));
const mockTransact = jest.fn((p: any) => ({ promise: async () => {
  const [counter, admission] = p.TransactItems.map((x: any) => x.Update);
  const count = rows.get(counter.Key.email);
  const old = rows.get(admission.Key.email) ?? {};
  if (count.approvedCount >= counter.ExpressionAttributeValues[':cap'] || (admission.ExpressionAttributeValues[':pending'] ? old.zomaStatus !== 'waitlisted' : !!old.zomaStatus)) {
    throw Object.assign(new Error('condition'), { code: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  }
  rows.set(counter.Key.email, { email: counter.Key.email, approvedCount: count.approvedCount + 1 });
  rows.set(admission.Key.email, { ...old, email: admission.Key.email, zomaStatus: 'approved', approvedBy: admission.ExpressionAttributeValues[':actor'] });
} }));
const mockScan = jest.fn(() => ({ promise: async () => ({ Items: [...rows.values()] }) }));
jest.mock('aws-sdk', () => ({ __esModule: true, default: { config: { update: jest.fn() }, DynamoDB: { DocumentClient: jest.fn(() => ({ get: mockGet, update: mockUpdate, transactWrite: mockTransact, scan: mockScan })) } } }));

import { waitlistDb } from '../services/waitlistDb';
import { admitZoma, admitZomaSignup, applyZomaWaitlistDecision, setZomaWaitlistSlackPoster } from '../services/zomaAdmission';

const posts: Array<{ channel: string; text: string }> = [];
const flush = () => new Promise((r) => setImmediate(r));
beforeEach(() => {
  rows.clear();
  posts.length = 0;
  rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 0 });
  process.env.ZOMA_WAITLIST_ENABLED = 'true';
  process.env.ZOMA_FREE_USER_CAP = '60';
  delete process.env.ZOMA_WAITLIST_SLACK_CHANNEL;
  setZomaWaitlistSlackPoster(async (channel, text) => { posts.push({ channel, text }); });
});
afterAll(() => { delete process.env.ZOMA_WAITLIST_ENABLED; delete process.env.ZOMA_FREE_USER_CAP; });

describe('approval ping', () => {
  it('pings the approval channel once, tagging Harsha, Matt and Fangfang, when a signup is waitlisted', async () => {
    rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 60 });
    expect(await admitZoma('late@company.co')).toBe('waitlisted');
    expect(await admitZoma('late@company.co')).toBe('waitlisted'); // retry
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe('C0CGETQP27Q');
    for (const id of ['U08TM4QFQ1L', 'U08TWRHKCG4', 'U08TWRKGESG']) expect(posts[0].text).toContain(`<@${id}>`);
    expect(posts[0].text).toContain('late@company.co');
    expect(posts[0].text).toContain('60/60');
  });

  it('does not ping for an admitted signup', async () => {
    expect(await admitZoma('early@company.co')).toBe('approved');
    await flush();
    expect(posts).toHaveLength(0);
  });

  it('a Slack outage never fails or changes the admission result', async () => {
    rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 60 });
    setZomaWaitlistSlackPoster(async () => { throw new Error('not_in_channel'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await admitZoma('late@company.co')).toBe('waitlisted');
    await flush();
    expect(rows.get('late@company.co').zomaStatus).toBe('waitlisted');
    spy.mockRestore();
  });
});

describe('admin Invite/Reject is the admission decision', () => {
  it('Invite on a waitlisted applicant reserves a seat before the legacy invitation proceeds', async () => {
    rows.set('w@company.co', { email: 'w@company.co', zomaStatus: 'waitlisted' });
    expect(await applyZomaWaitlistDecision(rows.get('w@company.co'), 'w@company.co', 'invited', 'admin-1')).toBeNull();
    expect(rows.get('w@company.co')).toEqual(expect.objectContaining({ zomaStatus: 'approved', approvedBy: 'admin-1' }));
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(1);
  });

  it('Invite when all seats are taken is refused (409) and nothing is reserved', async () => {
    rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 60 });
    rows.set('w@company.co', { email: 'w@company.co', zomaStatus: 'waitlisted' });
    const refusal = await applyZomaWaitlistDecision(rows.get('w@company.co'), 'w@company.co', 'invited', 'admin-1');
    expect(refusal).toEqual({ statusCode: 409, body: expect.objectContaining({ zomaStatus: 'capacity_exhausted' }) });
    expect(rows.get('w@company.co').zomaStatus).toBe('waitlisted');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(60);
  });

  it('Invite on a waitlist-form applicant (no decision yet) reserves a seat under the cap', async () => {
    rows.set('form@company.co', { email: 'form@company.co', status: 'pending' });
    expect(await applyZomaWaitlistDecision(rows.get('form@company.co'), 'form@company.co', 'invited', 'admin-1')).toBeNull();
    expect(rows.get('form@company.co').zomaStatus).toBe('approved');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(1);
  });

  it('Invite on a rejected applicant and Reject on an approved one are both refused', async () => {
    rows.set('r@company.co', { email: 'r@company.co', zomaStatus: 'rejected' });
    rows.set('a@company.co', { email: 'a@company.co', zomaStatus: 'approved' });
    expect((await applyZomaWaitlistDecision(rows.get('r@company.co'), 'r@company.co', 'invited', 'admin-1'))?.statusCode).toBe(409);
    expect((await applyZomaWaitlistDecision(rows.get('a@company.co'), 'a@company.co', 'rejected', 'admin-1'))?.statusCode).toBe(409);
    expect(rows.get('a@company.co').zomaStatus).toBe('approved');
  });

  it('Reject records the admin decision; an unauthenticated actor is refused', async () => {
    rows.set('w@company.co', { email: 'w@company.co', zomaStatus: 'waitlisted' });
    expect((await applyZomaWaitlistDecision(rows.get('w@company.co'), 'w@company.co', 'invited', undefined))?.statusCode).toBe(403);
    expect(await applyZomaWaitlistDecision(rows.get('w@company.co'), 'w@company.co', 'rejected', 'admin-1')).toBeNull();
    expect(rows.get('w@company.co')).toEqual(expect.objectContaining({ zomaStatus: 'rejected', rejectedBy: 'admin-1' }));
  });

  it('is a no-op while the gate is dark', async () => {
    delete process.env.ZOMA_WAITLIST_ENABLED;
    rows.set('w@company.co', { email: 'w@company.co', zomaStatus: 'waitlisted' });
    expect(await applyZomaWaitlistDecision(rows.get('w@company.co'), 'w@company.co', 'invited', 'admin-1')).toBeNull();
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(0);
  });
});

describe('signups that are not a new free seat', () => {
  const noInvite = { hasPendingOrgInvite: async () => false };
  beforeEach(() => rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 60 }));

  it('a teammate joining an org that invited them is admitted when full and takes no seat', async () => {
    expect(await admitZomaSignup('mate@customer.co', { hasPendingOrgInvite: async () => true })).toBe('approved');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(60);
    expect(rows.has('mate@customer.co')).toBe(false);
  });

  it('an applicant invited before the gate was enabled is admitted without a seat', async () => {
    rows.set('pre@company.co', { email: 'pre@company.co', status: 'invited' });
    expect(await admitZomaSignup('pre@company.co', noInvite)).toBe('approved');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(60);
  });

  it('our own team domain never consumes a seat', async () => {
    expect(await admitZomaSignup('someone@agentweb.pro', noInvite)).toBe('approved');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(60);
  });

  it('everyone else still hits the cap, and a failed org lookup is not an exemption', async () => {
    expect(await admitZomaSignup('late@company.co', noInvite)).toBe('waitlisted');
    expect(await admitZomaSignup('late2@company.co', { hasPendingOrgInvite: async () => { throw new Error('ddb'); } })).toBe('waitlisted');
  });

  it('Reject on a waitlist-form applicant blocks a later self-signup even with seats free', async () => {
    rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 0 });
    rows.set('form@company.co', { email: 'form@company.co', status: 'pending' });
    expect(await applyZomaWaitlistDecision(rows.get('form@company.co'), 'form@company.co', 'rejected', 'admin-1')).toBeNull();
    expect(await admitZomaSignup('form@company.co', noInvite)).toBe('rejected');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(0);
  });
});

describe('Databricks-origin signup is not a free seat (ENG-2781)', () => {
  const noInvite = { hasPendingOrgInvite: async () => false };
  beforeEach(() => rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 60 }));

  it('is admitted when the free seats are full, takes no seat and leaves no waitlist row', async () => {
    expect(await admitZomaSignup('buyer@customer.co', noInvite, { databricks: true })).toBe('approved');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(60);
    expect(rows.has('buyer@customer.co')).toBe(false);
    expect(posts).toEqual([]);
  });

  it('is admitted the same way before the seats are full, without consuming one', async () => {
    rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 3 });
    expect(await admitZomaSignup('buyer@customer.co', noInvite, { databricks: true })).toBe('approved');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(3);
    expect(rows.has('buyer@customer.co')).toBe(false);
  });

  it('exempts the signup without touching the org-invite lookup', async () => {
    const lookup = jest.fn(async () => false);
    expect(await admitZomaSignup('buyer@customer.co', { hasPendingOrgInvite: lookup }, { databricks: true })).toBe('approved');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is decided per signup: the same email through a non-Databricks path is still waitlisted', async () => {
    expect(await admitZomaSignup('buyer@customer.co', noInvite, { databricks: true })).toBe('approved');
    expect(await admitZomaSignup('buyer@customer.co', noInvite)).toBe('waitlisted');
    expect(rows.get('buyer@customer.co')).toEqual(expect.objectContaining({ zomaStatus: 'waitlisted' }));
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(60);
  });

  it.each([[undefined], [{}], [{ databricks: false }], [{ databricks: undefined }]])('an origin of %p is still capped like any other signup', async (origin) => {
    expect(await admitZomaSignup('late@company.co', noInvite, origin)).toBe('waitlisted');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(60);
  });

  it('a signup that is not Databricks-origin still consumes a seat while seats are free', async () => {
    rows.set('__zoma_free_capacity__', { email: '__zoma_free_capacity__', approvedCount: 3 });
    expect(await admitZomaSignup('early@company.co', noInvite, {})).toBe('approved');
    expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(4);
  });

  it('logs the bypass without the email address', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await admitZomaSignup('buyer@customer.co', noInvite, { databricks: true });
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('Databricks');
      expect(JSON.stringify(log.mock.calls)).not.toContain('buyer@customer.co');
      log.mockClear();
      await admitZomaSignup('late@company.co', noInvite);
      await admitZomaSignup('someone@agentweb.pro', noInvite);
      await admitZomaSignup('mate@customer.co', { hasPendingOrgInvite: async () => true });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe('capacity counter and decision fields stay out of waitlist CRUD', () => {
  it('the admin waitlist list never shows the counter row', async () => {
    rows.set('w@company.co', { email: 'w@company.co', zomaStatus: 'waitlisted' });
    const { items } = await waitlistDb.list();
    expect(items.map((i: any) => i.email)).toEqual(['w@company.co']);
  });

  it('updateDetails cannot set an admission decision', async () => {
    rows.set('w@company.co', { email: 'w@company.co', zomaStatus: 'waitlisted', joinedAt: 'x' });
    await waitlistDb.updateDetails('w@company.co', { zomaStatus: 'approved', approvedBy: 'me', fullName: 'W' } as any);
    expect(rows.get('w@company.co').zomaStatus).toBe('waitlisted');
    expect(rows.get('w@company.co').approvedBy).toBeUndefined();
    expect(rows.get('w@company.co').fullName).toBe('W');
  });
});
